/*
 * MY CALENDAR mobile (anewbyeol.kr/schedule): the phone companion of OrcaCalendar.
 * A static page with no server and no secrets.
 * - Google Calendar is read with GET requests only (calendar.calendarlist.readonly + calendar.events.readonly).
 * - Notes are saved on this device first and, once connected, in the user's own Google Drive app-data folder
 *   (drive.appdata: a hidden folder that only this app's client can see), so every device shows the same notes.
 * - The access token lives in memory only. The OAuth web client ID is public by design.
 * - All text from Google or from notes is inserted with textContent, never as HTML.
 */
'use strict';
(() => {
  // Web OAuth client ID ("....apps.googleusercontent.com"). Empty: notes stay on this device until one is set
  // here or in Settings (the Settings value is kept on that device only).
  const DEFAULT_CLIENT_ID = '';

  const SCOPE_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';
  const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.appdata';
  const CAL = 'https://www.googleapis.com/calendar/v3';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const NOTES_FILE = 'my-calendar-notes.json';
  const K = { notes: 'mc.notes.v1', events: 'mc.events.v1', prefs: 'mc.prefs.v1' };
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
    sync: 'idle', // idle | busy | ok | error | reconnect
    syncMsg: '',
    lastSync: 0,
    fileId: null,
    dirty: false,
    query: '',
    editing: null,
    editingFresh: false,
    confirmWipe: false,
  };
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
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
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
    if (S.tab === 'cal') renderCal(); else renderNotes();
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
    return h('button', {
      type: 'button', class: 'row' + (past ? ' past' : ''),
      onclick: () => {
        if (e.l) window.open(e.l, '_blank', 'noopener');
        else toast(e.t);
      },
    },
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

    // the selected day: events, then its notes, then "write a note for this day"
    const sel = S.sel, isToday = sameDay(sel, today);
    const selEvents = eventsOn(sel), selNotes = notesOn(sel);
    const day = h('section', { class: 'list' }, listHead(isToday ? '오늘' : chipDay(sel), haveCalendar() ? selEvents.length : null, selNotes.length ? '메모 ' + selNotes.length : null));
    for (const e of selEvents) {
      const lead = e.a ? '종일' : e.s < +startOfDay(sel) ? '계속' : hm(new Date(e.s));
      day.append(eventRow(e, lead, { dimPast: isToday, live: isToday }));
    }
    for (const n of selNotes) day.append(noteRow(n));
    if (!selEvents.length && !selNotes.length) day.append(h('div', { class: 'empty-row', text: haveCalendar() ? '일정과 메모가 없어요' : '이 날의 메모가 없어요' }));
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
      h('p', { text: '일정은 읽기만 해요. 메모는 내 Google 드라이브의 앱 전용 숨김 폴더에 저장돼 PC와 다른 폰에서도 보여요.' }),
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
    else if (prefs.connected && !tokenValid()) { text = S.dirty ? '다시 연결 · 저장 대기' : '다시 연결'; cls += ' warn'; }
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
  function loadGis() {
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
    const id = clientId();
    if (!id || !window.google || !google.accounts || !google.accounts.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: [SCOPE_LIST, SCOPE_EVENTS, SCOPE_DRIVE].join(' '),
      include_granted_scopes: true,
      callback: onToken,
      error_callback: err => {
        setSync(prefs.connected ? 'reconnect' : 'idle');
        if (err && err.type === 'popup_failed_to_open') toast('팝업이 막혔어요. 브라우저에서 이 사이트의 팝업을 허용해 주세요.');
      },
    });
  }

  function connect() {
    if (!clientId()) { openSettings(); return; }
    if (!tokenClient) {
      initTokenClient();
      if (!tokenClient) { loadGis(); toast('Google 로그인을 불러오는 중이에요. 잠시 후 다시 눌러 주세요.'); return; }
    }
    tokenClient.requestAccessToken({ prompt: prefs.connected ? '' : 'consent' });
  }

  function onToken(resp) {
    if (!resp || resp.error || !resp.access_token) {
      setSync(prefs.connected ? 'reconnect' : 'idle');
      if (resp && resp.error && resp.error !== 'access_denied') toast('Google 연결에 실패했어요. 다시 시도해 주세요.');
      return;
    }
    S.token = resp.access_token;
    S.tokenExp = Date.now() + Math.max(120, (+resp.expires_in || 3600) - 120) * 1000;
    const o = google.accounts.oauth2;
    S.canCal = o.hasGrantedAllScopes(resp, SCOPE_LIST, SCOPE_EVENTS);
    S.canDrive = o.hasGrantedAllScopes(resp, SCOPE_DRIVE);
    prefs.connected = true;
    savePrefs();
    if (!S.canCal && !S.canDrive) toast('권한을 받지 못해 연결하지 않았어요.');
    else if (!S.canDrive) toast('드라이브 권한이 없어 메모는 이 폰에만 저장돼요.');
    else if (!S.canCal) toast('일정 읽기 권한이 없어 일정은 보이지 않아요.');
    syncAll();
  }

  function disconnect() {
    if (S.token && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(S.token, () => {});
    S.token = null; S.tokenExp = 0; S.canCal = false; S.canDrive = false;
    S.events = []; S.eventsRange = null; S.fileId = null; S.lastSync = 0;
    prefs.connected = false;
    savePrefs();
    local.remove(K.events);
    setSync('idle');
    render();
    toast('연결을 해제했어요. 메모는 이 폰에 남아 있어요.');
  }

  class AuthNeeded extends Error {}

  async function api(url, opts) {
    if (!tokenValid()) { S.token = null; throw new AuthNeeded('token'); }
    const o = Object.assign({}, opts || {});
    o.headers = Object.assign({ Authorization: 'Bearer ' + S.token }, (opts && opts.headers) || {});
    const r = await fetch(url, o);
    if (r.status === 401) { S.token = null; throw new AuthNeeded('expired'); }
    if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; throw err; }
    return r;
  }

  function failText(err) {
    if (err instanceof TypeError) return '인터넷 연결을 확인해 주세요.';
    if (err.status === 403) return 'Google에서 거부했어요. 클라이언트 설정에서 Calendar·Drive API가 켜져 있는지 확인해 주세요.';
    if (err.status === 429) return '요청이 많아요. 잠시 후 다시 시도해 주세요.';
    return '동기화하지 못했어요 (' + (err.status || '오류') + ').';
  }

  function handleFailure(err) {
    if (err instanceof AuthNeeded) setSync('reconnect');
    else setSync('error', failText(err));
  }

  async function syncAll() {
    setSync('busy');
    try {
      await Promise.all([loadEvents(true, true), syncNotes(true)]);
      S.lastSync = Date.now();
      setSync('ok');
    } catch (err) {
      handleFailure(err);
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
  function safeLink(u) {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && (url.hostname === 'www.google.com' || url.hostname === 'calendar.google.com') ? url.href : null;
    } catch (e) { return null; }
  }

  async function fetchEvents(cal, s, e) {
    const out = [];
    let page = '';
    for (let i = 0; i < 10; i++) {
      const url = CAL + '/calendars/' + enc(cal.id) + '/events?singleEvents=true&orderBy=startTime&maxResults=250' +
        '&timeMin=' + enc(new Date(s).toISOString()) + '&timeMax=' + enc(new Date(e).toISOString()) +
        '&fields=' + enc('items(id,status,summary,start,end,htmlLink,attendees(self,responseStatus)),nextPageToken') +
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
        out.push({
          k: cal.id + '|' + ev.id,
          t: String(ev.summary || '(제목 없음)').slice(0, 300),
          s: +st,
          e: Math.max(end, +st),
          a: allDay,
          c: safeColor(cal.backgroundColor),
          l: safeLink(ev.htmlLink),
        });
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

  function mergeNotes(a, b) {
    const map = new Map();
    for (const n of a.concat(b)) {
      if (!validNote(n)) continue;
      const cur = map.get(n.id);
      if (!cur || n.updatedAt > cur.updatedAt || (n.updatedAt === cur.updatedAt && n.deleted && !cur.deleted)) map.set(n.id, n);
    }
    const cutoff = Date.now() - 60 * DAY; // forget deletions after 60 days
    return Array.from(map.values()).filter(n => !(n.deleted && n.updatedAt < cutoff));
  }

  const signature = list => JSON.stringify(list.filter(hasContent).map(n => [n.id, n.updatedAt, !!n.deleted]).sort());

  async function findNotesFile() {
    const url = DRIVE + '/files?spaces=appDataFolder&orderBy=createdTime&pageSize=10&fields=' + enc('files(id)') +
      '&q=' + enc("name = '" + NOTES_FILE + "' and trashed = false");
    const j = await (await api(url)).json();
    return j.files && j.files.length ? j.files[0].id : null;
  }

  function notesDoc() {
    return { app: 'my-calendar', kind: 'notes', version: 1, savedAt: Date.now(), notes: S.notes.filter(hasContent) };
  }

  async function uploadNotes() {
    const body = JSON.stringify(notesDoc());
    if (S.fileId) {
      await api(UPLOAD + '/files/' + enc(S.fileId) + '?uploadType=media&fields=id', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body,
      });
      return;
    }
    const boundary = 'mc' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: NOTES_FILE, parents: ['appDataFolder'], mimeType: 'application/json' });
    const multipart = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta +
      '\r\n--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + body + '\r\n--' + boundary + '--';
    const r = await api(UPLOAD + '/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart,
    });
    S.fileId = (await r.json()).id;
  }

  async function syncNotes(rethrow) {
    if (!S.canDrive || !tokenValid()) return;
    if (notesBusy) { notesAgain = true; return; }
    notesBusy = true;
    const standalone = !rethrow;
    if (standalone) setSync('busy');
    try {
      if (!S.fileId) S.fileId = await findNotesFile();
      let remote = [];
      if (S.fileId) {
        const doc = await (await api(DRIVE + '/files/' + enc(S.fileId) + '?alt=media')).json().catch(() => null);
        remote = doc && Array.isArray(doc.notes) ? doc.notes.filter(validNote) : [];
      }
      // merge with the notes as they are now (edits made while downloading are included)
      const before = signature(S.notes);
      const merged = mergeNotes(S.notes, remote);
      if (signature(merged) !== before) {
        S.notes = merged;
        local.set(K.notes, S.notes.filter(hasContent));
        refreshViews();
      }
      if (!S.fileId || signature(merged) !== signature(remote)) await uploadNotes();
      S.dirty = false;
      if (standalone) { S.lastSync = Date.now(); setSync('ok'); }
    } catch (err) {
      if (rethrow) throw err;
      handleFailure(err);
    } finally {
      notesBusy = false;
      if (notesAgain) { notesAgain = false; syncNotes(false); }
    }
  }

  // re-render what is visible without disturbing an open editor or the search box
  function refreshViews() {
    renderSync();
    if (S.tab === 'cal') renderCal(); else renderNoteList();
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

  function hideSheets() {
    if (!$('#editor').hidden) finishEditing();
    $('#editor').hidden = true;
    $('#settings').hidden = true;
    S.confirmWipe = false;
    document.body.style.overflow = '';
    render();
  }

  window.addEventListener('popstate', () => {
    if (!$('#editor').hidden || !$('#settings').hidden) hideSheets();
  });

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

  // ------------------------------------------------------------------ settings
  function openSettings() {
    S.confirmWipe = false;
    renderSettings();
    openSheet('settings');
  }

  function renderSettings() {
    const box = $('#st-body');
    const id = clientId();
    const sections = [];

    let status;
    if (!id) status = '연결 준비 전 (웹 클라이언트 ID 필요)';
    else if (tokenValid()) status = '연결됨 · ' + [S.canCal ? '일정 읽기' : '', S.canDrive ? '메모 동기화' : ''].filter(Boolean).join(' · ');
    else if (prefs.connected) status = '다시 연결이 필요해요 (보안을 위해 1시간마다 확인해요)';
    else status = '연결 안 됨';
    const acct = h('section', { class: 'st-sec' }, h('h2', { text: 'GOOGLE 계정' }),
      h('div', { class: 'st-line' }, h('span', { class: 'k', text: '상태' }), h('span', { class: 'v', text: status })));
    const btns = h('div', { class: 'btn-row' });
    if (id && !tokenValid()) btns.append(h('button', { type: 'button', class: 'btn primary', onclick: connect, text: prefs.connected ? '다시 연결' : 'Google로 연결' }));
    if (prefs.connected) btns.append(h('button', { type: 'button', class: 'btn outline', onclick: disconnect, text: '연결 해제' }));
    if (btns.childNodes.length) acct.append(btns);
    acct.append(h('p', { text: '일정은 읽기만 해요. 메모는 내 Google 드라이브의 앱 전용 숨김 폴더에 저장되고, 이 앱 말고는 볼 수 없어요.' }));
    sections.push(acct);

    const syncSec = h('section', { class: 'st-sec' }, h('h2', { text: '메모 저장' }),
      h('div', { class: 'st-line' }, h('span', { class: 'k', text: '저장 위치' }), h('span', { class: 'v', text: S.canDrive && tokenValid() ? 'Google 드라이브 + 이 폰' : '이 폰 (연결하면 드라이브와 동기화)' })),
      h('div', { class: 'st-line' }, h('span', { class: 'k', text: '마지막 동기화' }), h('span', { class: 'v', text: S.lastSync ? ago(S.lastSync) : '아직 없음' })));
    if (S.sync === 'error' && S.syncMsg) syncSec.append(h('p', { text: S.syncMsg }));
    syncSec.append(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn outline', disabled: !tokenValid(), onclick: syncAll, text: '지금 동기화' }),
      h('button', { type: 'button', class: 'btn outline', onclick: exportNotes, text: '메모 내보내기 (JSON)' })));
    sections.push(syncSec);

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
    sections.push(cidSec);

    const wipe = h('section', { class: 'st-sec' }, h('h2', { text: '이 기기' }));
    if (!S.confirmWipe) {
      wipe.append(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn danger', text: '이 기기에서 지우기', onclick: () => { S.confirmWipe = true; renderSettings(); } })));
    } else {
      const count = liveNotes().length;
      wipe.append(h('div', { class: 'st-confirm' },
        h('span', { text: '이 폰에 저장된 메모 ' + count + '개와 일정 캐시를 지워요. ' + (S.dirty || !S.canDrive ? '드라이브에 동기화되지 않은 메모는 되살릴 수 없어요.' : '드라이브에 있는 메모는 다시 연결하면 돌아와요.') }),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'pill danger', text: '지우기', onclick: wipeDevice }),
          h('button', { type: 'button', class: 'pill', text: '취소', onclick: () => { S.confirmWipe = false; renderSettings(); } }))));
    }
    sections.push(wipe);
    box.replaceChildren(...sections);
  }

  function exportNotes() {
    const blob = new Blob([JSON.stringify(notesDoc(), null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'my-calendar-notes-' + ymd(new Date()).replace(/-/g, '') + '.json' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function wipeDevice() {
    if (S.token && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(S.token, () => {});
    for (const k of Object.values(K)) local.remove(k);
    prefs.clientId = ''; prefs.connected = false;
    S.notes = []; S.events = []; S.eventsRange = null; S.token = null; S.tokenExp = 0;
    S.canCal = false; S.canDrive = false; S.fileId = null; S.dirty = false; S.lastSync = 0; S.confirmWipe = false;
    tokenClient = null;
    setSync('idle');
    closeSheetUi();
    toast('이 기기의 데이터를 지웠어요');
  }

  // ------------------------------------------------------------------ tabs, buttons, clock
  function setTab(tab) {
    S.tab = tab;
    $('#view-cal').hidden = tab !== 'cal';
    $('#view-notes').hidden = tab !== 'notes';
    for (const b of document.querySelectorAll('.tab')) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
    render();
  }

  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('#fab').addEventListener('click', () => newNote(ymd(S.tab === 'cal' ? S.sel : startOfDay(new Date()))));
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
    setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    S.now = new Date();
    refreshViews();
    if (tokenValid() && Date.now() - S.lastSync > 60000) syncAll();
  });

  // a reload keeps history.state; without this, closing the next sheet would go back to the previous site
  if (history.state && history.state.sheet) history.replaceState(null, '');
  // deep links: #notes opens the notes tab, #new starts a note for today (home-screen shortcut)
  function followHash() {
    if (location.hash === '#notes') setTab('notes');
    else if (location.hash === '#new') {
      history.replaceState(null, '', location.pathname + location.search);
      if ($('#editor').hidden) newNote(ymd(startOfDay(new Date())));
    }
  }
  window.addEventListener('hashchange', followHash);

  render();
  followHash();
  setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  if (clientId()) loadGis();
})();
