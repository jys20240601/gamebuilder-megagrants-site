/*
 * MyPlanner mobile (anewbyeol.kr/schedule): the phone companion of OrcaCalendar.
 * A static page with no server and no secrets.
 * - Google Calendar is read with GET requests only (calendar.calendarlist.readonly + calendar.events.readonly).
 * - Notes are saved on this device first and, once connected, in the user's own Google Drive app-data folder
 *   (drive.appdata: a hidden folder that only this app's client can see), so every device shows the same notes.
 *   The PC app reads and writes the same file; keys this page does not know are kept as they are.
 * - Goals, projects and tasks (with daily "오늘" plans) work the same way in a second app-data file,
 *   my-calendar-workspace.json, merged with the same rules as notes.
 * - With drive.file (only files this app made) a read-only copy of the notes is kept as a Google Doc in the
 *   "MyPlanner" folder. It is one-way and best effort: it never blocks or fails note sync.
 * - The access token lives in memory only. The OAuth web client ID is public by design.
 * - All text from Google or from notes is inserted with textContent, never as HTML. The Doc copy is built as
 *   escaped HTML text that only Drive reads.
 */
'use strict';
(() => {
  // Web OAuth client ID ("....apps.googleusercontent.com"). Empty: notes stay on this device until one is set
  // here or in Settings (the Settings value is kept on that device only).
  const DEFAULT_CLIENT_ID = '286652120884-rhes1oo3f3itereav32v6n0bg27hmg4r.apps.googleusercontent.com';

  const SCOPE_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';
  const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.appdata';
  const SCOPE_FILE = 'https://www.googleapis.com/auth/drive.file';
  const CAL = 'https://www.googleapis.com/calendar/v3';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const NOTES_FILE = 'my-calendar-notes.json';
  const COPY_FOLDER = 'MyPlanner';
  const COPY_DOC = 'MyPlanner 메모';
  const COPY_FOOTER = '이 문서는 MyPlanner가 자동으로 만들어요. 여기서 고친 내용은 앱에 반영되지 않아요.';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const GDOC_MIME = 'application/vnd.google-apps.document';
  const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
  const ATTACH_HOSTS = ['drive.google.com', 'docs.google.com', 'sheets.google.com', 'slides.google.com', 'www.google.com', 'calendar.google.com'];
  const MAX_DESC = 2000, MAX_PLACE = 300, MAX_ATTACH = 10;
  const WS_FILE = 'my-calendar-workspace.json';
  const K = { notes: 'mc.notes.v1', events: 'mc.events.v1', prefs: 'mc.prefs.v1', ws: 'mc.ws.v1' };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // workspace vocabulary (shared with the PC app); [value, label] pairs
  const TASK_STATUS = ['inbox', 'next', 'scheduled', 'someday', 'waiting', 'done'];
  const TASK_LISTS = [['inbox', '수집함'], ['next', '다음'], ['waiting', '대기'], ['someday', '언젠가']];
  const TASK_SECTIONS = [['next', '다음'], ['scheduled', '예정'], ['inbox', '수집함'], ['waiting', '대기'], ['someday', '언젠가']];
  const HORIZONS = [['ultimate', '최종 목표'], ['five-year', '5년 목표'], ['one-year', '1년 목표']];
  const HORIZON_SEG = [['ultimate', '최종'], ['five-year', '5년'], ['one-year', '1년']];
  const GOAL_STATUS = [['active', '진행'], ['paused', '보류'], ['done', '달성']];
  const PROJECT_GROUPS = [['active', '진행중'], ['preparing', '준비중'], ['paused', '보류중'], ['done', '완료']];
  const PROJECT_SEG = [['preparing', '준비'], ['active', '진행'], ['paused', '보류'], ['done', '완료']];
  const CATEGORIES = [['work', '업무'], ['personal', '개인'], ['study', '학습']];
  const KIND_LABEL = { task: '할 일', goal: '목표', project: '프로젝트' };
  const KIND_OBJ = { task: '할 일을', goal: '목표를', project: '프로젝트를' };
  const ITEM_KEYS = ['id', 'kind', 'title', 'status', 'createdAt', 'updatedAt', 'deleted', 'horizon', 'desiredResult', 'dueDate',
    'category', 'parentId', 'projectId', 'plannedDate', 'completedAt'];
  const PLAN_KEYS = ['date', 'focus', 'updatedAt'];
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const DEADLINE_WORDS = ['마감', '기한', '제출', 'deadline', 'due']; // same rule as the desktop app
  const DAY = 86400000;
  const UPCOMING_DAYS = 14;
  const CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

  // ------------------------------------------------------------------ device storage
  const local = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* storage blocked */ }
    },
  };

  // ------------------------------------------------------------------ dates
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const pad = n => (n < 10 ? '0' : '') + n;
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseYmd = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const hm = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
  const md = d => (d.getMonth() + 1) + '/' + d.getDate();
  const longDay = d => (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + WD[d.getDay()] + '요일';
  const shortDay = d => md(d) + ' ' + WD[d.getDay()];
  const chipDay = d => (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + WD[d.getDay()] + ')';
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
  const relTag = n => (n === 0 ? '오늘' : n === 1 ? '내일' : n === 2 ? '모레' : 'D-' + n);
  const gridStart = month => addDays(month, -month.getDay());
  const gridWeeks = month => Math.ceil((month.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);

  function ago(ms) {
    const diff = Date.now() - ms;
    if (diff < 60000) return '방금';
    if (diff < 3600000) return Math.floor(diff / 60000) + '분 전';
    const d = new Date(ms);
    if (sameDay(d, new Date())) return hm(d);
    if (sameDay(d, addDays(new Date(), -1))) return '어제';
    return md(d);
  }

  // ------------------------------------------------------------------ validation of stored / downloaded data
  function validNote(n) {
    return !!n && typeof n.id === 'string' && n.id.length > 0 && n.id.length <= 64 &&
      typeof n.title === 'string' && n.title.length <= 500 &&
      typeof n.body === 'string' && n.body.length <= 200000 &&
      (n.date == null || /^\d{4}-\d{2}-\d{2}$/.test(n.date)) &&
      Number.isFinite(n.createdAt) && Number.isFinite(n.updatedAt);
  }

  function validEvent(e) {
    return !!e && typeof e.k === 'string' && typeof e.t === 'string' && Number.isFinite(e.s) && Number.isFinite(e.e);
  }

  const hasContent = n => n.deleted || n.title.trim() !== '' || n.body.trim() !== '';
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const driveId = v => (typeof v === 'string' && DRIVE_ID_RE.test(v) ? v : null);
  const optDate = v => v == null || (typeof v === 'string' && DATE_RE.test(v));
  const optStr = (v, max) => v == null || (typeof v === 'string' && v.length <= max);

  // goals, projects and tasks; a deletion may drop everything but id and kind
  function validItem(it) {
    if (!isObj(it) || typeof it.id !== 'string' || !it.id || it.id.length > 64) return false;
    if (!['goal', 'project', 'task'].includes(it.kind) || !Number.isFinite(it.updatedAt)) return false;
    if (it.deleted) return true;
    return typeof it.title === 'string' && it.title.length <= 500 && typeof it.status === 'string' && it.status.length <= 40 &&
      Number.isFinite(it.createdAt) && optDate(it.dueDate) && optDate(it.plannedDate) && optStr(it.desiredResult, 20000) &&
      optStr(it.parentId, 64) && optStr(it.projectId, 64) && optStr(it.horizon, 40) && optStr(it.category, 40) &&
      (it.completedAt == null || Number.isFinite(it.completedAt));
  }

  function validPlan(p) {
    return isObj(p) && typeof p.date === 'string' && DATE_RE.test(p.date) && Number.isFinite(p.updatedAt) &&
      Array.isArray(p.focus) && p.focus.length <= 500 && p.focus.every(x => typeof x === 'string' && x.length <= 64);
  }

  // an item without a title is a draft that is neither kept on the device nor uploaded
  const keepItem = it => !!it.deleted || (typeof it.title === 'string' && it.title.trim() !== '');

  // ------------------------------------------------------------------ state
  const prefs = Object.assign({ clientId: '', connected: false }, local.get(K.prefs, {}));
  const today0 = startOfDay(new Date());
  const S = {
    tab: 'cal',
    now: new Date(),
    sel: today0,
    month: new Date(today0.getFullYear(), today0.getMonth(), 1),
    notes: (local.get(K.notes, []) || []).filter(validNote),
    events: [],
    eventsRange: null,
    token: null,
    tokenExp: 0,
    canCal: false,
    canDrive: false,
    canCopy: false, // drive.file: the Doc copy in "MyPlanner"
    sync: 'idle', // idle | busy | ok | error | reconnect
    syncMsg: '',
    lastSync: 0,
    fileId: null,
    remoteDoc: null, // the notes file as last downloaded or uploaded (unknown keys are written back unchanged)
    dirty: false,
    ws: { items: [], plans: [] }, // goals, projects, tasks + daily plans
    wsFileId: null,
    wsDoc: null, // the workspace file as last downloaded or uploaded (unknown keys are written back unchanged)
    wsDirty: false,
    goalSeg: 'goals', // goals | projects
    showDone: false,
    showDoneProjects: false,
    itemStack: [], // open item editors: [{ id, fresh, saved, focus }], nested ones on top
    prevStatus: {}, // list a task had before it was completed (this session only)
    query: '',
    editing: null,
    editingFresh: false,
    detail: null,
    confirmWipe: false,
  };
  {
    const saved = local.get(K.ws, null);
    S.ws.items = arr(saved && saved.items).filter(validItem);
    S.ws.plans = arr(saved && saved.plans).filter(validPlan);
  }
  if (prefs.connected) {
    const cached = local.get(K.events, null);
    if (cached && Array.isArray(cached.items)) S.events = cached.items.filter(validEvent);
  }

  const clientId = () => (prefs.clientId || DEFAULT_CLIENT_ID || '').trim();
  const savePrefs = () => local.set(K.prefs, prefs);
  const tokenValid = () => !!S.token && Date.now() < S.tokenExp;
  const noteById = id => S.notes.find(n => n.id === id);
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

  // ------------------------------------------------------------------ DOM helpers
  const $ = sel => document.querySelector(sel);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') for (const p of Object.keys(v)) el.style.setProperty(p, v[p]);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICON = {
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    plus: 'M12 5v14M5 12h14',
    note: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
    search: 'M11 4a7 7 0 1 1 0 14a7 7 0 0 1 0-14zM20 20l-4-4',
    cal: 'M5.5 5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 10h17M8 3v4M16 3v4',
    clock: 'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2',
    pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5z',
    clip: 'M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
    ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    check: 'M5.5 12.5l4 4 9-9.5',
    task: 'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17zM8.3 12.2l2.6 2.6 4.9-5.1',
    goal: 'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17zM12 7.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9zM12 12h.01',
  };
  function icon(name, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICON[name]);
    s.appendChild(p);
    return s;
  }

  let toastTimer = 0;
  // action: { label, run } adds one button (for example "되돌리기") and keeps the toast a little longer
  function toast(text, action) {
    const t = $('#toast');
    t.replaceChildren(h('span', { text }));
    if (action) {
      t.append(h('button', {
        type: 'button', class: 'toast-act', text: action.label,
        onclick: () => { clearTimeout(toastTimer); t.hidden = true; action.run(); },
      }));
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 5000 : 2800);
  }

  // ------------------------------------------------------------------ calendar data helpers
  function eventsOn(day) {
    const a = +startOfDay(day), b = +addDays(day, 1);
    return S.events
      .filter(e => (e.e > e.s ? e.s < b && e.e > a : e.s >= a && e.s < b))
      .sort((x, y) => (x.a === y.a ? x.s - y.s : x.a ? -1 : 1));
  }
  const liveNotes = () => S.notes.filter(n => !n.deleted && (n.title.trim() || n.body.trim()));
  const notesOn = day => liveNotes().filter(n => n.date === ymd(day)).sort((a, b) => a.createdAt - b.createdAt);
  const isDeadline = e => { const t = e.t.toLowerCase(); return DEADLINE_WORDS.some(w => t.includes(w)); };
  const noteTitle = n => n.title.trim() || n.body.trim().split('\n')[0] || '(제목 없음)';
  const haveCalendar = () => S.canCal || S.events.length > 0;

  function dayDots(day, max) {
    const seen = [];
    for (const e of eventsOn(day)) {
      if (seen.length >= max) break;
      seen.push(e.c);
    }
    if (seen.length < max && notesOn(day).length) seen.push('var(--note)');
    return seen;
  }

  function dots(colors, small) {
    return h('span', { class: small ? 'dots small' : 'dots' }, colors.map(c => h('span', { class: 'dot', style: { '--c': c } })));
  }

  // ------------------------------------------------------------------ rendering: calendar tab
  function render() {
    renderSync();
    if (S.tab === 'cal') renderCal();
    else if (S.tab === 'tasks') renderTasks();
    else if (S.tab === 'goals') renderGoals();
    else renderNotes();
  }

  function listHead(label, count, aside) {
    return h('div', { class: 'list-head' },
      h('span', { class: 'label', text: label }),
      count == null ? null : h('span', { class: 'count', text: String(count) }),
      aside ? h('span', { class: 'aside', text: aside }) : null);
  }

  function eventRow(e, lead, opts) {
    const now = Date.now();
    const past = opts.dimPast && e.e <= now && !e.a;
    const live = opts.live && !e.a && e.s <= now && now < e.e;
    let tag = null;
    if (live) tag = h('span', { class: 'tag live', text: '진행 중' });
    else if (opts.tag) tag = h('span', { class: 'tag' + (opts.warn ? ' warn' : ''), text: opts.tag });
    return h('button', { type: 'button', class: 'row' + (past ? ' past' : ''), onclick: () => openDetail(e) },
    h('span', { class: 'lead', text: lead }),
    h('span', { class: 'bar', style: { '--c': e.c } }),
    h('span', { class: 'title', text: e.t }),
    opts.meta ? h('span', { class: 'meta', text: opts.meta }) : null,
    tag);
  }

  function noteRow(n) {
    return h('button', { type: 'button', class: 'row', onclick: () => openEditor(n.id, false) },
      h('span', { class: 'lead', text: '메모' }),
      icon('note', 'note-ico'),
      h('span', { class: 'title', text: noteTitle(n) }),
      h('span', { class: 'meta', text: ago(n.updatedAt) }));
  }

  function renderCal() {
    const root = $('#view-cal');
    const today = startOfDay(S.now);
    const kids = [];

    const todays = eventsOn(today);
    kids.push(h('div', { class: 'now' },
      h('span', { class: 'clock', text: hm(S.now) }),
      h('span', { class: 'now-text' },
        h('span', { class: 'now-date', text: longDay(today) }),
        h('span', { class: 'now-sub', text: haveCalendar() ? '오늘 일정 ' + todays.length + '개' : '오늘 메모 ' + notesOn(today).length + '개' }))));

    const strip = h('div', { class: 'strip' });
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, i);
      const cls = ['day', d.getDay() === 0 ? 'sun' : '', d.getDay() === 6 ? 'sat' : '', i === 0 ? 'today' : '', sameDay(d, S.sel) ? 'sel' : ''].join(' ');
      strip.append(h('button', { type: 'button', class: cls, 'aria-label': longDay(d), onclick: () => selectDay(d) },
        h('span', { class: 'wd', text: i === 0 ? '오늘' : WD[d.getDay()] }),
        h('span', { class: 'dn', text: String(d.getDate()) }),
        dots(dayDots(d, 3), false)));
    }
    kids.push(strip);

    if (!S.canCal && !S.events.length) kids.push(connectCard());

    // the selected day: events, today's tasks (when it is today), its notes, then "write a note for this day"
    const sel = S.sel, isToday = sameDay(sel, today);
    const selEvents = eventsOn(sel), selNotes = notesOn(sel), selTasks = isToday ? todayTasks() : [];
    const aside = [selTasks.length ? '할 일 ' + selTasks.length : '', selNotes.length ? '메모 ' + selNotes.length : ''].filter(Boolean).join(' · ');
    const day = h('section', { class: 'list' }, listHead(isToday ? '오늘' : chipDay(sel), haveCalendar() ? selEvents.length : null, aside || null));
    for (const e of selEvents) {
      const lead = e.a ? '종일' : e.s < +startOfDay(sel) ? '계속' : hm(new Date(e.s));
      day.append(eventRow(e, lead, { dimPast: isToday, live: isToday }));
    }
    for (const t of selTasks.slice(0, 5)) day.append(calTaskRow(t));
    if (selTasks.length > 5) {
      day.append(h('button', { type: 'button', class: 'row more', onclick: () => setTab('tasks') },
        h('span', { class: 'lead' }), h('span', { class: 'title', text: '할 일 ' + (selTasks.length - 5) + '개 더 보기' })));
    }
    for (const n of selNotes) day.append(noteRow(n));
    if (!selEvents.length && !selNotes.length && !selTasks.length) day.append(h('div', { class: 'empty-row', text: haveCalendar() ? '일정과 메모가 없어요' : '이 날의 메모가 없어요' }));
    day.append(h('button', { type: 'button', class: 'row add', onclick: () => newNote(ymd(sel)) },
      h('span', { class: 'lead' }), icon('plus'), h('span', { class: 'title', text: '이 날짜에 메모 쓰기' })));
    kids.push(day);

    if (haveCalendar()) {
      const end = +addDays(today, UPCOMING_DAYS + 1);
      const upcomingAll = S.events.filter(e => e.s >= +today && e.s < end).sort((a, b) => a.s - b.s);
      const deadlines = upcomingAll.filter(isDeadline).slice(0, 5);
      const upcoming = upcomingAll.filter(e => !isDeadline(e) && e.s >= +addDays(today, 1)).slice(0, 8);
      if (deadlines.length) {
        const sec = h('section', { class: 'list' }, listHead('다가오는 마감', deadlines.length, UPCOMING_DAYS + '일 이내'));
        for (const e of deadlines) {
          const s = new Date(e.s);
          sec.append(eventRow(e, shortDay(s), { meta: e.a ? '' : hm(s), tag: relTag(daysBetween(today, s)), warn: true }));
        }
        kids.push(sec);
      }
      const sec = h('section', { class: 'list' }, listHead('다가오는 일정', upcoming.length, UPCOMING_DAYS + '일 이내'));
      for (const e of upcoming) {
        const s = new Date(e.s);
        sec.append(eventRow(e, shortDay(s), { meta: e.a ? '' : hm(s), tag: relTag(daysBetween(today, s)) }));
      }
      if (!upcoming.length) sec.append(h('div', { class: 'empty-row', text: '앞으로 ' + UPCOMING_DAYS + '일 동안 일정이 없어요' }));
      kids.push(sec);
    }

    kids.push(monthCard(today));
    root.replaceChildren(...kids);
  }

  function connectCard() {
    if (!clientId()) {
      return h('section', { class: 'card connect' },
        h('h2', { text: 'Google 캘린더 연결 준비가 필요해요' }),
        h('p', { text: '설정에서 웹 클라이언트 ID를 넣으면 일정이 보이고, 메모가 다른 기기와 동기화돼요. 지금 쓰는 메모는 이 폰에 저장됩니다.' }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn outline', onclick: openSettings, text: '설정 열기' })));
    }
    return h('section', { class: 'card connect' },
      h('h2', { text: 'Google 캘린더 연결' }),
      h('p', { text: '일정은 읽기만 해요. 메모와 할 일·목표는 내 Google 드라이브의 앱 전용 숨김 폴더에 저장돼 PC와 다른 폰에서도 보여요.' }),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn primary', onclick: connect, text: 'Google로 연결' })));
  }

  function monthCard(today) {
    const m = S.month;
    const card = h('section', { class: 'card month' });
    card.append(h('div', { class: 'month-head' },
      h('span', { class: 'm', text: (m.getMonth() + 1) + '월' }),
      h('span', { class: 'y', text: String(m.getFullYear()) }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '이전 달', onclick: () => stepMonth(-1) }, icon('left')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '다음 달', onclick: () => stepMonth(1) }, icon('right'))));
    const grid = h('div', { class: 'grid' });
    WD.forEach((w, i) => grid.append(h('span', { class: 'wdh' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), text: w })));
    const start = gridStart(m), cells = gridWeeks(m) * 7;
    for (let i = 0; i < cells; i++) {
      const d = addDays(start, i);
      const cls = ['cell', i % 7 === 0 ? 'sun' : '', i % 7 === 6 ? 'sat' : '', d.getMonth() !== m.getMonth() ? 'out' : '',
        sameDay(d, today) ? 'today' : '', sameDay(d, S.sel) ? 'sel' : ''].join(' ');
      grid.append(h('button', { type: 'button', class: cls, 'aria-label': longDay(d), onclick: () => selectDay(d) },
        h('span', { class: 'n', text: String(d.getDate()) }),
        dots(d.getMonth() === m.getMonth() ? dayDots(d, 3) : [], true)));
    }
    card.append(grid);
    return card;
  }

  function selectDay(d) {
    S.sel = startOfDay(d);
    if (d.getMonth() !== S.month.getMonth() || d.getFullYear() !== S.month.getFullYear()) {
      S.month = new Date(d.getFullYear(), d.getMonth(), 1);
      loadEvents(false);
    }
    render();
  }

  function stepMonth(n) {
    S.month = new Date(S.month.getFullYear(), S.month.getMonth() + n, 1);
    loadEvents(false);
    render();
  }

  // ------------------------------------------------------------------ rendering: notes tab
  function renderNotes() {
    const root = $('#view-notes');
    if (!root.firstChild) {
      const input = h('input', { id: 'note-search', type: 'search', placeholder: '메모 검색', autocomplete: 'off', enterkeyhint: 'search' });
      input.addEventListener('input', () => { S.query = input.value; renderNoteList(); });
      root.append(
        h('div', { class: 'notes-head' }, h('h1', { text: '메모' }), h('span', { class: 'count', id: 'note-count' })),
        h('label', { class: 'search' }, icon('search'), input),
        h('div', { class: 'note-list', id: 'note-list' }));
    }
    renderNoteList();
  }

  function renderNoteList() {
    const all = liveNotes();
    const q = S.query.trim().toLowerCase();
    const list = (q ? all.filter(n => (n.title + '\n' + n.body).toLowerCase().includes(q)) : all).sort((a, b) => b.updatedAt - a.updatedAt);
    $('#note-count').textContent = String(all.length);
    const box = $('#note-list');
    if (!all.length) {
      box.replaceChildren(h('div', { class: 'empty' }, icon('note'),
        h('strong', { text: '아직 메모가 없어요' }),
        h('p', { text: '아래 + 버튼으로 첫 메모를 써 보세요. 날짜를 정해 두면 일정 화면의 그날에도 보여요.' })));
      return;
    }
    if (!list.length) {
      box.replaceChildren(h('div', { class: 'empty' }, h('p', { text: '"' + S.query.trim() + '"와 맞는 메모가 없어요' })));
      return;
    }
    box.replaceChildren(...list.map(n => {
      const d = parseYmd(n.date);
      return h('button', { type: 'button', class: 'card note-card', onclick: () => openEditor(n.id, false) },
        h('span', { class: 'nt', text: noteTitle(n) }),
        n.title.trim() && n.body.trim() ? h('span', { class: 'nb', text: n.body.trim() }) : null,
        h('span', { class: 'nf' }, d ? h('span', { class: 'tag', text: shortDay(d) }) : null, h('span', { text: ago(n.updatedAt) })));
    }));
  }

  // ------------------------------------------------------------------ sync chip
  function renderSync() {
    const b = $('#sync');
    let text = '', cls = 'sync';
    if (S.sync === 'busy') { text = '동기화 중'; cls += ' busy'; }
    else if (prefs.connected && !tokenValid()) { text = S.dirty || S.wsDirty ? '다시 연결 · 저장 대기' : '다시 연결'; cls += ' warn'; }
    else if (S.sync === 'error') { text = '동기화 실패'; cls += ' warn'; }
    else if (S.sync === 'ok') { text = S.canDrive ? '동기화됨' : '일정 연결됨'; cls += ' ok'; }
    b.hidden = !text;
    b.textContent = text;
    b.className = cls;
  }

  function setSync(state, msg) {
    S.sync = state;
    S.syncMsg = msg || '';
    renderSync();
    if (!$('#settings').hidden) renderSettings();
  }

  // ------------------------------------------------------------------ Google sign-in (token model, popup)
  let tokenClient = null;
  const native = window.MyPlannerNative && typeof window.MyPlannerNative.postMessage === 'function' ? window.MyPlannerNative : null;
  const nativeWaiters = new Map();
  let nativeSeq = 0, authEpoch = 0, nativeTokenFlight = null, tokenTimer = null;
  let briefing = null, briefingBusy = false, briefingMessage = '';

  // Listen on the origin-restricted native object, never on window's public message channel.
  if (native) {
    const receive = e => {
      if (typeof e.data !== 'string' || e.data.length > 65536) return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (!isObj(m)) return;
      const key = m.type === 'token' ? 'token:' + m.id : m.type;
      const waiter = nativeWaiters.get(key);
      if (!waiter) return;
      nativeWaiters.delete(key); clearTimeout(waiter.timer); waiter.resolve(m);
    };
    if (typeof native.addEventListener === 'function') native.addEventListener('message', receive);
    else native.onmessage = receive;
  }

  function nativeRequest(msg) {
    const key = msg.type === 'token' ? 'token:' + msg.id : msg.type.startsWith('briefing:') && msg.type !== 'briefing:test' ? 'briefing' : msg.type;
    // Non-token responses have no id. Share the pending request rather than mismatching replies.
    if (nativeWaiters.has(key)) return nativeWaiters.get(key).promise;
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const finish = m => { nativeWaiters.delete(key); resolve(m); };
    const timeout = msg.type === 'token' && msg.interactive ? 300000 : msg.type === 'briefing:test' ? 180000 : 45000;
    const timer = setTimeout(() => finish({ error: 'failed', message: '앱 응답이 늦어요. 잠시 후 다시 시도해 주세요.' }), timeout);
    nativeWaiters.set(key, { resolve, timer, promise });
    try { native.postMessage(JSON.stringify(msg)); }
    catch (_) { clearTimeout(timer); finish({ error: 'failed', message: '앱에 연결하지 못했어요. 앱을 다시 열어 주세요.' }); }
    return promise;
  }

  async function nativeToken(interactive, stale) {
    if (nativeTokenFlight) {
      const ok = await nativeTokenFlight;
      if (ok || !interactive) return ok;
    }
    if (!interactive && tokenValid() && (!stale || stale !== S.token)) return true;
    const epoch = authEpoch;
    const request = { type: 'token', id: String(++nativeSeq), interactive: !!interactive };
    if (stale) request.stale = stale;
    const flight = (async () => {
      const resp = await nativeRequest(request);
      if (epoch !== authEpoch) return false; // disconnect wins over a late native reply
      if (!resp.error && typeof resp.access_token === 'string' && resp.access_token) {
        applyToken(resp); return true;
      }
      clearTimeout(tokenTimer); S.token = null; S.tokenExp = 0;
      setSync(prefs.connected ? 'reconnect' : 'idle');
      if (interactive || resp.error !== 'needs_consent') toast(resp.message || 'Google 연결에 실패했어요. 다시 시도해 주세요.');
      return false;
    })();
    nativeTokenFlight = flight;
    try { return await flight; }
    finally { if (nativeTokenFlight === flight) nativeTokenFlight = null; }
  }

  function revokeToken() {
    authEpoch++; clearTimeout(tokenTimer); nativeTokenFlight = null;
    if (native) nativeRequest({ type: 'signout' }).then(r => { if (r.error) toast(r.message); });
    else if (S.token && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(S.token, () => {});
  }

  function loadGis() {
    if (native) return;
    if (document.querySelector('script[data-gis]')) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.dataset.gis = '1';
    s.onload = initTokenClient;
    s.onerror = () => { s.remove(); };
    document.head.appendChild(s);
  }

  function initTokenClient() {
    if (native) return;
    const id = clientId();
    if (!id || !window.google || !google.accounts || !google.accounts.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: [SCOPE_LIST, SCOPE_EVENTS, SCOPE_DRIVE, SCOPE_FILE].join(' '),
      include_granted_scopes: true,
      callback: onToken,
      error_callback: err => {
        setSync(prefs.connected ? 'reconnect' : 'idle');
        if (err && err.type === 'popup_failed_to_open') toast('팝업이 막혔어요. 브라우저에서 이 사이트의 팝업을 허용해 주세요.');
      },
    });
  }

  function connect() {
    requestToken(prefs.connected ? '' : 'consent');
  }

  // prompt '' asks again only for scopes not granted yet; 'consent' shows the full consent screen
  function requestToken(prompt) {
    if (native) { nativeToken(true).then(ok => { if (ok) syncAll(); }); return; }
    if (!clientId()) { openSettings(); return; }
    if (!tokenClient) {
      initTokenClient();
      if (!tokenClient) { loadGis(); toast('Google 로그인을 불러오는 중이에요. 잠시 후 다시 눌러 주세요.'); return; }
    }
    tokenClient.requestAccessToken({ prompt });
  }

  function onToken(resp) {
    if (!resp || resp.error || !resp.access_token) {
      setSync(prefs.connected ? 'reconnect' : 'idle');
      if (resp && resp.error && resp.error !== 'access_denied') toast('Google 연결에 실패했어요. 다시 시도해 주세요.');
      return;
    }
    applyToken(resp);
    syncAll();
  }

  function applyToken(resp) {
    S.token = resp.access_token;
    const lifetime = Number.isFinite(+resp.expires_in) && +resp.expires_in > 0 ? +resp.expires_in : 3600;
    S.tokenExp = Date.now() + Math.max(1, lifetime - Math.min(120, lifetime / 2)) * 1000;
    const granted = typeof resp.scope === 'string' ? resp.scope.split(/\s+/) : [];
    const has = (...scopes) => scopes.every(s => granted.includes(s));
    S.canCal = has(SCOPE_LIST, SCOPE_EVENTS);
    S.canDrive = has(SCOPE_DRIVE);
    // accounts connected before the Doc copy existed may lack drive.file: notes still sync, the copy is skipped
    S.canCopy = has(SCOPE_FILE);
    prefs.connected = true;
    prefs.copy = S.canDrive && S.canCopy;
    savePrefs();
    if (!S.canCal && !S.canDrive) toast('권한을 받지 못해 연결하지 않았어요.');
    else if (!S.canDrive) toast('드라이브 권한이 없어 메모와 할 일은 이 폰에만 저장돼요.');
    else if (!S.canCal) toast('일정 읽기 권한이 없어 일정은 보이지 않아요.');
    if (native) {
      clearTimeout(tokenTimer);
      tokenTimer = setTimeout(() => { nativeToken(false).then(ok => { if (ok) syncAll(); }); }, Math.max(1, S.tokenExp - Date.now() + 20));
    }
  }

  function disconnect() {
    revokeToken();
    S.token = null; S.tokenExp = 0; S.canCal = false; S.canDrive = false; S.canCopy = false;
    S.events = []; S.eventsRange = null; S.fileId = null; S.remoteDoc = null; S.wsFileId = null; S.wsDoc = null; S.lastSync = 0;
    prefs.connected = false; prefs.copy = false; prefs.docId = '';
    savePrefs();
    local.remove(K.events);
    setSync('idle');
    render();
    toast('연결을 해제했어요. 메모와 할 일은 이 폰에 남아 있어요.');
  }

  class AuthNeeded extends Error {}

  async function api(url, opts) {
    const epoch = authEpoch;
    if (native && !tokenValid()) await nativeToken(false);
    if (epoch !== authEpoch) throw new AuthNeeded('disconnected');
    if (!tokenValid()) { S.token = null; throw new AuthNeeded('token'); }
    const send = token => {
      const o = Object.assign({}, opts || {});
      o.headers = Object.assign({}, (opts && opts.headers) || {}, { Authorization: 'Bearer ' + token });
      return fetch(url, o);
    };
    const used = S.token;
    let r = await send(used);
    if (epoch !== authEpoch) throw new AuthNeeded('disconnected');
    if (r.status === 401 && native && await nativeToken(false, used)) r = await send(S.token);
    if (epoch !== authEpoch) throw new AuthNeeded('disconnected');
    if (r.status === 401) { S.token = null; throw new AuthNeeded('expired'); }
    if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; throw err; }
    return r;
  }

  function failText(err) {
    if (err.userText) return err.userText;
    if (err instanceof TypeError) return '인터넷 연결을 확인해 주세요.';
    if (err.status === 403) return 'Google에서 거부했어요. 클라이언트 설정에서 Calendar·Drive API가 켜져 있는지 확인해 주세요.';
    if (err.status === 429) return '요청이 많아요. 잠시 후 다시 시도해 주세요.';
    return '동기화하지 못했어요 (' + (err.status || '오류') + ').';
  }

  function handleFailure(err) {
    if (err instanceof AuthNeeded && err.message === 'disconnected') return;
    if (err instanceof AuthNeeded) setSync('reconnect');
    else setSync('error', failText(err));
  }

  async function syncAll() {
    if (native && !tokenValid() && !await nativeToken(false)) return;
    const epoch = authEpoch;
    setSync('busy');
    try {
      await Promise.all([loadEvents(true, true), syncNotes(true), syncWorkspace(true)]);
      if (epoch !== authEpoch) return;
      S.lastSync = Date.now();
      setSync('ok');
    } catch (err) {
      if (epoch === authEpoch) handleFailure(err);
    }
    render();
  }

  // ------------------------------------------------------------------ calendar (GET only)
  const enc = encodeURIComponent;
  let eventsBusy = false;

  function neededRange() {
    const today = startOfDay(new Date());
    const g0 = gridStart(S.month), g1 = addDays(g0, gridWeeks(S.month) * 7);
    return [Math.min(+g0, +today), Math.max(+g1, +addDays(today, UPCOMING_DAYS + 1))];
  }

  async function loadEvents(force, rethrow) {
    if (!S.canCal || !tokenValid()) return;
    let [s, e] = neededRange();
    if (!force && S.eventsRange && S.eventsRange[0] <= s && S.eventsRange[1] >= e) return;
    if (!force && S.eventsRange) { s = Math.min(s, S.eventsRange[0]); e = Math.max(e, S.eventsRange[1]); }
    if (eventsBusy) return;
    eventsBusy = true;
    try {
      const cals = await fetchCalendars();
      const lists = await Promise.all(cals.map(c => fetchEvents(c, s, e)));
      S.events = [].concat(...lists);
      S.eventsRange = [s, e];
      local.set(K.events, { at: Date.now(), items: S.events });
      render();
    } catch (err) {
      if (rethrow) throw err;
      handleFailure(err);
    } finally {
      eventsBusy = false;
    }
  }

  async function fetchCalendars() {
    const out = [];
    let page = '';
    for (let i = 0; i < 5; i++) {
      const url = CAL + '/users/me/calendarList?minAccessRole=reader&maxResults=250&fields=' +
        enc('items(id,backgroundColor,selected,primary,hidden),nextPageToken') + (page ? '&pageToken=' + enc(page) : '');
      const j = await (await api(url)).json();
      out.push(...(j.items || []));
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out.filter(c => (c.selected || c.primary) && !c.hidden && typeof c.id === 'string');
  }

  const safeColor = c => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#4F7CAC');
  function httpsLink(u, hosts) {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname) ? url.href : null;
    } catch (e) { return null; }
  }
  const safeLink = u => httpsLink(u, ['www.google.com', 'calendar.google.com']);
  const attachLink = u => httpsLink(u, ATTACH_HOSTS);
  const cap = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

  // Event descriptions are sometimes HTML. They become plain text here and are only ever shown with textContent.
  const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function plainText(s) {
    return String(s)
      .replace(/\r\n?/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/?(p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (m, c) => {
        if (c[0] !== '#') { const v = ENTITY[c.toLowerCase()]; return v == null ? m : v; }
        const n = c[1] === 'x' || c[1] === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
        return n > 0 && n <= 0x10FFFF && (n < 0xD800 || n > 0xDFFF) ? String.fromCodePoint(n) : m;
      })
      .replace(/[ \t ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function attachment(a) {
    if (!isObj(a)) return null;
    const id = driveId(a.fileId);
    const u = typeof a.fileUrl === 'string' && a.fileUrl ? a.fileUrl : id ? 'https://drive.google.com/open?id=' + id : '';
    return {
      t: cap(String(a.title || '').trim(), 200),
      u: u.length <= 2000 ? u : '', // kept as given; only allowed https links are opened (attachLink)
      m: String(a.mimeType || '').slice(0, 100),
    };
  }

  async function fetchEvents(cal, s, e) {
    const out = [];
    let page = '';
    for (let i = 0; i < 10; i++) {
      const url = CAL + '/calendars/' + enc(cal.id) + '/events?singleEvents=true&orderBy=startTime&maxResults=250' +
        '&timeMin=' + enc(new Date(s).toISOString()) + '&timeMax=' + enc(new Date(e).toISOString()) +
        '&fields=' + enc('items(id,status,summary,start,end,htmlLink,location,description,' +
          'attachments(fileUrl,title,mimeType,fileId),attendees(self,responseStatus)),nextPageToken') +
        (page ? '&pageToken=' + enc(page) : '');
      const j = await (await api(url)).json();
      for (const ev of j.items || []) {
        if (ev.status === 'cancelled' || !ev.start) continue;
        const me = (ev.attendees || []).find(a => a.self);
        if (me && me.responseStatus === 'declined') continue;
        const allDay = !!ev.start.date;
        const st = allDay ? parseYmd(ev.start.date) : new Date(ev.start.dateTime);
        const en = allDay ? parseYmd(ev.end && ev.end.date) : new Date((ev.end && ev.end.dateTime) || ev.start.dateTime);
        if (!st || isNaN(+st)) continue;
        const end = en && !isNaN(+en) ? +en : +st + (allDay ? DAY : 0);
        const item = {
          k: cal.id + '|' + ev.id,
          t: String(ev.summary || '(제목 없음)').slice(0, 300),
          s: +st,
          e: Math.max(end, +st),
          a: allDay,
          c: safeColor(cal.backgroundColor),
          l: safeLink(ev.htmlLink),
        };
        // detail fields, short keys and capped so the event cache stays small
        const desc = typeof ev.description === 'string' ? cap(plainText(ev.description), MAX_DESC) : '';
        const place = typeof ev.location === 'string' ? cap(ev.location.trim(), MAX_PLACE) : '';
        const files = Array.isArray(ev.attachments) ? ev.attachments.slice(0, MAX_ATTACH).map(attachment).filter(Boolean) : [];
        if (desc) item.d = desc;
        if (place) item.p = place;
        if (files.length) item.f = files;
        out.push(item);
      }
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out;
  }

  // ------------------------------------------------------------------ notes: device + Drive app folder
  let saveTimer = 0, syncTimer = 0, notesBusy = false, notesAgain = false;

  function persistNotes() {
    clearTimeout(saveTimer);
    if (!local.set(K.notes, S.notes.filter(hasContent))) toast('이 폰에 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');
    S.dirty = true;
    scheduleSync();
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    if (S.canDrive && tokenValid()) syncTimer = setTimeout(() => syncNotes(false), 1500);
    else renderSync();
  }

  // Per id the newer edit wins; on a tie a deletion wins, otherwise the Drive version. Keys this page does not use
  // (for example "pc", written by the PC app) travel with their note, and when this phone's newer edit wins over a
  // Drive version, that version's extra keys are carried over so they are never dropped.
  const NOTE_KEYS = ['id', 'title', 'body', 'date', 'createdAt', 'updatedAt', 'deleted'];
  const newer = (a, b) => a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && !!a.deleted && !b.deleted);

  // the same rules merge notes, workspace items (by id) and daily plans (by date)
  function mergeBy(mine, remote, keyOf, valid, known) {
    const map = new Map();
    for (const n of mine) if (valid(n) && (!map.has(keyOf(n)) || newer(n, map.get(keyOf(n))))) map.set(keyOf(n), n);
    for (const r of remote) {
      if (!valid(r)) continue;
      const cur = map.get(keyOf(r));
      map.set(keyOf(r), !cur || !newer(cur, r) ? r : withExtraKeys(cur, r, known));
    }
    const cutoff = Date.now() - 60 * DAY; // forget deletions after 60 days
    return Array.from(map.values()).filter(n => !(n.deleted && n.updatedAt < cutoff));
  }

  const mergeNotes = (mine, remote) => mergeBy(mine, remote, n => n.id, validNote, NOTE_KEYS);

  function withExtraKeys(n, from, known) {
    const extra = Object.keys(from).filter(k => !known.includes(k) && !Object.prototype.hasOwnProperty.call(n, k));
    if (!extra.length) return n;
    const out = Object.assign({}, n);
    for (const k of extra) out[k] = from[k];
    return out;
  }

  const signature = list => JSON.stringify(list.filter(hasContent).map(n => [n.id, n.updatedAt, !!n.deleted]).sort());

  // ---- files in the Drive app-data folder (notes and workspace use the same steps)
  async function findAppFile(name) {
    const url = DRIVE + '/files?spaces=appDataFolder&orderBy=createdTime&pageSize=10&fields=' + enc('files(id)') +
      '&q=' + enc("name = '" + name + "' and trashed = false");
    const j = await (await api(url)).json();
    return j.files && j.files.length ? j.files[0].id : null;
  }

  // -> [fileId, document or null]; a file removed on another device is looked up once more
  async function downloadAppFile(name, id) {
    for (let i = 0; i < 2; i++) {
      if (!id) id = await findAppFile(name);
      if (!id) return [null, null];
      try {
        const doc = await (await api(DRIVE + '/files/' + enc(id) + '?alt=media')).json().catch(() => null);
        return [id, isObj(doc) ? doc : null];
      } catch (err) {
        if (err.status !== 404) throw err;
        id = null;
      }
    }
    return [null, null];
  }

  async function uploadAppFile(name, id, doc) {
    const body = JSON.stringify(doc);
    if (id) {
      await api(UPLOAD + '/files/' + enc(id) + '?uploadType=media&fields=id', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body,
      });
      return id;
    }
    const meta = { name, parents: ['appDataFolder'], mimeType: 'application/json' };
    const r = await api(UPLOAD + '/files?uploadType=multipart&fields=id', multipart(meta, 'application/json; charset=UTF-8', body));
    return (await r.json()).id;
  }

  // a file written by a newer MyPlanner: never overwrite a format this page does not know
  function newerFormat(text) {
    const err = new Error('newer format');
    err.userText = text;
    return err;
  }

  // The shared file starts from the last downloaded document: top-level keys this page does not know (and "mirror")
  // are written back unchanged; only notes and savedAt are replaced. Entries this page cannot read stay as they were.
  function notesDoc() {
    const base = isObj(S.remoteDoc) ? S.remoteDoc : {};
    const notes = S.notes.filter(hasContent);
    const ids = new Set(notes.map(n => n.id));
    const unread = Array.isArray(base.notes) ? base.notes.filter(n => isObj(n) && !validNote(n) && !ids.has(n.id)) : [];
    return Object.assign({}, base, { app: 'my-calendar', kind: 'notes', version: 1, savedAt: Date.now(), notes: notes.concat(unread) });
  }

  function multipart(meta, type, body) {
    const boundary = 'mc' + Math.random().toString(36).slice(2);
    return {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
        '\r\n--' + boundary + '\r\nContent-Type: ' + type + '\r\n\r\n' + body + '\r\n--' + boundary + '--',
    };
  }

  async function uploadNotes() {
    const doc = notesDoc();
    S.fileId = await uploadAppFile(NOTES_FILE, S.fileId, doc);
    S.remoteDoc = doc;
  }

  async function syncNotes(rethrow) {
    if (!S.canDrive || !tokenValid()) return;
    if (notesBusy) { notesAgain = true; return; }
    notesBusy = true;
    const standalone = !rethrow;
    if (standalone) setSync('busy');
    try {
      [S.fileId, S.remoteDoc] = await downloadAppFile(NOTES_FILE, S.fileId);
      if (S.remoteDoc && Number(S.remoteDoc.version) > 1) {
        // written by a newer MyPlanner: never overwrite a format this page does not know
        const err = new Error('newer notes format');
        err.userText = '다른 기기에서 더 새 버전으로 저장한 메모예요. 이 페이지를 새로고침해 주세요.';
        throw err;
      }
      const remote = S.remoteDoc && Array.isArray(S.remoteDoc.notes) ? S.remoteDoc.notes.filter(validNote) : [];
      // merge with the notes as they are now (edits made while downloading are included)
      const before = signature(S.notes);
      S.notes = mergeNotes(S.notes, remote);
      local.set(K.notes, S.notes.filter(hasContent));
      if (signature(S.notes) !== before) refreshViews();
      if (!S.fileId || signature(S.notes) !== signature(remote)) await uploadNotes();
      S.dirty = false;
      try {
        await syncCopy();
      } catch (err) {
        console.warn('MyPlanner: Drive copy not updated (' + (err.status || err.message || 'error') + ')');
      }
      if (standalone) { S.lastSync = Date.now(); setSync('ok'); }
    } catch (err) {
      if (rethrow) throw err;
      handleFailure(err);
    } finally {
      notesBusy = false;
      if (notesAgain) { notesAgain = false; syncNotes(false); }
    }
  }

  // ------------------------------------------------------------------ workspace: goals, projects, tasks (device + Drive app folder)
  // my-calendar-workspace.json is shared with the PC app: items merge by id and plans by date with the notes rules.
  // Keys and entries this page does not know are written back unchanged. Nothing is uploaded when nothing changed.
  let wsSaveTimer = 0, wsTimer = 0, wsBusy = false, wsAgain = false;

  const mergeItems = (mine, remote) => mergeBy(mine, remote, i => i.id, validItem, ITEM_KEYS);
  const mergePlans = (mine, remote) => mergeBy(mine, remote, p => p.date, validPlan, PLAN_KEYS);
  const wsSignature = (items, plans) => JSON.stringify([
    items.filter(keepItem).map(i => [i.id, i.updatedAt, !!i.deleted]).sort(),
    plans.map(p => [p.date, p.updatedAt]).sort(),
  ]);

  function persistWs() {
    clearTimeout(wsSaveTimer);
    if (!local.set(K.ws, { items: S.ws.items.filter(keepItem), plans: S.ws.plans })) toast('이 폰에 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');
    S.wsDirty = true;
    clearTimeout(wsTimer);
    if (S.canDrive && tokenValid()) wsTimer = setTimeout(() => syncWorkspace(false), 1500);
    else renderSync();
  }

  function wsDoc() {
    const base = isObj(S.wsDoc) ? S.wsDoc : {};
    const items = S.ws.items.filter(keepItem);
    const ids = new Set(items.map(i => i.id));
    const dates = new Set(S.ws.plans.map(p => p.date));
    const unreadItems = arr(base.items).filter(i => !validItem(i) && !(isObj(i) && ids.has(i.id)));
    const unreadPlans = arr(base.plans).filter(p => !validPlan(p) && !(isObj(p) && dates.has(p.date)));
    return Object.assign({}, base, {
      app: 'my-calendar', kind: 'workspace', version: 1, savedAt: Date.now(),
      items: items.concat(unreadItems), plans: S.ws.plans.concat(unreadPlans),
    });
  }

  async function syncWorkspace(rethrow) {
    if (!S.canDrive || !tokenValid()) return;
    if (wsBusy) { wsAgain = true; return; }
    wsBusy = true;
    const standalone = !rethrow;
    if (standalone) setSync('busy');
    try {
      [S.wsFileId, S.wsDoc] = await downloadAppFile(WS_FILE, S.wsFileId);
      if (S.wsDoc && Number(S.wsDoc.version) > 1) throw newerFormat('다른 기기에서 더 새 버전으로 저장한 할 일이에요. 이 페이지를 새로고침해 주세요.');
      const rItems = arr(S.wsDoc && S.wsDoc.items).filter(validItem);
      const rPlans = arr(S.wsDoc && S.wsDoc.plans).filter(validPlan);
      // merge with the workspace as it is now (edits made while downloading are included)
      const before = wsSignature(S.ws.items, S.ws.plans);
      S.ws.items = mergeItems(S.ws.items, rItems);
      S.ws.plans = mergePlans(S.ws.plans, rPlans);
      local.set(K.ws, { items: S.ws.items.filter(keepItem), plans: S.ws.plans });
      const after = wsSignature(S.ws.items, S.ws.plans);
      if (after !== before) refreshViews(); // an open editor is left alone so typing is never interrupted
      const anything = S.ws.items.some(keepItem) || S.ws.plans.length > 0;
      if (S.wsFileId ? after !== wsSignature(rItems, rPlans) : anything) {
        const doc = wsDoc();
        S.wsFileId = await uploadAppFile(WS_FILE, S.wsFileId, doc);
        S.wsDoc = doc;
      }
      S.wsDirty = false;
      if (standalone) { S.lastSync = Date.now(); setSync('ok'); }
    } catch (err) {
      if (rethrow) throw err;
      handleFailure(err);
    } finally {
      wsBusy = false;
      if (wsAgain) { wsAgain = false; syncWorkspace(false); }
    }
  }

  // ---- reading the workspace (references to missing or deleted items simply count as "none")
  const itemById = id => S.ws.items.find(i => i.id === id);
  const liveItems = kind => S.ws.items.filter(i => i.kind === kind && !i.deleted);
  const liveItem = (id, kind) => {
    const i = typeof id === 'string' && id ? itemById(id) : null;
    return i && !i.deleted && i.kind === kind ? i : null;
  };
  const itemTitle = i => (typeof i.title === 'string' && i.title.trim()) || '(제목 없음)';
  const todayKey = () => ymd(startOfDay(new Date()));
  const planOf = date => S.ws.plans.find(p => p.date === date) || null;
  const taskList = t => (TASK_STATUS.includes(t.status) ? t.status : 'inbox');
  const projStatus = p => (PROJECT_GROUPS.some(g => g[0] === p.status) ? p.status : 'active');
  const dateKey = (d, empty) => (typeof d === 'string' && d ? d : empty);
  const byDue = (a, b) => ordinal(dateKey(a.dueDate, '9999'), dateKey(b.dueDate, '9999')) || a.createdAt - b.createdAt;
  const byPlanned = (a, b) => ordinal(dateKey(a.plannedDate, '9999'), dateKey(b.plannedDate, '9999')) || byDue(a, b);
  const inFocus = id => { const p = planOf(todayKey()); return !!p && p.focus.includes(id); };

  // "오늘": open tasks picked for today, planned for today, or due today or earlier
  function todayTasks() {
    const key = todayKey();
    const open = new Map(liveItems('task').filter(t => t.status !== 'done').map(t => [t.id, t]));
    const out = [], seen = new Set();
    const add = t => { if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); } };
    const plan = planOf(key);
    if (plan) for (const id of plan.focus) add(open.get(id));
    const rest = Array.from(open.values());
    rest.filter(t => t.plannedDate === key).sort((a, b) => a.createdAt - b.createdAt).forEach(add);
    rest.filter(t => typeof t.dueDate === 'string' && t.dueDate <= key).sort(byDue).forEach(add);
    return out;
  }

  // ---- changing the workspace
  function touchItem(id, mutate, soon) {
    const it = itemById(id);
    if (!it) return null;
    mutate(it);
    it.updatedAt = Date.now();
    clearTimeout(wsSaveTimer);
    if (soon) wsSaveTimer = setTimeout(persistWs, 400); else persistWs();
    return it;
  }

  function setFocus(id, on) {
    const key = todayKey();
    let p = planOf(key);
    if (p ? p.focus.includes(id) === on : !on) return;
    if (!p) { p = { date: key, focus: [], updatedAt: 0 }; S.ws.plans.push(p); }
    p.focus = on ? p.focus.concat(id) : p.focus.filter(x => x !== id);
    p.updatedAt = Date.now();
    persistWs();
  }

  function setDone(id, done, quiet) {
    const t = touchItem(id, x => {
      if (done) {
        if (x.status !== 'done') S.prevStatus[x.id] = x.status;
        x.status = 'done';
        x.completedAt = Date.now();
      } else {
        const back = S.prevStatus[x.id];
        x.status = back && back !== 'done' ? back : 'next';
        x.completedAt = null;
        delete S.prevStatus[x.id];
      }
    });
    if (!t) return;
    refreshViews();
    if (!$('#item-ed').hidden) renderItemEditor();
    if (done && !quiet) toast('완료했어요', { label: '되돌리기', run: () => setDone(id, false, true) });
  }

  function newItem(kind, fields, extra) {
    const now = Date.now();
    const it = { id: uid(), kind, title: '', createdAt: now, updatedAt: now };
    if (kind === 'goal') Object.assign(it, { horizon: 'one-year', status: 'active', desiredResult: null, dueDate: null });
    else if (kind === 'project') Object.assign(it, { status: 'active', category: null, parentId: null, dueDate: null });
    else Object.assign(it, { status: 'next', projectId: null, dueDate: null, plannedDate: null, completedAt: null });
    Object.assign(it, fields || {});
    S.ws.items.push(it);
    openItem(it.id, true, extra);
  }

  // ------------------------------------------------------------------ Drive copy (Google Doc, one-way, best effort)
  // Shared with the PC app through "mirror" in the notes file: { folderId, docId, sig }. sig is the JSON of the live
  // notes' [id, updatedAt] pairs sorted by id; the Doc is rewritten only when it changes. The HTML has no timestamps,
  // so both apps write the same Doc for the same notes. Edits made in the Doc are never read back.
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function copyNotes() {
    return liveNotes().sort((a, b) => {
      const da = a.date || '', db = b.date || '';
      if (da !== db) return !da ? 1 : !db ? -1 : ordinal(db, da); // newest date first, undated last
      return b.updatedAt - a.updatedAt || ordinal(a.id, b.id);
    });
  }

  const copySig = notes => JSON.stringify(notes.map(n => [n.id, n.updatedAt]).sort((a, b) => ordinal(a[0], b[0])));

  function copyHtml(notes) {
    const out = ['<!DOCTYPE html>', '<html><head><meta charset="utf-8"></head><body>', '<h1>' + escHtml(COPY_DOC) + '</h1>'];
    for (const n of notes) {
      const body = n.body.replace(/\r\n?/g, '\n');
      out.push('<h2>' + escHtml(n.title.trim() || body.trim().split('\n')[0].trim() || '(제목 없음)') + '</h2>');
      const d = parseYmd(n.date);
      if (d) out.push('<p><small>' + n.date + ' (' + WD[d.getDay()] + ')</small></p>');
      for (const para of body.split(/\n\s*\n/)) {
        const p = para.replace(/^\s*\n|\s+$/g, '');
        if (p.trim()) out.push('<p>' + p.split('\n').map(escHtml).join('<br>') + '</p>');
      }
    }
    out.push('<p>' + escHtml(COPY_FOOTER) + '</p>', '</body></html>');
    return out.join('\n');
  }

  async function syncCopy() {
    if (!S.canCopy || !S.canDrive || S.editing || !tokenValid()) return; // while a note is open, wait until it closes
    const notes = copyNotes(), sig = copySig(notes);
    const old = S.remoteDoc && isObj(S.remoteDoc.mirror) ? S.remoteDoc.mirror : {};
    let folderId = driveId(old.folderId), docId = driveId(old.docId);
    if (docId && old.sig === sig) { rememberDoc(docId); return; }
    if (!docId && !notes.length) return; // no Doc until there is a note to show
    const html = copyHtml(notes);
    if (docId && !(await writeDoc(docId, html))) docId = null;
    if (!docId) { // first time, or deleted by the user: find it again or make it again
      folderId = await ensureFolder(folderId);
      docId = await findCopy("name = '" + COPY_DOC + "' and mimeType = '" + GDOC_MIME + "' and '" + folderId + "' in parents and trashed = false");
      if (docId && !(await writeDoc(docId, html))) docId = null;
      if (!docId) docId = await createDoc(folderId, html);
    }
    const mirror = Object.assign({}, old, { docId, sig });
    if (folderId) mirror.folderId = folderId;
    S.remoteDoc = Object.assign({}, S.remoteDoc, { mirror });
    await uploadNotes();
    rememberDoc(docId);
  }

  // false when the Doc is gone (404) or in the trash, so it is made again
  async function writeDoc(id, html) {
    try {
      const r = await api(UPLOAD + '/files/' + enc(id) + '?uploadType=media&fields=' + enc('id,trashed'), {
        method: 'PATCH', headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: html,
      });
      const j = await r.json().catch(() => ({}));
      return !j.trashed;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  async function ensureFolder(id) {
    if (id) {
      try {
        const j = await (await api(DRIVE + '/files/' + enc(id) + '?fields=' + enc('id,trashed'))).json();
        if (!j.trashed) return id;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const found = await findCopy("name = '" + COPY_FOLDER + "' and mimeType = '" + FOLDER_MIME + "' and 'root' in parents and trashed = false");
    if (found) return found;
    const r = await api(DRIVE + '/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: COPY_FOLDER, mimeType: FOLDER_MIME }),
    });
    return needId((await r.json()).id);
  }

  // drive.file lists only files this app made, so a copy made earlier (here or on the PC) is reused, not duplicated
  async function findCopy(q) {
    const url = DRIVE + '/files?spaces=drive&orderBy=createdTime&pageSize=10&fields=' + enc('files(id)') + '&q=' + enc(q);
    const j = await (await api(url)).json();
    return j.files && j.files.length ? driveId(j.files[0].id) : null;
  }

  async function createDoc(folderId, html) {
    const meta = { name: COPY_DOC, mimeType: GDOC_MIME, parents: [folderId] }; // Drive converts the HTML to a Doc
    const r = await api(UPLOAD + '/files?uploadType=multipart&fields=id', multipart(meta, 'text/html; charset=UTF-8', html));
    return needId((await r.json()).id);
  }

  function needId(v) {
    const id = driveId(v);
    if (!id) throw new Error('unexpected file id');
    return id;
  }

  function rememberDoc(id) {
    if (prefs.docId === id) return;
    prefs.docId = id;
    savePrefs();
    if (!$('#settings').hidden) renderSettings();
  }

  // re-render what is visible without disturbing an open editor or the search box
  function refreshViews() {
    renderSync();
    if (S.tab === 'cal') renderCal();
    else if (S.tab === 'tasks') renderTasks();
    else if (S.tab === 'goals') renderGoals();
    else renderNoteList();
  }

  // ------------------------------------------------------------------ sheets + history (Back closes a sheet)
  function openSheet(id) {
    $('#' + id).hidden = false;
    document.body.style.overflow = 'hidden';
    if (!history.state || !history.state.sheet) history.pushState({ sheet: id }, '');
  }

  function closeSheetUi() {
    if (history.state && history.state.sheet) history.back();
    else hideSheets();
  }

  const SHEETS = ['editor', 'settings', 'detail', 'item-ed'];

  function hideSheets() {
    if (!$('#editor').hidden) finishEditing();
    while (S.itemStack.length) finishItem(S.itemStack.pop());
    for (const id of SHEETS) $('#' + id).hidden = true;
    S.detail = null;
    S.confirmWipe = false;
    document.body.style.overflow = '';
    render();
  }

  // an item editor opened from another one (a project's task) has its own history entry: Back returns to the parent
  window.addEventListener('popstate', () => {
    if (!$('#item-ed').hidden && S.itemStack.length > 1) {
      finishItem(S.itemStack.pop());
      renderItemEditor();
      return;
    }
    if (SHEETS.some(id => !$('#' + id).hidden)) hideSheets();
  });

  // ------------------------------------------------------------------ event detail (read-only)
  function openDetail(e) {
    S.detail = e;
    renderDetail();
    openSheet('detail');
    $('#dt-body').scrollTop = 0;
  }

  function whenText(e) {
    const st = new Date(e.s), en = new Date(e.e);
    const yr = d => (d.getFullYear() !== S.now.getFullYear() ? d.getFullYear() + '년 ' : '');
    if (e.a) {
      const last = e.e > e.s ? addDays(startOfDay(en), -1) : st; // the end date of an all-day event is exclusive
      if (+last <= +st) return [yr(st) + longDay(st), '종일'];
      return [yr(st) + chipDay(st) + ' – ' + yr(last) + chipDay(last), '종일 · ' + (daysBetween(st, last) + 1) + '일'];
    }
    if (e.e <= e.s) return [yr(st) + longDay(st), hm(st)];
    if (sameDay(st, en)) return [yr(st) + longDay(st), hm(st) + ' – ' + hm(en)];
    if (+en === +addDays(st, 1)) return [yr(st) + longDay(st), hm(st) + ' – 24:00'];
    return [yr(st) + chipDay(st) + ' ' + hm(st) + ' –', yr(en) + chipDay(en) + ' ' + hm(en)];
  }

  function fileKind(mime) {
    if (mime === GDOC_MIME) return '문서';
    if (mime === 'application/vnd.google-apps.spreadsheet') return '스프레드시트';
    if (mime === 'application/vnd.google-apps.presentation') return '프레젠테이션';
    if (mime === 'application/pdf') return 'PDF';
    if (/^image\//.test(mime || '')) return '이미지';
    return '파일';
  }

  function attachRow(a) {
    const title = (typeof a.t === 'string' && a.t.trim()) || '첨부파일';
    const url = attachLink(a.u);
    if (!url) {
      return h('div', { class: 'att off' }, icon('clip'),
        h('span', { class: 'at', text: title }), h('span', { class: 'am', text: '열 수 없는 링크' }));
    }
    return h('a', { class: 'att', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('clip'),
      h('span', { class: 'at', text: title }), h('span', { class: 'am', text: fileKind(a.m) }), icon('ext', 'go'));
  }

  // every field may come from the device cache, so each one is checked again here
  function renderDetail() {
    const e = S.detail;
    if (!e) return;
    const [main, sub] = whenText(e);
    const kids = [
      h('div', { class: 'dt-head' }, h('span', { class: 'bar', style: { '--c': safeColor(e.c) } }), h('h1', { class: 'dt-title', text: e.t })),
      h('div', { class: 'dt-line' }, icon('clock'),
        h('span', { class: 'dt-when' }, h('span', { class: 'main', text: main }), h('span', { class: 'sub', text: sub }))),
    ];
    const place = typeof e.p === 'string' ? e.p.trim() : '';
    if (place) kids.push(h('div', { class: 'dt-line' }, icon('pin'), h('span', { class: 'dt-place', text: place })));
    const desc = typeof e.d === 'string' ? e.d.trim() : '';
    if (desc) kids.push(h('section', { class: 'dt-sec' }, h('h2', { text: '설명' }), h('p', { class: 'dt-text', text: desc })));
    const files = Array.isArray(e.f) ? e.f.filter(isObj).slice(0, MAX_ATTACH) : [];
    if (files.length) kids.push(h('section', { class: 'dt-sec' }, h('h2', { text: '첨부파일 ' + files.length }), files.map(attachRow)));
    $('#dt-body').replaceChildren(...kids);
    const link = safeLink(e.l), foot = $('#dt-foot');
    foot.hidden = !link;
    if (link) foot.replaceChildren(h('a', { class: 'btn outline', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Google 캘린더에서 열기'));
    else foot.replaceChildren();
  }

  $('#dt-close').addEventListener('click', closeSheetUi);

  // ------------------------------------------------------------------ editor
  function newNote(date) {
    const now = Date.now();
    const n = { id: uid(), title: '', body: '', date: date || null, createdAt: now, updatedAt: now };
    S.notes.push(n);
    openEditor(n.id, true);
  }

  function setDateLabel(date) {
    const d = parseYmd(date);
    $('#ed-date-label').textContent = d ? chipDay(d) : '날짜 없음';
    $('#ed-date-input').value = date || '';
    $('#ed-date-clear').hidden = !d;
  }

  function autosize() {
    const t = $('#ed-text');
    t.style.height = 'auto';
    t.style.height = Math.max(t.scrollHeight, 240) + 'px';
  }

  function openEditor(id, fresh) {
    const n = noteById(id);
    if (!n) return;
    S.editing = id;
    S.editingFresh = fresh;
    $('#ed-title').value = n.title;
    $('#ed-text').value = n.body;
    setDateLabel(n.date);
    $('#ed-confirm').hidden = true;
    $('#ed-state').textContent = fresh ? '새 메모' : '마지막 수정 ' + ago(n.updatedAt);
    openSheet('editor');
    autosize();
    if (fresh) setTimeout(() => $('#ed-title').focus(), 60);
  }

  function touchEditing(mutate) {
    const n = noteById(S.editing);
    if (!n) return;
    mutate(n);
    n.updatedAt = Date.now();
    $('#ed-state').textContent = '저장 중';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persistNotes(); $('#ed-state').textContent = '저장됨'; }, 400);
  }

  function finishEditing() {
    const n = noteById(S.editing);
    clearTimeout(saveTimer);
    if (n && !n.deleted && !n.title.trim() && !n.body.trim()) {
      if (S.editingFresh) S.notes = S.notes.filter(x => x !== n); // never saved: just drop it
      else { n.deleted = true; n.updatedAt = Date.now(); }
    }
    persistNotes();
    S.editing = null;
  }

  $('#ed-title').addEventListener('input', e => touchEditing(n => { n.title = e.target.value.slice(0, 200); }));
  $('#ed-title').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#ed-text').focus(); }
  });
  $('#ed-text').addEventListener('input', e => { touchEditing(n => { n.body = e.target.value; }); autosize(); });
  $('#ed-date-input').addEventListener('change', e => {
    const v = /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) ? e.target.value : null;
    touchEditing(n => { n.date = v; });
    setDateLabel(v);
  });
  $('#ed-date-clear').addEventListener('click', () => { touchEditing(n => { n.date = null; }); setDateLabel(null); });
  $('#ed-close').addEventListener('click', closeSheetUi);
  $('#ed-delete').addEventListener('click', () => { $('#ed-confirm').hidden = false; });
  $('#ed-confirm-no').addEventListener('click', () => { $('#ed-confirm').hidden = true; });
  $('#ed-confirm-yes').addEventListener('click', () => {
    const n = noteById(S.editing);
    if (n) { n.deleted = true; n.title = ''; n.body = ''; n.updatedAt = Date.now(); }
    S.editingFresh = false;
    closeSheetUi();
    toast('메모를 삭제했어요');
  });

  // ------------------------------------------------------------------ rendering: tasks, goals, projects
  function dueTag(date) {
    const d = parseYmd(date);
    if (!d) return null;
    const n = daysBetween(startOfDay(new Date()), d);
    return n < 0 ? { text: '지남', warn: true } : n === 0 ? { text: '오늘', warn: true } : { text: 'D-' + n, warn: false };
  }
  const tagEl = t => (t ? h('span', { class: 'tag' + (t.warn ? ' warn' : ''), text: t.text }) : null);
  const catClass = c => (CATEGORIES.some(x => x[0] === c) ? ' cat-' + c : '');

  function emptyState(iconName, title, line) {
    return h('div', { class: 'empty' }, icon(iconName), h('strong', { text: title }), h('p', { text: line }));
  }

  function foldHead(label, count, open, onToggle, cls) {
    return h('button', { type: 'button', class: (cls || 'list-head') + ' fold', 'aria-expanded': String(open), onclick: onToggle },
      h('span', { class: 'label', text: label }), h('span', { class: 'count', text: String(count) }),
      h('span', { class: 'aside', text: open ? '접기' : '펼치기' }));
  }

  function checkBtn(t, cls) {
    const done = t.status === 'done';
    return h('button', {
      type: 'button', class: 'check' + (cls ? ' ' + cls : ''), 'aria-pressed': String(done), 'aria-label': done ? '완료 취소' : '완료로 표시',
      onclick: ev => { ev.stopPropagation(); setDone(t.id, !done); },
    }, h('span', { class: 'ring' }, icon('check')));
  }

  function projectChip(p) {
    return h('span', { class: 'chip' + catClass(p.category) }, h('span', { class: 'cdot' }), h('span', { class: 'ct', text: itemTitle(p) }));
  }

  function taskRow(t, opts) {
    const done = t.status === 'done';
    const proj = liveItem(t.projectId, 'project');
    const meta = [];
    if (proj && !(opts && opts.noProject)) meta.push(projectChip(proj));
    if (!done) meta.push(tagEl(dueTag(t.dueDate)));
    const planned = opts && opts.planned ? parseYmd(t.plannedDate) : null;
    if (planned) meta.push(h('span', { class: 'mt', text: '예정 ' + shortDay(planned) }));
    if (done && Number.isFinite(t.completedAt)) meta.push(h('span', { class: 'mt', text: ago(t.completedAt) }));
    const shown = meta.filter(Boolean);
    return h('div', { class: 'trow' + (done ? ' done' : ''), 'data-id': t.id }, checkBtn(t),
      h('button', { type: 'button', class: 'tmain', onclick: () => openItem(t.id, false) },
        h('span', { class: 'ttitle', text: itemTitle(t) }),
        shown.length ? h('span', { class: 'tmeta' }, shown) : null));
  }

  // compact row for the 일정 tab's "오늘" list
  function calTaskRow(t) {
    const due = dueTag(t.dueDate);
    return h('div', { class: 'row trow-cal', 'data-id': t.id },
      h('span', { class: 'lead' }, checkBtn(t, 'small')),
      h('button', { type: 'button', class: 'tlink', onclick: () => openItem(t.id, false) }, h('span', { class: 'title', text: itemTitle(t) })),
      due && due.warn ? tagEl(due) : null);
  }

  function renderTasks() {
    const root = $('#view-tasks');
    const all = liveItems('task');
    const open = all.filter(t => t.status !== 'done');
    const kids = [h('div', { class: 'notes-head' }, h('h1', { text: '할 일' }), h('span', { class: 'count', text: String(open.length) }))];
    if (!all.length) {
      kids.push(emptyState('task', '아직 할 일이 없어요', '아래 + 버튼으로 오늘 할 일을 더해 보세요.'));
      root.replaceChildren(...kids);
      return;
    }
    const today = todayTasks(), shown = new Set(today.map(t => t.id));
    const sec = h('section', { class: 'list', 'data-sec': 'today' }, listHead('오늘', today.length, chipDay(startOfDay(new Date()))));
    for (const t of today) sec.append(taskRow(t));
    if (!today.length) sec.append(h('div', { class: 'empty-row', text: '오늘 할 일이 없어요' }));
    kids.push(sec);
    for (const [st, label] of TASK_SECTIONS) { // empty lists are left out
      const list = open.filter(t => !shown.has(t.id) && taskList(t) === st).sort(st === 'scheduled' ? byPlanned : byDue);
      if (!list.length) continue;
      const s = h('section', { class: 'list', 'data-sec': st }, listHead(label, list.length));
      for (const t of list) s.append(taskRow(t, { planned: st === 'scheduled' }));
      kids.push(s);
    }
    const since = Date.now() - 14 * DAY;
    const doneAt = t => (Number.isFinite(t.completedAt) ? t.completedAt : t.updatedAt);
    const done = all.filter(t => t.status === 'done' && doneAt(t) >= since).sort((a, b) => doneAt(b) - doneAt(a));
    if (done.length) {
      const s = h('section', { class: 'list', 'data-sec': 'done' }, foldHead('완료한 일', done.length, S.showDone, () => { S.showDone = !S.showDone; renderTasks(); }));
      if (S.showDone) for (const t of done) s.append(taskRow(t));
      kids.push(s);
    }
    root.replaceChildren(...kids);
  }

  function renderGoals() {
    const root = $('#view-goals');
    root.replaceChildren(
      h('div', { class: 'notes-head' }, h('h1', { text: '목표' })),
      seg([['goals', '목표'], ['projects', '프로젝트']], S.goalSeg, v => { S.goalSeg = v; updateFab(); renderGoals(); }, 'seg view-seg'),
      ...(S.goalSeg === 'projects' ? projectGroups() : goalGroups()));
  }

  function goalGroups() {
    const goals = liveItems('goal');
    if (!goals.length) return [emptyState('goal', '아직 목표가 없어요', '아래 + 버튼으로 첫 목표를 정해 보세요.')];
    const out = [];
    for (const [hz, label] of HORIZONS) {
      const list = goals.filter(g => (HORIZONS.some(x => x[0] === g.horizon) ? g.horizon : 'one-year') === hz)
        .sort((a, b) => (a.status === 'done') - (b.status === 'done') || byDue(a, b));
      if (list.length) out.push(h('section', { class: 'group', 'data-sec': hz }, h('div', { class: 'group-label', text: label + ' ' + list.length }), list.map(goalCard)));
    }
    return out;
  }

  function goalCard(g) {
    const projects = liveItems('project').filter(p => p.parentId === g.id);
    const doneCount = projects.filter(p => p.status === 'done').length;
    const foot = [];
    const d = parseYmd(g.dueDate);
    if (d && g.status !== 'done') {
      const n = daysBetween(startOfDay(new Date()), d);
      foot.push(h('span', { class: 'tag' + (n <= 0 ? ' warn' : ''), text: n > 0 ? 'D-' + n : n === 0 ? 'D-day' : '지남' }));
    }
    if (g.status === 'paused') foot.push(h('span', { class: 'tag', text: '보류' }));
    if (g.status === 'done') foot.push(h('span', { class: 'tag', text: '달성' }));
    foot.push(h('span', { class: 'gp', text: projects.length ? '프로젝트 ' + projects.length + '개 · 완료 ' + doneCount + '/' + projects.length : '연결된 프로젝트 없음' }));
    const result = typeof g.desiredResult === 'string' ? g.desiredResult.trim() : '';
    return h('button', { type: 'button', class: 'card note-card goal-card' + (g.status === 'done' ? ' dim' : ''), 'data-id': g.id, onclick: () => openItem(g.id, false) },
      h('span', { class: 'nt', text: itemTitle(g) }),
      result ? h('span', { class: 'nb one', text: result }) : null,
      h('span', { class: 'nf' }, foot));
  }

  function projectGroups() {
    const projects = liveItems('project');
    if (!projects.length) return [emptyState('goal', '아직 프로젝트가 없어요', '아래 + 버튼으로 첫 프로젝트를 만들어 보세요.')];
    const out = [];
    for (const [st, label] of PROJECT_GROUPS) {
      const list = projects.filter(p => projStatus(p) === st).sort(byDue);
      if (!list.length) continue;
      const open = st !== 'done' || S.showDoneProjects;
      const head = st === 'done'
        ? foldHead(label, list.length, open, () => { S.showDoneProjects = !S.showDoneProjects; renderGoals(); }, 'group-label')
        : h('div', { class: 'group-label', text: label + ' ' + list.length });
      out.push(h('section', { class: 'group', 'data-sec': st }, head, open ? list.map(projectCard) : null));
    }
    return out;
  }

  function projectCard(p) {
    const tasks = liveItems('task').filter(t => t.projectId === p.id);
    const done = tasks.filter(t => t.status === 'done').length;
    const goal = liveItem(p.parentId, 'goal');
    const cat = CATEGORIES.find(c => c[0] === p.category);
    const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    return h('button', { type: 'button', class: 'card note-card project-card' + (p.status === 'done' ? ' dim' : ''), 'data-id': p.id, onclick: () => openItem(p.id, false) },
      h('span', { class: 'nt', text: itemTitle(p) }),
      h('span', { class: 'pmeta' + catClass(p.category) }, h('span', { class: 'cdot' }), h('span', { class: 'pc', text: cat ? cat[1] : '분류 없음' }),
        h('span', { class: 'pg', text: '목표 ' + (goal ? itemTitle(goal) : '없음') })),
      h('span', { class: 'progress' },
        h('span', { class: 'track' }, h('span', { class: 'fill', style: { '--p': pct + '%' } })),
        h('span', { class: 'pn', text: done + '/' + tasks.length }),
        p.status !== 'done' ? tagEl(dueTag(p.dueDate)) : null));
  }

  // ------------------------------------------------------------------ item editor (task, goal, project)
  function openItem(id, fresh, extra) {
    const entry = Object.assign({ id, fresh: !!fresh, saved: !fresh }, extra || {});
    if (!$('#item-ed').hidden && S.itemStack.length) {
      S.itemStack.push(entry);
      history.pushState({ sheet: 'item-ed', depth: S.itemStack.length }, '');
    } else {
      S.itemStack = [entry];
      openSheet('item-ed');
    }
    renderItemEditor();
  }

  // closing an editor: a draft without a title is dropped; an emptied title deletes the item (like notes)
  function finishItem(entry) {
    clearTimeout(wsSaveTimer);
    const it = itemById(entry.id);
    if (it && !it.deleted && !(it.title || '').trim()) {
      if (entry.fresh && !entry.saved) {
        S.ws.items = S.ws.items.filter(x => x !== it);
        return;
      }
      it.deleted = true;
      it.updatedAt = Date.now();
    } else if (it && !it.deleted && entry.fresh && entry.focus) {
      setFocus(it.id, true);
    }
    persistWs();
  }

  function renderItemEditor() {
    const entry = S.itemStack[S.itemStack.length - 1];
    const it = entry ? itemById(entry.id) : null;
    const body = $('#it-body');
    $('#it-confirm').hidden = true;
    if (!it || it.deleted) { body.replaceChildren(); return; }
    $('#it-kind').textContent = KIND_LABEL[it.kind];
    $('#it-confirm-text').textContent = '이 ' + KIND_OBJ[it.kind] + ' 삭제할까요?';
    body.replaceChildren(...(it.kind === 'task' ? taskForm(it, entry) : it.kind === 'goal' ? goalForm(it, entry) : projectForm(it, entry)).filter(Boolean));
    body.scrollTop = 0;
    if (entry.fresh && !it.title) setTimeout(() => { const t = $('#it-title'); if (t && !$('#item-ed').hidden) t.focus(); }, 60);
  }

  const field = (label, ...controls) => h('div', { class: 'it-field' }, h('span', { class: 'lbl', text: label }), controls);

  function titleInput(it, entry, placeholder) {
    const input = h('input', { id: 'it-title', class: 'ed-title', type: 'text', placeholder, maxlength: '200', autocomplete: 'off', enterkeyhint: 'done' });
    input.value = it.title || '';
    input.addEventListener('input', () => {
      const v = input.value.slice(0, 200);
      if (v.trim()) entry.saved = true;
      touchItem(it.id, x => { x.title = v; }, true);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); input.blur(); } });
    return input;
  }

  // segmented control / pills: one value (or none when clearable and tapped again)
  function seg(opts, value, onPick, cls, clearable) {
    let cur = value;
    const box = h('div', { class: cls || 'seg', role: 'group' });
    const paint = () => { for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset.v === cur)); };
    for (const [v, label] of opts) {
      box.append(h('button', { type: 'button', 'data-v': v, onclick: () => { cur = clearable && cur === v ? null : v; paint(); onPick(cur); } }, label));
    }
    paint();
    return box;
  }

  function toggle(on, onChange, label) {
    const b = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': label });
    b.addEventListener('click', () => { on = !on; b.setAttribute('aria-checked', String(on)); onChange(on); });
    return b;
  }

  function picker(opts, value, onChange, label) {
    const sel = h('select', { class: 'field select', 'aria-label': label }, opts.map(([v, text]) => h('option', { value: v, text })));
    sel.value = opts.some(o => o[0] === value) ? value : ''; // a missing or deleted item shows as "없음"
    sel.addEventListener('change', () => onChange(sel.value || null));
    return sel;
  }

  function dateField(value, onChange, emptyText, label) {
    const text = h('span', null);
    const input = h('input', { type: 'date', 'aria-label': label });
    const clear = h('button', { type: 'button', class: 'text-btn small', text: '지우기' });
    const paint = v => { const d = parseYmd(v); text.textContent = d ? chipDay(d) : emptyText; input.value = d ? v : ''; clear.hidden = !d; };
    input.addEventListener('change', () => { const v = DATE_RE.test(input.value) ? input.value : null; onChange(v); paint(v); });
    clear.addEventListener('click', () => { onChange(null); paint(null); });
    paint(value);
    return h('div', { class: 'ed-date' }, h('label', { class: 'date-chip' }, icon('cal'), text, input), clear);
  }

  function taskForm(t, entry) {
    const projects = liveItems('project').filter(p => ['active', 'preparing'].includes(p.status) || p.id === t.projectId);
    return [
      h('div', { class: 'it-head' }, checkBtn(t, 'big'), titleInput(t, entry, '할 일')),
      field('목록', seg(TASK_LISTS, t.status, v => touchItem(t.id, x => { x.status = v; x.completedAt = null; }))),
      h('div', { class: 'it-line' }, h('span', { text: '오늘 할 일' }),
        toggle(entry.fresh ? !!entry.focus : inFocus(t.id), on => { if (entry.fresh) entry.focus = on; else setFocus(t.id, on); }, '오늘 할 일')),
      field('프로젝트', picker([['', '없음']].concat(projects.map(p => [p.id, itemTitle(p)])), t.projectId, v => touchItem(t.id, x => { x.projectId = v; }), '프로젝트')),
      field('마감일', dateField(t.dueDate, v => touchItem(t.id, x => { x.dueDate = v; }), '마감일 없음', '마감일')),
      field('예정일', dateField(t.plannedDate, v => touchItem(t.id, x => { x.plannedDate = v; }), '예정일 없음', '예정일')),
    ];
  }

  function goalForm(g, entry) {
    const area = h('textarea', { class: 'field area', rows: '3', placeholder: '이 목표를 이루면 무엇이 달라지나요?', 'aria-label': '원하는 결과' });
    area.value = typeof g.desiredResult === 'string' ? g.desiredResult : '';
    area.addEventListener('input', () => touchItem(g.id, x => { x.desiredResult = area.value.slice(0, 2000) || null; }, true));
    const projects = liveItems('project').filter(p => p.parentId === g.id);
    return [
      titleInput(g, entry, '목표'),
      field('구분', seg(HORIZON_SEG, g.horizon, v => touchItem(g.id, x => { x.horizon = v; }))),
      field('상태', seg(GOAL_STATUS, g.status, v => touchItem(g.id, x => { x.status = v; }))),
      field('원하는 결과', area),
      field('기한', dateField(g.dueDate, v => touchItem(g.id, x => { x.dueDate = v; }), '기한 없음', '기한')),
      projects.length ? field('연결된 프로젝트 ' + projects.length, h('div', { class: 'mini-list' }, projects.map(p =>
        h('button', { type: 'button', class: 'mini-row' + catClass(p.category), onclick: () => openItem(p.id, false) },
          h('span', { class: 'cdot' }), h('span', { class: 'mt', text: itemTitle(p) }),
          h('span', { class: 'mm', text: PROJECT_GROUPS.find(x => x[0] === projStatus(p))[1] }))))) : null,
    ];
  }

  function projectForm(p, entry) {
    const goals = liveItems('goal');
    const tasks = liveItems('task').filter(t => t.projectId === p.id)
      .sort((a, b) => (a.status === 'done') - (b.status === 'done') || a.createdAt - b.createdAt);
    return [
      titleInput(p, entry, '프로젝트'),
      field('상태', seg(PROJECT_SEG, p.status, v => touchItem(p.id, x => { x.status = v; }))),
      field('분류', seg(CATEGORIES.map(([v, l]) => [v, [h('span', { class: 'cdot cat-' + v }), l]]), p.category,
        v => touchItem(p.id, x => { x.category = v; }), 'pills', true)),
      field('목표', picker([['', '없음']].concat(goals.map(g => [g.id, itemTitle(g)])), p.parentId, v => touchItem(p.id, x => { x.parentId = v; }), '목표')),
      field('기한', dateField(p.dueDate, v => touchItem(p.id, x => { x.dueDate = v; }), '기한 없음', '기한')),
      field('할 일 ' + tasks.length, h('div', { class: 'mini-list tasks' }, tasks.map(t => taskRow(t, { noProject: true })),
        h('button', { type: 'button', class: 'add-task', onclick: () => { if ((p.title || '').trim()) newItem('task', { projectId: p.id }); else toast('프로젝트 이름을 먼저 적어 주세요'); } },
          icon('plus'), h('span', { text: '할 일' })))),
    ];
  }

  $('#it-close').addEventListener('click', closeSheetUi);
  $('#it-delete').addEventListener('click', () => { $('#it-confirm').hidden = false; });
  $('#it-confirm-no').addEventListener('click', () => { $('#it-confirm').hidden = true; });
  $('#it-confirm-yes').addEventListener('click', () => {
    const entry = S.itemStack[S.itemStack.length - 1];
    const it = entry && itemById(entry.id);
    if (it && entry.fresh && !entry.saved) {
      it.title = ''; // never saved: closing drops it
    } else if (it) {
      touchItem(it.id, x => { x.deleted = true; x.title = ''; if (x.desiredResult != null) x.desiredResult = null; });
    }
    closeSheetUi();
    if (it) toast(KIND_OBJ[it.kind] + ' 삭제했어요');
  });

  // ------------------------------------------------------------------ settings
  function openSettings() {
    S.confirmWipe = false;
    renderSettings();
    openSheet('settings');
    if (native) updateBriefing({ type: 'briefing:get' });
  }

  async function updateBriefing(msg) {
    if (briefingBusy) return;
    briefingBusy = true; renderSettings();
    const result = await nativeRequest(msg);
    if (result.type === 'briefing' && typeof result.enabled === 'boolean' && Number.isInteger(result.intervalHours) &&
        result.intervalHours >= 1 && result.intervalHours <= 24 && Number.isInteger(result.quietStart) && result.quietStart >= 0 &&
        result.quietStart <= 23 && Number.isInteger(result.quietEnd) && result.quietEnd >= 0 && result.quietEnd <= 23) {
      briefing = result;
      briefingMessage = msg.type === 'briefing:set' ? '브리핑 설정을 저장했어요.' : '';
    } else if (msg.type === 'briefing:test' && typeof result.ok === 'boolean') {
      briefingMessage = typeof result.message === 'string' ? result.message : '브리핑 테스트를 마쳤어요.';
    } else briefingMessage = result.message || '브리핑 설정을 불러오지 못했어요.';
    briefingBusy = false;
    if (!$('#settings').hidden) renderSettings();
    if (msg.type === 'briefing:test' && result.ok) {
      const message = briefingMessage;
      await updateBriefing({ type: 'briefing:get' });
      briefingMessage = message;
      if (!$('#settings').hidden) renderSettings();
    }
  }

  function briefingSection() {
    const section = h('section', { class: 'st-sec', id: 'st-briefing' }, h('h2', { text: '알림/브리핑' }));
    if (briefing) {
      const b = briefing;
      const enabled = h('input', { id: 'briefing-enabled', type: 'checkbox', disabled: briefingBusy }); enabled.checked = b.enabled;
      section.append(h('label', { class: 'st-line', for: 'briefing-enabled' }, h('span', { class: 'k', text: '정기 브리핑' }), enabled));
      const select = (id, label, count, start, current, suffix) => {
        const input = h('select', { id, class: 'field', disabled: briefingBusy },
          Array.from({ length: count }, (_, n) => h('option', { value: n + start, text: (n + start) + suffix })));
        input.value = String(current);
        section.append(h('label', { for: id, text: label }), input);
        return input;
      };
      const interval = select('briefing-interval', '알림 간격', 24, 1, b.intervalHours, '시간');
      const start = select('briefing-start', '조용한 시간 시작', 24, 0, b.quietStart, '시');
      const end = select('briefing-end', '조용한 시간 끝', 24, 0, b.quietEnd, '시');
      section.append(h('p', { text: '조용한 시간에는 알리지 않아요. 시작과 끝을 같게 하면 종일 알림을 받아요. 온라인일 때 주기 안에서 실행돼요.' }),
        h('div', { class: 'st-line' }, h('span', { class: 'k', text: '알림 권한' }), h('span', { class: 'v', id: 'briefing-permission', text: b.notifications === false ? '꺼짐 · 휴대폰 설정에서 MyPlanner 알림을 허용해 주세요' : '허용됨' })),
        h('div', { class: 'st-line' }, h('span', { class: 'k', text: '마지막 알림' }), h('span', { class: 'v', id: 'briefing-last', text: Number.isFinite(b.last) && b.last > 0 ? new Date(b.last).toLocaleString('ko-KR') : '아직 없음' })),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn outline', id: 'briefing-save', disabled: briefingBusy, text: '브리핑 설정 저장', onclick: () => updateBriefing({ type: 'briefing:set', enabled: enabled.checked, intervalHours: +interval.value, quietStart: +start.value, quietEnd: +end.value }) }),
          h('button', { type: 'button', class: 'btn outline', id: 'briefing-test', disabled: briefingBusy, text: '테스트 알림', onclick: () => updateBriefing({ type: 'briefing:test' }) })));
    }
    section.append(h('p', { id: 'briefing-status', role: 'status', text: briefingBusy ? '앱에서 확인하는 중이에요…' : briefingMessage || '오늘 남은 일정과 할 일을 알려 드려요.' }),
      h('button', { type: 'button', class: 'btn outline', id: 'briefing-refresh', disabled: briefingBusy, text: '알림 상태 새로고침', onclick: () => updateBriefing({ type: 'briefing:get' }) }));
    return section;
  }

  function renderSettings() {
    const box = $('#st-body');
    const id = clientId();
    const sections = [];

    let status;
    if (!native && !id) status = '연결 준비 전 (웹 클라이언트 ID 필요)';
    else if (tokenValid()) status = '연결됨 · ' + [S.canCal ? '일정 읽기' : '', S.canDrive ? '메모·할 일 동기화' : ''].filter(Boolean).join(' · ');
    else if (prefs.connected) status = native ? '다시 연결이 필요해요. 아래에서 Google 계정을 확인해 주세요.' : '다시 연결이 필요해요 (보안을 위해 1시간마다 확인해요)';
    else status = '연결 안 됨';
    const acct = h('section', { class: 'st-sec' }, h('h2', { text: 'GOOGLE 계정' }),
      h('div', { class: 'st-line' }, h('span', { class: 'k', text: '상태' }), h('span', { class: 'v', text: status })));
    const btns = h('div', { class: 'btn-row' });
    if ((native || id) && !tokenValid()) btns.append(h('button', { type: 'button', class: 'btn primary', onclick: connect, text: prefs.connected ? '다시 연결' : 'Google로 연결' }));
    if (prefs.connected) btns.append(h('button', { type: 'button', class: 'btn outline', onclick: disconnect, text: '연결 해제' }));
    if (btns.childNodes.length) acct.append(btns);
    acct.append(h('p', { text: '일정은 읽기만 해요. 메모와 할 일·목표는 내 Google 드라이브의 앱 전용 숨김 폴더에 저장되고, 메모는 드라이브에서도 볼 수 있게 MyPlanner 폴더에 사본 문서를 만들어요.' }));
    sections.push(acct);

    const syncSec = h('section', { class: 'st-sec' }, h('h2', { text: '동기화' }),
      h('div', { class: 'st-line' }, h('span', { class: 'k', text: '저장 위치' }), h('span', { class: 'v', text: S.canDrive && tokenValid() ? 'Google 드라이브 + 이 폰 (메모, 할 일·목표)' : '이 폰 (연결하면 드라이브와 동기화)' })),
      h('div', { class: 'st-line' }, h('span', { class: 'k', text: '마지막 동기화' }), h('span', { class: 'v', text: S.lastSync ? ago(S.lastSync) : '아직 없음' })));
    if (prefs.connected) {
      const copyOn = tokenValid() ? S.canDrive && S.canCopy : !!prefs.copy;
      syncSec.append(h('div', { class: 'st-line', id: 'st-copy' }, h('span', { class: 'k', text: '드라이브에서 보기' }),
        h('span', { class: 'v', text: copyOn ? '켜짐' : '꺼짐 — 다시 연결하면 켜져요' })));
      if (copyOn) {
        syncSec.append(h('p', { text: "드라이브의 MyPlanner 폴더에 '메모' 문서로 보여요. 문서에서 고친 내용은 앱에 반영되지 않아요." }));
        const doc = driveId(prefs.docId);
        if (doc) {
          syncSec.append(h('div', { class: 'btn-row' }, h('a', {
            class: 'btn outline', id: 'st-doc', href: 'https://docs.google.com/document/d/' + doc + '/edit', target: '_blank', rel: 'noopener noreferrer',
          }, icon('ext'), '드라이브에서 열기')));
        }
      } else if (tokenValid()) {
        syncSec.append(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn outline', onclick: () => requestToken('consent'), text: '다시 연결' })));
      }
    }
    if (S.sync === 'error' && S.syncMsg) syncSec.append(h('p', { text: S.syncMsg }));
    syncSec.append(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn outline', disabled: !tokenValid(), onclick: syncAll, text: '지금 동기화' }),
      h('button', { type: 'button', class: 'btn outline', onclick: exportNotes, text: '메모 내보내기 (JSON)' }),
      h('button', { type: 'button', class: 'btn outline', onclick: exportWorkspace, text: '할 일·목표 내보내기 (JSON)' })));
    sections.push(syncSec);
    if (native) sections.push(briefingSection());

    const field = h('input', { id: 'st-client', class: 'field', type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: '1234567890-xxxx.apps.googleusercontent.com' });
    field.value = prefs.clientId || '';
    const cidSec = h('section', { class: 'st-sec' }, h('h2', { text: '웹 클라이언트 ID' }),
      h('p', { text: DEFAULT_CLIENT_ID ? '기본 ID가 들어 있어요. 다른 ID를 쓰려면 아래에 넣으세요.' : 'Google 연결에 쓰는 공개 ID예요 (비밀번호가 아니에요). 한 번만 만들면 됩니다.' }),
      h('ol', { class: 'steps' },
        h('li', null, 'Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보'),
        h('li', null, '사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 유형 "웹 애플리케이션"'),
        h('li', null, '승인된 JavaScript 원본에 ', h('code', { text: location.origin.startsWith('https://') ? location.origin : 'https://anewbyeol.kr' }), ' 추가'),
        h('li', null, '라이브러리에서 Google Calendar API와 Google Drive API 사용 설정'),
        h('li', null, '만든 클라이언트 ID를 아래에 붙여 넣고 저장')),
      field,
      h('div', { class: 'btn-row' }, h('button', {
        type: 'button', class: 'btn outline', text: '저장',
        onclick: () => {
          const v = field.value.trim();
          if (v && !CLIENT_ID_RE.test(v)) { toast('클라이언트 ID 형식이 아니에요. "...apps.googleusercontent.com"으로 끝나야 해요.'); return; }
          prefs.clientId = v;
          savePrefs();
          tokenClient = null;
          if (clientId()) { loadGis(); initTokenClient(); }
          toast(v ? '저장했어요. 이제 Google로 연결할 수 있어요.' : '기본값으로 되돌렸어요.');
          renderSettings();
        },
      })));
    if (!native) sections.push(cidSec);

    const wipe = h('section', { class: 'st-sec' }, h('h2', { text: '이 기기' }));
    if (!S.confirmWipe) {
      wipe.append(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn danger', text: '이 기기에서 지우기', onclick: () => { S.confirmWipe = true; renderSettings(); } })));
    } else {
      const count = liveNotes().length, items = S.ws.items.filter(i => !i.deleted && keepItem(i)).length;
      wipe.append(h('div', { class: 'st-confirm' },
        h('span', { text: '이 폰에 저장된 메모 ' + count + '개, 할 일·목표 ' + items + '개와 일정 캐시를 지워요. ' + (S.dirty || S.wsDirty || !S.canDrive ? '드라이브에 동기화되지 않은 내용은 되살릴 수 없어요.' : '드라이브에 있는 내용은 다시 연결하면 돌아와요.') }),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'pill danger', text: '지우기', onclick: wipeDevice }),
          h('button', { type: 'button', class: 'pill', text: '취소', onclick: () => { S.confirmWipe = false; renderSettings(); } }))));
    }
    sections.push(wipe);
    box.replaceChildren(...sections);
  }

  function exportNotes() { saveJson(notesDoc(), 'my-calendar-notes-'); }
  function exportWorkspace() { saveJson(wsDoc(), 'my-calendar-workspace-'); }

  function saveJson(doc, prefix) {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: prefix + ymd(new Date()).replace(/-/g, '') + '.json' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function wipeDevice() {
    revokeToken();
    for (const k of Object.values(K)) local.remove(k);
    prefs.clientId = ''; prefs.connected = false; prefs.copy = false; prefs.docId = '';
    S.notes = []; S.events = []; S.eventsRange = null; S.token = null; S.tokenExp = 0;
    S.canCal = false; S.canDrive = false; S.canCopy = false; S.fileId = null; S.remoteDoc = null;
    S.ws = { items: [], plans: [] }; S.wsFileId = null; S.wsDoc = null; S.wsDirty = false; S.prevStatus = {};
    S.dirty = false; S.lastSync = 0; S.confirmWipe = false;
    tokenClient = null;
    setSync('idle');
    closeSheetUi();
    toast('이 기기의 데이터를 지웠어요');
  }

  // ------------------------------------------------------------------ tabs, buttons, clock
  const VIEWS = { cal: '#view-cal', tasks: '#view-tasks', goals: '#view-goals', notes: '#view-notes' };

  function setTab(tab) {
    S.tab = VIEWS[tab] ? tab : 'cal';
    for (const k of Object.keys(VIEWS)) $(VIEWS[k]).hidden = k !== S.tab;
    for (const b of document.querySelectorAll('.tab')) {
      if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    updateFab();
    window.scrollTo(0, 0);
    render();
  }

  // the + button adds the thing of the current tab
  function updateFab() {
    $('#fab').setAttribute('aria-label', S.tab === 'tasks' ? '할 일 추가' : S.tab === 'goals' ? (S.goalSeg === 'projects' ? '프로젝트 추가' : '목표 추가') : '메모 쓰기');
  }

  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('#fab').addEventListener('click', () => {
    if (S.tab === 'tasks') newItem('task', null, { focus: true }); // lands in 오늘
    else if (S.tab === 'goals') newItem(S.goalSeg === 'projects' ? 'project' : 'goal');
    else newNote(ymd(S.tab === 'cal' ? S.sel : startOfDay(new Date())));
  });
  $('#open-settings').addEventListener('click', openSettings);
  $('#st-close').addEventListener('click', closeSheetUi);
  $('#sync').addEventListener('click', () => {
    if (prefs.connected && !tokenValid()) connect();
    else if (tokenValid()) syncAll();
  });

  function tick() {
    const prev = S.now;
    S.now = new Date();
    if (!sameDay(prev, S.now) && sameDay(S.sel, prev)) S.sel = startOfDay(S.now);
    if (S.tab === 'cal') renderCal();
    else if (!sameDay(prev, S.now)) refreshViews(); // "오늘" and D-n move at midnight
    setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    S.now = new Date();
    refreshViews();
    if (native && prefs.connected && !tokenValid()) nativeToken(false).then(ok => { if (ok) syncAll(); });
    else if (tokenValid() && Date.now() - S.lastSync > 60000) syncAll();
    if (native && !$('#settings').hidden) updateBriefing({ type: 'briefing:get' });
  });

  // a reload keeps history.state; without this, closing the next sheet would go back to the previous site
  if (history.state && history.state.sheet) history.replaceState(null, '');
  // deep links: #notes / #tasks / #goals open that tab, #new starts a note for today (home-screen shortcut)
  function followHash() {
    const tab = { '#notes': 'notes', '#tasks': 'tasks', '#goals': 'goals' }[location.hash];
    if (tab) setTab(tab);
    else if (location.hash === '#new') {
      history.replaceState(null, '', location.pathname + location.search);
      if ($('#editor').hidden) newNote(ymd(startOfDay(new Date())));
    }
  }
  window.addEventListener('hashchange', followHash);

  render();
  followHash();
  setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  if (native) nativeToken(false).then(ok => { if (ok) syncAll(); });
  else if (clientId()) loadGis();
})();
