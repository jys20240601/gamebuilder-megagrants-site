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
 * - Screens follow the 2026-10-20 renewal: design A (차분한 플래너) or B (업무 대시보드), light or dark, a phone
 *   layout and a two-pane tablet layout (>= 768 px). Look choices stay on this device.
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
  const K = { notes: 'mc.notes.v1', events: 'mc.events.v1', prefs: 'mc.prefs.v1', ws: 'mc.ws.v1', look: 'mc.look.v1' };
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
  // per-device look: design A (차분한 플래너) or B (업무 대시보드), theme light / dark / system
  const look = Object.assign({ design: 'A', theme: 'system' }, local.get(K.look, {}));
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
    syncKind: '', // 'offline' when the last failure was the network
    authTried: false, // the first silent sign-in attempt finished (no reconnect banner before that)
    lastSync: 0,
    fileId: null,
    remoteDoc: null, // the notes file as last downloaded or uploaded (unknown keys are written back unchanged)
    dirty: false,
    ws: { items: [], plans: [] }, // goals, projects, tasks + daily plans
    wsFileId: null,
    wsDoc: null, // the workspace file as last downloaded or uploaded (unknown keys are written back unchanged)
    wsDirty: false,
    prevStatus: {}, // list a task had before it was completed (this session only)
    editing: null, // id of the note open in the editor (the Doc copy waits until it closes)
    // screen state
    layers: [], // pane pages, bottom to top: { kind: 'detail', ref } | { kind: 'edit', ... } | { kind: 'settings' } | { kind: 'notify' }
    arch: null, // 'tasks' | 'projects': the archive over the list column
    query: '',
    period: 'all', // today | tomorrow | week | month | all
    status: 'next', // next | plan | wait
    incl: false, // with a period: also show undated tasks
    gseg: 'goals', // goals | projects
    pseg: 'active', // preparing | active
    cf: null, // open confirm sheet
    confirmWipe: false,
    quietOpen: false,
    settingsMore: false,
    bannerClosed: '',
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
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // line icons of the renewal (stroke only); [path, viewBox]
  const ICON = {
    chev: ['m6 3.5 4.5 4.5L6 12.5', '0 0 16 16'],
    back: ['M10 3.5 5.5 8l4.5 4.5', '0 0 16 16'],
    plus: ['M8 3v10M3 8h10', '0 0 16 16'],
    tick: ['m2 5.2 2 2 4-4.4', '0 0 10 10'],
    x: ['M4.5 4.5l7 7M11.5 4.5l-7 7', '0 0 16 16'],
    search: ['M7 2.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 0 1 0-9zM10.5 10.5l3 3', '0 0 16 16'],
    cal: ['M4.5 3.5h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM2.5 6.5h11M5.5 2v2.5M10.5 2v2.5', '0 0 16 16'],
    flag: ['M4 14V2.5M4 3h7l-1.8 2.7L11 8.4H4', '0 0 16 16'],
    folder: ['M2.5 5c0-.8.6-1.5 1.4-1.5h2.5l1.4 1.5h4.3c.8 0 1.4.7 1.4 1.5v5.5c0 .8-.6 1.5-1.4 1.5H3.9c-.8 0-1.4-.7-1.4-1.5z', '0 0 16 16'],
    target: ['M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z', '0 0 16 16'],
    lines: ['M3 4.5h10M3 8h10M3 11.5h6', '0 0 16 16'],
    checkbox: ['M5.5 2.5h5a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-5a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM5.5 8.2l1.7 1.7 3.3-3.4', '0 0 16 16'],
    link: ['M6.8 9.2l2.4-2.4M7.6 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.4 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1', '0 0 16 16'],
    lock: ['M4 6h6a1.5 1.5 0 0 1 1.5 1.5V11A1.5 1.5 0 0 1 10 12.5H4A1.5 1.5 0 0 1 2.5 11V7.5A1.5 1.5 0 0 1 4 6zM4.5 6V4.5a2.5 2.5 0 0 1 5 0V6', '0 0 14 14'],
    ext: ['M5.5 3H11v5.5M11 3 3.5 10.5', '0 0 14 14'],
    phone: ['M5 2.5h6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM7 11.5h2', '0 0 16 16'],
  };
  function icon(name, cls) {
    const [d, vb] = ICON[name];
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', vb);
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }

  let toastTimer = 0;
  // action: { label, run } adds one button ("되돌리기"); undo toasts stay 5 s (spec), plain ones 3 s
  function toast(text, action) {
    const t = $('#toast');
    t.replaceChildren(h('span', { text }));
    if (action) {
      t.append(h('button', {
        type: 'button', class: 'toast-act', text: action.label,
        onclick: () => { clearTimeout(toastTimer); t.hidden = true; action.run(); },
      }));
    }
    t.classList.toggle('low', S.layers.length > 0 && !isTablet());
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 5000 : 3000);
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
  const noteTitle = n => n.title.trim() || n.body.trim().split('\n')[0] || '(제목 없음)';
  const haveCalendar = () => S.canCal || S.events.length > 0;
  const isTablet = () => window.matchMedia('(min-width: 768px)').matches;
  // ------------------------------------------------------------------ Google sign-in (token model, popup)
  let tokenClient = null;
  const native = window.MyPlannerNative && typeof window.MyPlannerNative.postMessage === 'function' ? window.MyPlannerNative : null;
  const nativeWaiters = new Map();
  let nativeSeq = 0, authEpoch = 0, nativeTokenFlight = null, tokenTimer = null;
  let briefing = null, briefingBusy = false, briefingMessage = '';
  let pushState = null, pushBusy = false, pushMessage = '';

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
    const key = msg.type === 'token' ? 'token:' + msg.id : msg.type.startsWith('briefing:') && msg.type !== 'briefing:test' ? 'briefing' : msg.type.startsWith('push:') ? 'push:state' : msg.type;
    // Non-token responses have no id. Share the pending request rather than mismatching replies.
    if (nativeWaiters.has(key)) return nativeWaiters.get(key).promise;
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const finish = m => { nativeWaiters.delete(key); resolve(m); };
    const timeout = msg.type === 'push:get' ? 8000 : msg.type === 'push:set' ? 30000 : msg.type === 'token' && msg.interactive ? 300000 : msg.type === 'briefing:test' ? 180000 : 45000;
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
    pushState = null; pushMessage = 'Google 계정을 연결한 뒤 외부 알림을 확인해 주세요.';
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
    else { S.syncKind = err instanceof TypeError ? 'offline' : ''; setSync('error', failText(err)); }
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
        enc('items(id,summary,summaryOverride,backgroundColor,selected,primary,hidden),nextPageToken') + (page ? '&pageToken=' + enc(page) : '');
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
          'hangoutLink,attachments(fileUrl,title,mimeType,fileId),attendees(self,responseStatus)),nextPageToken') +
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
          q: cal.id + '\n' + ev.id, // canonical desktop association key (cache only)
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
        // calendar name for the detail ("업무 캘린더"); the primary calendar's summary is the account address, so only
        // its user-chosen name is used. The Meet link opens only on meet.google.com.
        const name = String(cal.summaryOverride || (cal.primary ? '' : cal.summary) || '').trim();
        if (name) item.n = cap(name, 100);
        const meet = httpsLink(ev.hangoutLink, ['meet.google.com']);
        if (meet) item.m = meet;
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
    const pcObjects = isObj(n.pc) && isObj(from.pc);
    if (isObj(n.pc) && from.pc != null && !isObj(from.pc)) {
      throw newerFormat('다른 버전의 상세 정보가 있어 덮어쓸 수 없어요. 앱을 업데이트한 뒤 다시 동기화해 주세요.');
    }
    if (!extra.length && !pcObjects) return n;
    const out = Object.assign({}, n);
    for (const k of extra) out[k] = from[k];
    if (pcObjects) out.pc = Object.assign({}, from.pc, n.pc);
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
      const before = JSON.stringify(S.notes);
      S.notes = mergeNotes(S.notes, remote);
      local.set(K.notes, S.notes.filter(hasContent));
      if (JSON.stringify(S.notes) !== before) refreshViews();
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
      const before = JSON.stringify([S.ws.items, S.ws.plans]);
      S.ws.items = mergeItems(S.ws.items, rItems);
      S.ws.plans = mergePlans(S.ws.plans, rPlans);
      local.set(K.ws, { items: S.ws.items.filter(keepItem), plans: S.ws.plans });
      const after = wsSignature(S.ws.items, S.ws.plans);
      if (JSON.stringify([S.ws.items, S.ws.plans]) !== before) refreshViews(); // an open editor is left alone so typing is never interrupted
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

  // ================================================================== screens (renewal 2026-10-20)
  // One list column (header, list of the current tab, bottom tabs, + button) and one pane for pages (detail, editor,
  // settings, 알림). Phones show the pane over the list; tablets (>= 768 px) show both side by side.

  // ------------------------------------------------------------------ look: design A/B + light/dark/system
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyLook() {
    const design = look.design === 'B' ? 'B' : 'A';
    const dark = look.theme === 'dark' || (look.theme !== 'light' && !!darkQuery && darkQuery.matches);
    document.documentElement.dataset.design = design;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    const backgroundColor = ({ A: ['#f6f4f1', '#18151b'], B: ['#eef0f2', '#0f1113'] })[design][dark ? 1 : 0];
    if (meta) meta.setAttribute('content', backgroundColor);
    if (native) { try { native.postMessage(JSON.stringify({ type: 'appearance:set', backgroundColor, darkIcons: !dark })); } catch (_) { /* old bridge */ } }
  }
  function setLook(patch) {
    Object.assign(look, patch);
    local.set(K.look, { design: look.design, theme: look.theme });
    applyLook();
    renderSettings();
  }
  if (darkQuery) {
    const onScheme = () => { if (look.theme === 'system') applyLook(); };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onScheme); else if (darkQuery.addListener) darkQuery.addListener(onScheme);
  }
  applyLook();

  // ------------------------------------------------------------------ wording for dates
  const dShort = d => (d.getMonth() + 1) + '.' + d.getDate() + ' ' + WD[d.getDay()];
  const dLabel = d => (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + WD[d.getDay()] + ')';
  const dday = d => { const n = daysBetween(startOfDay(S.now), d); return n === 0 ? '오늘' : n === 1 ? '내일' : n < 0 ? 'D+' + (-n) : 'D-' + n; };
  const dueSoon = d => daysBetween(startOfDay(S.now), d) <= 3;
  const afterText = mins => { const hh = Math.floor(mins / 60), mm = mins % 60; return (hh ? hh + '시간 ' : '') + (mm || !hh ? mm + '분 ' : '') + '후'; };
  const calName = e => (typeof e.n === 'string' && e.n.trim() ? e.n.trim() : '');

  function evState(e) {
    const now = +S.now;
    if (e.e > e.s ? e.e <= now : e.s < +startOfDay(S.now)) return 'past';
    if (e.s <= now) return 'now';
    return 'future';
  }
  function relLabel(e) {
    const st = evState(e), today = startOfDay(S.now), s = new Date(e.s);
    if (st === 'past') return sameDay(new Date(Math.max(e.s, e.e - 1)), today) ? '종료됨' : '지난 일정';
    if (st === 'now') return '진행 중';
    if (sameDay(s, today) && !e.a) return afterText(Math.max(1, Math.ceil((e.s - Date.now()) / 60000)));
    return dday(startOfDay(s));
  }
  function evTime(e) {
    const st = new Date(e.s), en = new Date(e.e);
    if (e.a) {
      const last = e.e > e.s ? addDays(startOfDay(en), -1) : st; // an all-day end date is exclusive
      return (+last > +startOfDay(st) ? dShort(st) + ' – ' + dShort(last) : dLabel(st)) + ' · 종일';
    }
    if (e.e <= e.s) return dLabel(st) + ' · ' + hm(st);
    if (sameDay(st, en)) return dLabel(st) + ' · ' + hm(st) + ' – ' + hm(en);
    if (+en === +addDays(startOfDay(st), 1)) return dLabel(st) + ' · ' + hm(st) + ' – 24:00';
    return dLabel(st) + ' ' + hm(st) + ' – ' + dLabel(en) + ' ' + hm(en);
  }

  // ------------------------------------------------------------------ workspace reading (pc.body is editable; other pc keys are preserved)
  const pcOf = it => (isObj(it && it.pc) ? it.pc : {});
  const pcStr = (it, k) => { const v = pcOf(it)[k]; return typeof v === 'string' ? v : ''; };
  const bodyOf = it => pcStr(it, 'body').trim();
  const isArchived = it => pcOf(it).archived === true;
  const taskGoal = t => liveItem(pcStr(t, 'parentId'), 'goal');
  const isWait = t => t.status === 'waiting' || t.status === 'someday';
  const isPlan = t => !isWait(t) && (!!parseYmd(t.plannedDate) || t.status === 'scheduled');
  const statusLabel = t => (t.status === 'done' ? '완료' : isWait(t) ? '대기' : isPlan(t) ? '예정' : '다음');
  const TIERS = [['ultimate', '최종 목표', '삶의 방향'], ['five-year', '5년 목표', '5년 안에 이룰 결과'], ['one-year', '1년 목표', '올해 이룰 결과']];
  const STAGE = { preparing: '준비 중', active: '진행 중', paused: '보류', done: '완료', archived: '보관' };
  const stageOf = p => (isArchived(p) ? 'archived' : projStatus(p));
  const goalTier = g => (TIERS.some(x => x[0] === g.horizon) ? g.horizon : 'one-year');
  const CAT_LABEL = { work: '업무', personal: '개인', study: '학습' };
  const shortRange = (a, b) => [a, b].map(s => { const d = parseYmd(s); return d ? (d.getMonth() + 1) + '.' + d.getDate() : ''; });
  const notesLinked = (key, id) => liveNotes().filter(n => pcStr(n, key) === id);
  const sharedEventKey = e => {
    if (typeof e.q === 'string' && e.q.includes('\n')) return e.q;
    const at = e.k.lastIndexOf('|');
    return at > 0 ? e.k.slice(0, at) + '\n' + e.k.slice(at + 1) : e.k;
  };
  const noteEventKeys = n => arr(pcOf(n).eventKeys).filter(k => typeof k === 'string' && k.length <= 4096 && /^[^\r\n]+\n[^\r\n]+$/.test(k));
  const notesLinkedEvent = e => liveNotes().filter(n => noteEventKeys(n).includes(sharedEventKey(e)));

  function periodRange(per, today) {
    if (per === 'today') return [today, today];
    if (per === 'tomorrow') return [addDays(today, 1), addDays(today, 1)];
    if (per === 'week') { const s = addDays(today, -today.getDay()); return [s, addDays(s, 6)]; }
    if (per === 'month') return [new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 0)];
    return null;
  }

  // ------------------------------------------------------------------ pages, layers and Back
  // Every pane page and the archive is one history entry, so Back (Android: history.back()) closes the top one.
  // history.state = { mp: number of pane pages, arch }; popstate brings the screen to that state.
  let layerSeq = 0, pendingPop = null;
  const topLayer = () => S.layers[S.layers.length - 1] || null;
  const histState = () => ({ mp: S.layers.length, arch: S.arch });
  const editDirty = l => !!l && l.kind === 'edit' && JSON.stringify(l.draft) !== JSON.stringify(l.orig);

  function pushLayer(layer) {
    layer.uid = ++layerSeq;
    S.layers.push(layer);
    history.pushState(histState(), '');
    afterLayers();
  }
  function replaceTop(layer) {
    if (!S.layers.length) { pushLayer(layer); return; }
    layer.uid = ++layerSeq;
    S.layers[S.layers.length - 1] = layer;
    history.replaceState(histState(), '');
    afterLayers();
  }
  // UI back buttons go through history, so the Back key and the button behave the same
  function closeTop() {
    if (history.state && Number.isFinite(history.state.mp) && history.state.mp > 0) history.back();
    else { S.layers.pop(); afterLayers(); }
  }
  function closeLayers(n) {
    if (n <= 0) return;
    S.allowDiscard = true;
    if (history.state && Number.isFinite(history.state.mp) && history.state.mp >= n) history.go(-n);
    else { S.layers.splice(Math.max(0, S.layers.length - n)); S.allowDiscard = false; afterLayers(); }
  }

  window.addEventListener('popstate', e => {
    const st = isObj(e.state) ? e.state : {};
    const depth = Number.isFinite(st.mp) ? st.mp : 0;
    if (S.cf) { // an open sheet closes first; the page stays
      S.cf = null; renderSheet();
      history.pushState(histState(), '');
      return;
    }
    const doomed = S.layers.slice(depth);
    const dirty = doomed.find(editDirty);
    if (dirty && !S.allowDiscard) { // never drop a draft silently
      history.pushState(histState(), '');
      askLeave(dirty, () => closeLayers(S.layers.length - depth), '나가기');
      return;
    }
    S.allowDiscard = false;
    if (S.layers.length > depth) S.layers.splice(depth);
    S.arch = st.arch === 'tasks' || st.arch === 'projects' ? st.arch : null;
    if (pendingPop) { const run = pendingPop; pendingPop = null; run(); return; }
    afterLayers();
  });

  function afterLayers() {
    const top = topLayer(), wasEditing = S.editing;
    S.editing = top && top.kind === 'edit' && top.type === 'note' ? (top.id || 'new') : null;
    renderPane();
    renderList();
    if (wasEditing && !S.editing) scheduleSync(); // the Doc copy waited while the note was open
  }

  // open an item: phones stack pages; on tablets a tap in the list replaces the pane (links inside a page stack)
  function openRef(ref, from) {
    const layer = { kind: 'detail', ref };
    guardThen(() => {
      if (from === 'link' || !isTablet() || !S.layers.length) { pushLayer(layer); return; }
      if (S.layers.length === 1) { replaceTop(layer); return; }
      pendingPop = () => { layer.uid = ++layerSeq; S.layers = [layer]; history.replaceState(histState(), ''); afterLayers(); };
      closeLayers(S.layers.length - 1);
    }, from === 'link' || !isTablet());
  }

  // a dirty editor in the pane asks before another item replaces it (tablets)
  function guardThen(run, stacking) {
    const dirty = !stacking ? S.layers.find(editDirty) : null;
    if (!dirty) { run(); return; }
    showSheet({
      title: '저장하지 않은 변경이 있어요', text: '편집 중인 내용을 저장하거나 버린 뒤 열 수 있어요.',
      actions: [
        { label: '저장하고 열기', cls: 'primary', run: () => { if (saveEditor(dirty, true)) run(); } },
        { label: '버리기', cls: 'outline danger', run: () => { dirty.orig = JSON.parse(JSON.stringify(dirty.draft)); run(); } },
      ],
      keep: '계속 편집',
    });
  }

  function askLeave(layer, leave, verb) {
    showSheet({
      title: '저장하지 않은 변경이 있어요', text: '지금 나가면 작성한 내용이 사라져요.',
      actions: [
        { label: '저장하고 ' + verb, cls: 'primary', run: () => saveEditor(layer) },
        { label: '버리고 ' + verb, cls: 'outline danger', run: leave },
      ],
      keep: '계속 편집',
    });
  }

  function openArch(which) {
    S.arch = which;
    history.pushState(histState(), '');
    renderList();
  }

  // ------------------------------------------------------------------ confirm sheet
  function showSheet(o) { S.cf = o; renderSheet(); }
  function renderSheet() {
    const box = $('#cf');
    if (!S.cf) { box.hidden = true; box.replaceChildren(); return; }
    const o = S.cf;
    const close = () => { S.cf = null; renderSheet(); };
    box.replaceChildren(h('div', { class: 'cf-box', role: 'dialog', 'aria-modal': 'true', onclick: e => e.stopPropagation() },
      h('b', { text: o.title }), h('span', { text: o.text }),
      o.actions.map(a => h('button', { type: 'button', class: 'btn ' + a.cls, onclick: () => { close(); a.run(); }, text: a.label })),
      h('button', { type: 'button', class: 'keep', id: 'cf-keep', onclick: close, text: o.keep || '취소' })));
    box.onclick = close;
    box.hidden = false;
  }

  // ------------------------------------------------------------------ header, sync state, banner
  function renderSync() {
    const b = $('#sync');
    let text = '', cls = '';
    if (S.sync === 'busy') { text = '동기화 중'; cls = 'busy'; }
    else if (prefs.connected && !tokenValid()) { text = S.dirty || S.wsDirty ? '다시 연결 · 저장 대기' : '다시 연결'; cls = 'err'; }
    else if (S.sync === 'error') { text = S.syncKind === 'offline' ? '오프라인' : '동기화 실패'; cls = 'warn'; }
    else if (tokenValid() && S.sync === 'ok') { text = S.canDrive ? '동기화됨' : '일정 연결됨'; cls = 'ok'; }
    else if (!prefs.connected) text = '연결 안 됨';
    b.className = 'sync' + (cls ? ' ' + cls : '');
    b.replaceChildren(h('span', { class: 'dot' }), text);
    b.hidden = !text;
    b.title = S.lastSync ? '마지막 동기화 · ' + hm(new Date(S.lastSync)) : '';
    renderBanner();
  }

  function setSync(state, msg) {
    S.sync = state;
    S.syncMsg = msg || '';
    if (state !== 'error') S.syncKind = '';
    renderSync();
    renderSettings();
  }

  function bannerInfo() {
    if (!S.authTried) return null;
    if (prefs.connected && !tokenValid() && S.sync !== 'busy') {
      return { key: 'reauth', tone: 'err', title: 'Google 연결이 만료됐어요', act: '다시 연결', run: connect,
        text: S.dirty || S.wsDirty ? '바꾼 내용은 이 기기에 있어요. 다시 연결하면 이어서 동기화해요.' : '새 일정을 읽어 오지 못하고 있어요. 다시 연결하면 이어서 동기화해요.' };
    }
    if (S.sync === 'error' && S.syncKind === 'offline') return { key: 'offline', tone: 'warn', title: '오프라인 · 이 기기에만 저장 중', text: '인터넷이 다시 연결되면 동기화해요.', act: '다시 시도', run: syncAll, close: true };
    if (S.sync === 'error') return { key: 'fail', tone: 'err', title: '동기화하지 못했어요', text: S.syncMsg, act: '다시 시도', run: syncAll, close: true };
    if (tokenValid() && !S.canDrive) return { key: 'drive', tone: 'warn', title: '드라이브 권한이 없어요', text: '메모와 할 일은 이 기기에만 저장돼요.', act: '권한 확인', run: () => requestToken('consent'), close: true };
    if (S.tab === 'cal' && tokenValid() && !S.canCal) return { key: 'cal', tone: 'warn', title: '캘린더 읽기 권한이 없어요', text: '할 일·메모 동기화는 정상이에요.', act: '권한 확인', run: () => requestToken('consent'), close: true };
    return null;
  }

  function renderBanner() {
    const box = $('#banner');
    const b = bannerInfo();
    if (!b || S.bannerClosed === b.key + '|' + b.text) { box.replaceChildren(); return; }
    box.replaceChildren(h('div', { class: 'banner tone-' + b.tone, role: 'status', 'data-banner': b.key },
      h('span', { class: 's-dot' }),
      h('span', { class: 'bt' }, h('b', { text: b.title }), b.text ? h('span', { text: b.text }) : null),
      h('button', { type: 'button', class: 'bb', onclick: b.run, text: b.act }),
      b.close ? h('button', { type: 'button', class: 'bx', 'aria-label': '닫기', onclick: () => { S.bannerClosed = b.key + '|' + b.text; renderBanner(); } }, icon('x')) : null));
  }

  function renderHeader() {
    let sub, title;
    const today = startOfDay(S.now);
    if (S.tab === 'cal') {
      const isToday = sameDay(S.sel, today);
      title = isToday ? '오늘' : dShort(S.sel);
      sub = isToday ? longDay(today) : dLabel(S.sel);
    } else if (S.tab === 'tasks') { title = '할 일'; sub = '실제로 수행할 행동'; }
    else if (S.tab === 'goals') {
      const proj = S.gseg === 'projects';
      title = proj ? '프로젝트' : '목표'; sub = proj ? '실제 업무와 산출물이 있는 일' : '이루려는 결과와 생활 방향';
    } else { title = '메모'; sub = '모든 기기에 동기화'; }
    $('#hdr-title').textContent = title;
    $('#hdr-sub').textContent = sub;
  }

  // ------------------------------------------------------------------ rows and sections
  function isSelected(type, id) {
    if (!isTablet()) return false;
    const top = topLayer();
    const l = top && top.kind === 'edit' ? S.layers[S.layers.length - 2] : top;
    return !!l && l.kind === 'detail' && l.ref.type === type && l.ref.id === id;
  }

  function rowEl(o) {
    const open = o.open;
    const el = h('div', {
      class: 'row' + (o.cls ? ' ' + o.cls : '') + (isSelected(o.type, o.id) ? ' sel' : ''),
      role: open ? 'button' : null, tabindex: open ? '0' : null, 'data-id': o.id, 'data-kind': o.type,
      onclick: open || null, onkeydown: open ? e => { if (e.key === 'Enter' && e.target === el) open(); } : null,
    },
    o.lead,
    h('span', { class: 'main' },
      h('span', { class: 'tt', text: o.title }),
      o.sub ? h('span', { class: 'sub', text: o.sub }) : null,
      o.icons && o.icons.length ? h('span', { class: 'icons' }, o.icons) : null),
    o.right ? h('span', { class: 'rt' + (o.rightCls ? ' ' + o.rightCls : ''), text: o.right }) : null,
    open && !o.noChev ? icon('chev', 'go') : null);
    return el;
  }

  function mini(name, tip, n, due) {
    return h('span', { class: due ? 'due' : null, title: tip, 'aria-label': tip }, icon(name), n == null ? null : String(n));
  }

  function checkEl(t) {
    const done = t.status === 'done';
    return h('button', {
      type: 'button', class: 'check', 'aria-pressed': String(done), 'aria-label': done ? '완료 취소' : '완료로 표시',
      onclick: ev => { ev.stopPropagation(); setDone(t.id, !done); },
    }, h('span', { class: 'ring' }, icon('tick')));
  }

  function taskRow(t, o) {
    o = o || {};
    const done = t.status === 'done';
    const plan = parseYmd(t.plannedDate), due = parseYmd(t.dueDate);
    const icons = [];
    if (o.icons !== false) {
      if (plan && !o.noPlan) icons.push(mini('cal', '실행 ' + dShort(plan)));
      if (due) icons.push(mini('flag', '마감 ' + dShort(due), null, !done && dueSoon(due)));
      const proj = liveItem(t.projectId, 'project');
      if (proj) icons.push(mini('folder', itemTitle(proj)));
      const goal = taskGoal(t);
      if (goal) icons.push(mini('target', itemTitle(goal)));
      if (bodyOf(t)) icons.push(mini('lines', '본문 있음'));
    }
    let right = o.right || '', rightCls = o.rightCls || '';
    if (!right && !done && due && dueSoon(due)) { right = '마감 ' + dday(due); rightCls = 'due'; }
    return rowEl({ type: 'task', id: t.id, cls: 'tk' + (done ? ' done' : ''), lead: checkEl(t), title: itemTitle(t), sub: o.sub, icons, right, rightCls,
      open: () => openRef({ type: 'task', id: t.id }, o.from) });
  }

  function eventRow(e, day) {
    const st = evState(e), isToday = sameDay(day, startOfDay(S.now));
    let right = '', rightCls = '';
    if (isToday && !e.a) {
      if (st === 'now') { right = '진행 중'; rightCls = 'live'; }
      else if (st === 'past') right = '종료';
      else if (e.s - Date.now() < 3600000) right = relLabel(e);
    }
    const time = e.a ? '종일' : e.s < +startOfDay(day) ? '계속' : hm(new Date(e.s));
    const place = typeof e.p === 'string' && e.p.trim() ? e.p.trim() : 'Google 일정';
    return rowEl({ type: 'event', id: e.k, cls: 'ev' + (isToday && st === 'past' && !e.a ? ' past' : ''),
      lead: [h('span', { class: 'tm', text: time }), h('span', { class: 'bar', style: { '--c': safeColor(e.c) } })],
      title: e.t, sub: (calName(e) || 'Google 캘린더') + ' · ' + place, right, rightCls,
      open: () => openRef({ type: 'event', id: e.k, ev: e }) });
  }

  function iconRow(type, id, name, color, title, aside, from) {
    return rowEl({ type, id, cls: 'ic', lead: h('span', { class: 'ibox', style: color ? { '--ic': color } : null }, icon(name)), title, right: aside, rightCls: 'aside',
      open: () => openRef({ type, id }, from) });
  }

  function noteRow(n) {
    const linked = !!(pcStr(n, 'projectId') || pcStr(n, 'taskId') || pcStr(n, 'parentId') || noteEventKeys(n).length);
    return rowEl({ type: 'note', id: n.id, title: noteTitle(n), sub: dShort(parseYmd(n.date) || startOfDay(new Date(n.updatedAt))),
      icons: linked ? [mini('link', '연결된 항목')] : [], open: () => openRef({ type: 'note', id: n.id }) });
  }

  function secEl(o) {
    return h('div', { class: 'sec', 'data-sec': o.key },
      o.title ? h('div', { class: 'sec-h' },
        h('span', { class: 't', text: o.title, style: o.color ? { color: o.color } : null }),
        h('span', { class: 'c', text: String(o.count != null ? o.count : o.rows.length) }),
        o.note ? h('span', { class: 'nt', text: o.note }) : null) : null,
      h('div', { class: 'card' }, o.rows.length ? o.rows : h('span', { class: 'empty', text: o.empty || '비어 있어요' })));
  }

  const footLink = (label, n, run, id) => h('button', { type: 'button', class: 'foot-link', id, onclick: run }, h('span', { text: label }), h('span', { class: 'n', text: n + ' →' }));

  // ------------------------------------------------------------------ list column
  const VIEWS = { cal: '#view-cal', tasks: '#view-tasks', goals: '#view-goals', notes: '#view-notes' };

  function renderList() {
    renderHeader();
    renderSync();
    for (const k of Object.keys(VIEWS)) $(VIEWS[k]).hidden = k !== S.tab;
    for (const b of document.querySelectorAll('.tab')) {
      if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    if (S.tab === 'cal') renderCal();
    else if (S.tab === 'tasks') renderTasks();
    else if (S.tab === 'goals') renderGoals();
    else renderNotes();
    updateFab();
    renderArch();
  }

  function render() {
    renderList();
    renderPane(true);
  }
  const refreshViews = render;

  // ---- 일정: 7 days from today, the next event, then the selected day's events, tasks, deadlines and notes
  function renderCal() {
    const root = $('#view-cal');
    const today = startOfDay(S.now), sel = S.sel, isToday = sameDay(sel, today), key = ymd(sel);
    const tasks = liveItems('task');
    const kids = [];

    const strip = h('div', { class: 'strip' });
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, i), wd = d.getDay(), on = sameDay(d, sel);
      const marks = eventsOn(d).slice(0, 3).map(e => h('i', { style: { '--c': safeColor(e.c) } }));
      if (tasks.some(t => t.status !== 'done' && t.plannedDate === ymd(d))) marks.push(h('i', { class: 'ring', style: { '--c': 'var(--ink2)' } }));
      strip.append(h('button', {
        type: 'button', class: [on ? 'on' : '', wd === 0 ? 'sun' : '', wd === 6 ? 'sat' : ''].join(' ').trim() || null,
        'aria-label': longDay(d), 'aria-pressed': String(on), onclick: () => selectDay(d),
      }, h('span', { class: 'wd', text: i === 0 ? '오늘' : WD[wd] }), h('span', { class: 'dn', text: String(d.getDate()) }), h('span', { class: 'dots' }, marks)));
    }
    kids.push(strip);

    if (!prefs.connected && !S.events.length) kids.push(connectCard());

    const evs = eventsOn(sel);
    if (isToday) {
      const now = Date.now();
      const next = evs.find(e => !e.a && e.e > now && e.s < +addDays(today, 1));
      if (next) {
        const live = next.s <= now;
        const place = typeof next.p === 'string' && next.p.trim() ? ' · ' + next.p.trim() : '';
        kids.push(h('button', { type: 'button', class: 'hero', id: 'cal-next', onclick: () => openRef({ type: 'event', id: next.k, ev: next }) },
          h('span', { class: 'h1' },
            h('span', { class: 'lbl', text: live ? '진행 중' : '다음 일정 · ' + relLabel(next) }),
            h('span', { class: 'tm', text: hm(new Date(next.s)) + ' – ' + hm(new Date(next.e)) })),
          h('span', { class: 'tt', text: next.t }),
          h('span', { class: 'ts', text: (calName(next) ? calName(next) + ' 캘린더' : 'Google 캘린더') + place })));
      }
    }

    if (haveCalendar()) {
      const allDay = evs.filter(e => e.a), timed = evs.filter(e => !e.a);
      if (allDay.length) kids.push(secEl({ key: 'allday', title: '종일', note: 'Google 캘린더', rows: allDay.map(e => eventRow(e, sel)) }));
      kids.push(secEl({ key: 'ev', title: '일정', note: 'Google 캘린더 · 읽기 전용', rows: timed.map(e => eventRow(e, sel)), empty: '이 날은 일정이 없어요' }));
    }

    // tasks to do that day: planned for it (and, today, the 오늘 focus list); done ones stay, struck through
    const plan = isToday ? planOf(key) : null;
    const focus = plan ? plan.focus : [];
    const dayTasks = tasks.filter(t => t.plannedDate === key || (focus.includes(t.id) && t.status !== 'done'))
      .sort((a, b) => {
        const fa = focus.indexOf(a.id), fb = focus.indexOf(b.id);
        if (fa !== fb) return (fa < 0 ? 1e9 : fa) - (fb < 0 ? 1e9 : fb);
        return a.createdAt - b.createdAt;
      });
    const openCount = dayTasks.filter(t => t.status !== 'done').length;
    kids.push(secEl({ key: 'tk', title: '할 일', count: openCount + '/' + dayTasks.length, rows: dayTasks.map(t => taskRow(t, { noPlan: true })), empty: '실행할 일이 없어요' }));

    const dues = tasks.filter(t => t.status !== 'done' && !dayTasks.includes(t) && DATE_RE.test(t.dueDate || '') && (t.dueDate === key || (isToday && t.dueDate < key))).sort(byDue);
    if (dues.length) kids.push(secEl({ key: 'due', title: '마감', color: 'var(--due)', rows: dues.map(t => taskRow(t)) }));

    const notes = notesOn(sel);
    if (notes.length) kids.push(secEl({ key: 'notes', title: '메모', rows: notes.map(noteRow) }));

    // Extra month navigation stays available without changing the reference calendar list.
    kids.push(h('details', { class: 'secondary calendar-more' }, h('summary', { text: '다른 날짜 보기' }), monthCard(today)));
    root.replaceChildren(...kids);
  }

  function connectCard() {
    const ready = native || clientId();
    return h('div', { class: 'connect' },
      h('b', { text: ready ? 'Google 계정을 연결해 주세요' : 'Google 연결 준비가 필요해요' }),
      h('span', { text: ready ? '연결하면 Google 캘린더 일정을 읽어 오고, 할 일·목표·메모를 다른 기기와 맞춰요. 지금 쓰는 내용은 이 기기에 저장돼요.'
        : '설정에서 웹 클라이언트 ID를 넣으면 일정이 보이고, 메모와 할 일이 다른 기기와 동기화돼요.' }),
      h('button', { type: 'button', class: 'btn primary small', id: 'connect-btn', onclick: ready ? connect : openSettings, text: ready ? 'Google 계정 연결' : '설정 열기' }));
  }

  function monthCard(today) {
    const m = S.month;
    const grid = h('div', { class: 'grid' });
    WD.forEach((w, i) => grid.append(h('span', { class: 'wdh' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), text: w })));
    const start = gridStart(m), cells = gridWeeks(m) * 7;
    for (let i = 0; i < cells; i++) {
      const d = addDays(start, i);
      const inMonth = d.getMonth() === m.getMonth();
      const cls = ['cell', i % 7 === 0 ? 'sun' : '', i % 7 === 6 ? 'sat' : '', inMonth ? '' : 'out', sameDay(d, today) ? 'today' : '', sameDay(d, S.sel) ? 'on' : ''].filter(Boolean).join(' ');
      const marks = inMonth ? eventsOn(d).slice(0, 3).map(e => h('i', { style: { '--c': safeColor(e.c) } })) : [];
      grid.append(h('button', { type: 'button', class: cls, 'aria-label': longDay(d), onclick: () => selectDay(d) },
        h('span', { class: 'n', text: String(d.getDate()) }), h('span', { class: 'dots' }, marks)));
    }
    return h('div', { class: 'sec', 'data-sec': 'month' },
      h('div', { class: 'sec-h' }, h('span', { class: 't', text: '월간' })),
      h('div', { class: 'card month' },
        h('div', { class: 'month-head' },
          h('span', { class: 'm' }, (m.getMonth() + 1) + '월', h('span', { class: 'y', text: String(m.getFullYear()) })),
          h('button', { type: 'button', 'aria-label': '이전 달', id: 'month-prev', onclick: () => stepMonth(-1) }, icon('back')),
          h('button', { type: 'button', 'aria-label': '다음 달', id: 'month-next', onclick: () => stepMonth(1) }, icon('chev'))),
        grid));
  }

  function selectDay(d) {
    S.sel = startOfDay(d);
    if (d.getMonth() !== S.month.getMonth() || d.getFullYear() !== S.month.getFullYear()) {
      S.month = new Date(d.getFullYear(), d.getMonth(), 1);
      loadEvents(false);
    }
    renderList();
  }

  function stepMonth(n) {
    S.month = new Date(S.month.getFullYear(), S.month.getMonth() + n, 1);
    loadEvents(false);
    renderList();
  }

  // ---- 할 일: period chips (기간) and status tabs (다음 · 예정 · 대기) are separate layers
  const PERIODS = [['today', '오늘'], ['tomorrow', '내일'], ['week', '이번주'], ['month', '이번달'], ['all', '전체']];
  const STATUS_TABS = [['next', '다음'], ['plan', '예정'], ['wait', '대기']];
  const STATUS_HINT = {
    next: '날짜 없이 바로 할 수 있는 일',
    plan: '실행일을 정한 일 · 날짜별로 묶었어요',
    wait: '회신이나 조건을 기다리는 일 · 실행일이 있어도 여기 남아요',
  };

  function renderTasks() {
    const root = $('#view-tasks'), today = startOfDay(S.now);
    const range = periodRange(S.period, today);
    const plan = planOf(ymd(today)), focus = new Set(plan ? plan.focus : []);
    const inRange = t => {
      if (!range) return true;
      const ds = [t.plannedDate, t.dueDate].map(parseYmd).filter(Boolean);
      if (focus.has(t.id)) ds.push(today);
      if (!ds.length) return S.incl;
      return ds.some(d => +d >= +range[0] && +d <= +range[1]);
    };
    const live = liveItems('task').filter(t => t.status !== 'done' && inRange(t));
    const groups = {
      next: live.filter(t => !isWait(t) && !isPlan(t)).sort(byDue),
      plan: live.filter(isPlan).sort(byPlanned),
      wait: live.filter(isWait).sort(byDue),
    };
    const kids = [
      h('div', { class: 'chips', role: 'group', 'aria-label': '기간' }, PERIODS.map(([k, label]) =>
        h('button', { type: 'button', class: 'pill', 'data-v': k, 'aria-pressed': String(S.period === k), onclick: () => { S.period = k; renderList(); } }, label))),
      h('div', { class: 'seg', role: 'group', 'aria-label': '상태', id: 'task-status' }, STATUS_TABS.map(([k, label]) =>
        h('button', { type: 'button', 'data-v': k, 'aria-pressed': String(S.status === k), onclick: () => { S.status = k; renderList(); } }, label, h('span', { class: 'n', text: String(groups[k].length) })))),
    ];
    if (S.period !== 'all') {
      kids.push(h('button', { type: 'button', class: 'incl', id: 'task-incl', 'aria-pressed': String(S.incl), onclick: () => { S.incl = !S.incl; renderList(); } },
        h('span', { class: 'box' }, icon('tick')), '날짜 없는 일도 함께 보기'));
    }
    kids.push(h('span', { class: 'hint', text: STATUS_HINT[S.status] }));
    const empty = S.period === 'all' ? '비어 있어요' : '이 기간에는 없어요';
    if (S.status === 'plan') {
      const byDay = new Map();
      for (const t of groups.plan) {
        const k = DATE_RE.test(t.plannedDate || '') ? t.plannedDate : '';
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(t);
      }
      const keys = Array.from(byDay.keys()).sort((a, b) => (!a ? 1 : !b ? -1 : ordinal(a, b)));
      for (const k of keys) {
        const d = parseYmd(k);
        const n = d ? daysBetween(today, d) : null;
        const title = d ? dShort(d) + (n === 0 ? ' · 오늘' : n === 1 ? ' · 내일' : '') : '날짜 미정';
        kids.push(secEl({ key: 'd' + (k || 'none'), title, color: n === 0 ? 'var(--accent-ink)' : null, rows: byDay.get(k).map(t => taskRow(t, { noPlan: true })) }));
      }
      if (!keys.length) kids.push(secEl({ key: 'plan', rows: [], empty }));
    } else {
      kids.push(secEl({ key: S.status, rows: groups[S.status].map(t => taskRow(t)), empty }));
    }
    const doneCount = liveItems('task').filter(t => t.status === 'done').length;
    kids.push(footLink('완료 보관함', doneCount, () => openArch('tasks'), 'task-archive'));
    root.replaceChildren(...kids);
  }

  // ---- 목표 / 프로젝트
  function renderGoals() {
    const root = $('#view-goals');
    const kids = [h('div', { class: 'seg goal-seg', role: 'group', id: 'goal-seg' }, [['goals', '목표'], ['projects', '프로젝트']].map(([k, label]) =>
      h('button', { type: 'button', 'data-v': k, 'aria-pressed': String(S.gseg === k), onclick: () => { S.gseg = k; renderList(); } }, label)))];
    if (S.gseg === 'goals') {
      const goals = liveItems('goal');
      const tasks = liveItems('task'), projects = liveItems('project');
      for (const [tier, name, note] of TIERS) {
        const list = goals.filter(g => goalTier(g) === tier).sort((a, b) => (a.status === 'done') - (b.status === 'done') || byDue(a, b));
        kids.push(secEl({ key: tier, title: name, note, rows: list.map(g => {
          const subs = goals.filter(x => pcStr(x, 'parentId') === g.id).length;
          const projs = projects.filter(p => p.parentId === g.id).length;
          const open = tasks.filter(t => t.status !== 'done' && pcStr(t, 'parentId') === g.id).length;
          const icons = [];
          if (subs) icons.push(mini('target', '하위 목표 ' + subs, subs));
          if (projs) icons.push(mini('folder', '프로젝트 ' + projs, projs));
          if (open) icons.push(mini('checkbox', '할 일 ' + open, open));
          return rowEl({ type: 'goal', id: g.id, title: itemTitle(g), icons, right: g.status === 'paused' ? '보류' : g.status === 'done' ? '달성' : '',
            open: () => openRef({ type: 'goal', id: g.id }) });
        }) }));
      }
    } else {
      const projects = liveItems('project'), tasks = liveItems('task');
      kids.push(h('div', { class: 'stages', role: 'group', id: 'project-stage' }, [['preparing', '준비 중'], ['active', '진행 중']].map(([k, label]) =>
        h('button', { type: 'button', class: 'pill', 'data-v': k, 'aria-pressed': String(S.pseg === k), onclick: () => { S.pseg = k; renderList(); } },
          label, h('span', { class: 'n', text: String(projects.filter(p => stageOf(p) === k).length) })))));
      const list = projects.filter(p => stageOf(p) === S.pseg).sort(byDue);
      kids.push(secEl({ key: S.pseg, rows: list.map(p => {
        const open = tasks.filter(t => t.projectId === p.id && t.status !== 'done');
        const goal = liveItem(p.parentId, 'goal');
        const icons = [];
        if (goal) icons.push(mini('target', itemTitle(goal)));
        if (open.length) icons.push(mini('checkbox', '남은 할 일 ' + open.length, open.length));
        if (open.some(t => { const d = parseYmd(t.dueDate); return d && dueSoon(d); })) icons.push(mini('flag', '곧 마감', null, true));
        return rowEl({ type: 'project', id: p.id, title: itemTitle(p), icons, open: () => openRef({ type: 'project', id: p.id }) });
      }) }));
      const archived = projects.filter(p => ['done', 'paused', 'archived'].includes(stageOf(p))).length;
      kids.push(footLink('보관함 · 완료·보류·보관', archived, () => openArch('projects'), 'project-archive'));
    }
    root.replaceChildren(...kids);
  }

  // ---- 메모
  function renderNotes() {
    const root = $('#view-notes');
    if (!$('#note-search')) {
      const input = h('input', { id: 'note-search', type: 'search', placeholder: '메모 제목으로 찾기', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': '메모 찾기' });
      input.addEventListener('input', () => { S.query = input.value; renderNoteList(); });
      root.replaceChildren(h('label', { class: 'search' }, icon('search'), input), h('div', { id: 'note-list' }),
        h('span', { class: 'foot-note', text: 'PC 문서·폴더 같은 참고 자료는 PC 앱에서만 열 수 있어요.' }));
    }
    renderNoteList();
  }

  function renderNoteList() {
    const all = liveNotes();
    const norm = s => String(s || '').replace(/[\s·]/g, '').toLowerCase();
    const q = norm(S.query);
    const dateKey = n => n.date || ymd(new Date(n.updatedAt));
    const list = (q ? all.filter(n => norm(n.title + '\n' + n.body).includes(q)) : all)
      .sort((a, b) => ordinal(dateKey(b), dateKey(a)) || b.updatedAt - a.updatedAt);
    $('#note-list').replaceChildren(secEl({ key: 'notes', rows: list.map(noteRow), empty: all.length ? '찾는 메모가 없어요' : '아직 메모가 없어요' }));
  }

  // ---- archive (완료 보관함 / 프로젝트 보관함)
  function renderArch() {
    const box = $('#arch');
    if (!S.arch) { box.hidden = true; box.replaceChildren(); return; }
    const tasksArch = S.arch === 'tasks';
    const kids = [h('h2', { text: tasksArch ? '완료 보관함' : '프로젝트 보관함' }),
      h('span', { class: 'an', text: tasksArch ? '체크를 풀면 할 일 목록으로 돌아가요.' : '완료·보류·보관한 프로젝트' })];
    if (tasksArch) {
      const doneAt = t => (Number.isFinite(t.completedAt) ? t.completedAt : t.updatedAt);
      const done = liveItems('task').filter(t => t.status === 'done').sort((a, b) => doneAt(b) - doneAt(a));
      kids.push(secEl({ key: 'done', rows: done.map(t => { const p = parseYmd(t.plannedDate); return taskRow(t, { icons: false, right: p ? dShort(p) : '', rightCls: 'aside' }); }), empty: '완료한 할 일이 없어요' }));
    } else {
      const projects = liveItems('project');
      for (const k of ['done', 'paused', 'archived']) {
        kids.push(secEl({ key: k, title: STAGE[k], rows: projects.filter(p => stageOf(p) === k).map(p => rowEl({ type: 'project', id: p.id, title: itemTitle(p), open: () => openRef({ type: 'project', id: p.id }) })) }));
      }
    }
    box.replaceChildren(
      h('div', { class: 'page-bar' }, h('button', { type: 'button', class: 'back', id: 'arch-back', onclick: () => history.back() }, icon('back'), h('span', { text: tasksArch ? '할 일' : '프로젝트' }))),
      h('div', { class: 'scroll' }, kids));
    box.hidden = false;
  }

  // ------------------------------------------------------------------ the pane
  function refTarget(ref) {
    if (!ref) return null;
    if (ref.type === 'event') return S.events.find(e => e.k === ref.id) || ref.ev || null;
    if (ref.type === 'note') { const n = noteById(ref.id); return n && !n.deleted ? n : null; }
    return liveItem(ref.id, ref.type);
  }
  function refTitle(ref) {
    const x = refTarget(ref);
    if (!x) return '뒤로';
    return ref.type === 'event' ? x.t : ref.type === 'note' ? noteTitle(x) : itemTitle(x);
  }
  function layerTitle(l) {
    if (l.kind === 'detail') return refTitle(l.ref);
    if (l.kind === 'settings') return '설정';
    if (l.kind === 'notify') return '알림';
    return '편집';
  }
  function backLabel() {
    const prev = S.layers[S.layers.length - 2];
    if (prev) return layerTitle(prev);
    if (isTablet()) return '닫기';
    if (S.arch) return S.arch === 'tasks' ? '완료 보관함' : '프로젝트 보관함';
    return { cal: '일정', tasks: '할 일', goals: S.gseg === 'projects' ? '프로젝트' : '목표', notes: '메모' }[S.tab];
  }
  const backBtn = id => h('button', { type: 'button', class: 'back', id, onclick: closeTop }, icon('back'), h('span', { text: backLabel() }));

  // soft: a data refresh; an open editor is left alone so typing is never interrupted
  function renderPane(soft) {
    const top = topLayer();
    $('#app').classList.toggle('has-pane', !!top);
    if (top && top.kind === 'edit' && soft && $('#editor').dataset.uid === String(top.uid) && !$('#editor').hidden) return;
    for (const id of ['detail', 'editor', 'settings']) if (!top || id !== paneId(top)) { $('#' + id).hidden = true; $('#' + id).dataset.uid = ''; }
    if (!top) return;
    if (top.kind === 'detail') renderDetail(top);
    else if (top.kind === 'edit') renderEditor(top);
    else renderSettingsPage(top);
  }
  const paneId = l => (l.kind === 'detail' ? 'detail' : l.kind === 'edit' ? 'editor' : 'settings');

  // ------------------------------------------------------------------ detail pages
  function prop(label, value, o) {
    o = o || {};
    const v = h('span', { class: 'v' + (o.none ? ' none' : '') },
      o.dot ? h('i', { class: 'dotsq', style: { background: o.dot } }) : null,
      o.href ? h('a', { href: o.href, target: '_blank', rel: 'noopener noreferrer', text: value }) : value ? h('span', { text: value }) : null,
      o.chip ? h('span', { class: 'chipv' + (o.hot ? ' hot' : ''), text: o.chip }) : null);
    return o.link
      ? h('button', { type: 'button', class: 'p link', 'data-prop': label, onclick: o.link }, h('span', { class: 'l', text: label }), v, icon('chev', 'go'))
      : h('div', { class: 'p', 'data-prop': label }, h('span', { class: 'l', text: label }), v);
  }

  function bodyBlocks(text) {
    const out = [];
    let cur = null;
    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      const l = raw.trim().replace(/\*\*(.+?)\*\*/g, '$1');
      if (!l) { cur = null; continue; }
      let m;
      if ((m = /^#{1,3}\s+(.*)$/.exec(l))) { cur = { h: m[1] }; out.push(cur); continue; }
      if ((m = /^[-*•]\s+(.*)$/.exec(l))) { if (!cur || cur.p) { cur = {}; out.push(cur); } (cur.list = cur.list || []).push(m[1]); continue; }
      if (!cur || cur.list) { cur = {}; out.push(cur); }
      cur.p = cur.p ? cur.p + '\n' + l : l;
    }
    return out;
  }
  // Memo read view only: never turn stored text into markup, and never place links inside list-card buttons.
  function phoneText(text) {
    const value = String(text || ''), out = [];
    const pattern = /\+82(?:[ .-]?\(0\))?[ .-]?0?(?:1[016789]|2|3[1-3]|4[1-4]|5[1-5]|50[2-8]|6[1-4]|70|80)[ .-]?\d{3,4}[ .-]?\d{4}|0(?:1[016789]|2|3[1-3]|4[1-4]|5[1-5]|50[2-8]|6[1-4]|70|80)[ .-]?\d{3,4}[ .-]?\d{4}|1[568]\d{2}[ .-]?\d{4}/g;
    let last = 0, match;
    while ((match = pattern.exec(value))) {
      const raw = match[0], start = match.index, end = start + raw.length;
      if (/[0-9A-Za-z+]/.test(value[start - 1] || '') || /[0-9A-Za-z]/.test(value[end] || '') ||
          (/[.-]/.test(value[start - 1] || '') && /\d/.test(value[start - 2] || '')) ||
          (/[.-]/.test(value[end] || '') && /\d/.test(value[end + 1] || ''))) continue;
      const international = raw.startsWith('+82');
      let digits = raw.replace(/\D/g, '');
      if (international) { digits = digits.slice(2); if (digits.startsWith('0')) digits = digits.slice(1); }
      const domestic = international ? '0' + digits : digits;
      if (!/^(?:010\d{8}|01[16789]\d{7,8}|02\d{7,8}|0(?:3[1-3]|4[1-4]|5[1-5]|6[1-4])\d{7,8}|050[2-8]\d{7,8}|070\d{8}|080\d{7,8}|1[568]\d{6})$/.test(domestic)) continue;
      if (start > last) out.push(value.slice(last, start));
      out.push(h('a', { class: 'phone-link', href: 'tel:' + (international ? '+82' + digits : digits), text: raw }));
      last = end;
    }
    if (last < value.length) out.push(value.slice(last));
    return out.length ? out : [value];
  }
  const blockEls = (blocks, muted, phones) => blocks.map(b => h('div', { class: 'blk' },
    b.h ? h('h3', null, phones ? phoneText(b.h) : b.h) : null,
    b.p ? h('p', { class: muted ? 'muted' : null }, phones ? phoneText(b.p) : b.p) : null,
    b.list ? h('ul', null, b.list.map(x => h('li', null, phones ? phoneText(x) : x))) : null));

  function grp(title, rows, o) {
    o = o || {};
    if (!rows.length && !o.keep) return null;
    return h('div', { class: 'grp', 'data-grp': title },
      h('div', { class: 'sec-h' }, h('span', { class: 't', text: title }), h('span', { class: 'c', text: String(rows.length) })),
      h('div', { class: 'card' }, rows.length ? rows : h('span', { class: 'empty', text: o.empty || '없음' })),
      o.add ? h('button', { type: 'button', class: 'add-dash', onclick: o.add.run }, icon('plus'), o.add.label) : null);
  }
  const subTask = t => {
    const p = parseYmd(t.plannedDate), d = parseYmd(t.dueDate);
    return taskRow(t, { icons: false, from: 'link', right: p ? '실행 ' + dShort(p) : d ? '마감 ' + dShort(d) : statusLabel(t), rightCls: 'aside' });
  };
  const noteRows = notes => notes.map(n => iconRow('note', n.id, 'lines', null, noteTitle(n), dShort(parseYmd(n.date) || startOfDay(new Date(n.updatedAt))), 'link'));

  function buildDetail(ref) {
    const x = refTarget(ref);
    const d = { tag: '', title: '', blocks: [], groups: [], foot: [], extra: [], editable: false };
    if (!x) {
      d.title = '찾을 수 없는 항목';
      d.blocks = blockEls([{ p: '다른 기기에서 지웠거나 아직 동기화되지 않았어요.' }], true);
      return d;
    }
    const edit = () => startEdit(ref);
    const editBtn = () => h('button', { type: 'button', class: 'btn primary', id: 'dt-edit-btn', onclick: edit, text: '편집' });
    if (ref.type === 'event') {
      const name = calName(x);
      d.dot = safeColor(x.c);
      d.tag = 'Google 일정 · ' + (name ? name + ' 캘린더' : '읽기 전용');
      d.title = x.t;
      d.banner = 'Google Calendar에서 가져온 일정이에요. 여기서는 읽기만 하고, 수정은 캘린더에서 해요.';
      const place = typeof x.p === 'string' ? x.p.trim() : '';
      const meet = typeof x.m === 'string' ? meetLink(x.m) : null;
      d.props = [prop('시간', evTime(x), { chip: relLabel(x), hot: evState(x) !== 'past' }), prop('장소', place || '장소 없음', { none: !place })];
      if (meet) d.props.push(prop('링크', meet.replace(/^https:\/\//, ''), { href: meet }));
      const desc = typeof x.d === 'string' ? x.d.trim() : '';
      d.blocks = blockEls([{ h: '설명', p: desc || '설명이 없는 일정이에요.' }], !desc);
      const files = Array.isArray(x.f) ? x.f.filter(isObj).slice(0, MAX_ATTACH) : [];
      if (files.length) d.extra.push(grp('첨부파일', files.map(attachRow)));
      d.groups.push(grp('관련 메모', noteRows(notesLinkedEvent(x))));
      const link = safeLink(x.l) || 'https://calendar.google.com/calendar/r';
      d.foot = [h('a', { class: 'btn primary', id: 'dt-calendar', href: link, target: '_blank', rel: 'noopener noreferrer' }, '캘린더에서 관리하기', icon('ext'))];
      return d;
    }
    d.editable = true;
    d.onEdit = edit;
    if (ref.type === 'task') {
      const done = x.status === 'done';
      d.tag = '할 일 · ' + statusLabel(x);
      d.title = itemTitle(x);
      d.done = done;
      const plan = parseYmd(x.plannedDate), due = parseYmd(x.dueDate);
      d.tiles = h('div', { class: 'tiles' },
        h('div', { class: 'tile', id: 'dt-plan' }, h('span', { class: 'l', text: '실행일 · 하기로 한 날' }), h('span', { class: 'v' + (plan ? '' : ' none'), text: plan ? dLabel(plan) : '정하지 않음' })),
        h('div', { class: 'tile' + (due && !done ? ' due' : ''), id: 'dt-due' }, h('span', { class: 'l', text: '마감일 · 실제 기한' }),
          h('span', { class: 'v' + (due ? '' : ' none') }, due ? dLabel(due) : '없음', due && !done ? h('span', { class: 'dd', text: dday(due) }) : null)));
      const proj = liveItem(x.projectId, 'project'), goal = taskGoal(x);
      d.props = [
        prop('프로젝트', proj ? itemTitle(proj) : '연결 안 함', proj ? { link: () => openRef({ type: 'project', id: proj.id }, 'link') } : { none: true }),
        prop('목표', goal ? itemTitle(goal) : '연결 안 함', goal ? { link: () => openRef({ type: 'goal', id: goal.id }, 'link') } : { none: true }),
      ];
      const body = bodyOf(x);
      d.blocks = blockEls(body ? bodyBlocks(body) : [{ p: '본문이 비어 있어요. 편집에서 내용을 적을 수 있어요.' }], !body);
      d.groups.push(grp('관련 메모', noteRows(notesLinked('taskId', x.id))));
      d.foot = [h('button', { type: 'button', class: 'btn outline', id: 'dt-done', onclick: () => setDone(x.id, !done), text: done ? '완료 취소' : '완료' }), editBtn()];
      return d;
    }
    if (ref.type === 'goal') {
      const tier = TIERS.find(t => t[0] === goalTier(x));
      d.tag = '목표 · ' + tier[1];
      d.title = itemTitle(x);
      const kind = pcStr(x, 'goalType').trim() || CAT_LABEL[x.category] || CAT_LABEL[pcStr(x, 'category')] || '';
      const parent = liveItem(pcStr(x, 'parentId'), 'goal');
      d.props = [prop('분류', kind || '없음', { none: !kind }),
        prop('상위 목표', parent ? itemTitle(parent) : '없음', parent ? { link: () => openRef({ type: 'goal', id: parent.id }, 'link') } : { none: true })];
      const due = parseYmd(x.dueDate);
      if (due) d.extra.push(h('div', { class: 'card props' }, prop('기한', dLabel(due), x.status !== 'done' ? { chip: dday(due) } : {})));
      if (x.status !== 'active' && GOAL_STATUS.some(s => s[0] === x.status)) d.extra.push(h('div', { class: 'card props' }, prop('상태', '', { chip: x.status === 'done' ? '달성' : '보류' })));
      const outcome = typeof x.desiredResult === 'string' ? x.desiredResult.trim() : '';
      if (outcome) d.outcome = outcome;
      const body = bodyOf(x);
      d.blocks = body ? blockEls(bodyBlocks(body)) : [];
      const goals = liveItems('goal'), projects = liveItems('project');
      d.groups.push(grp('하위 목표', goals.filter(g => pcStr(g, 'parentId') === x.id).map(g => iconRow('goal', g.id, 'target', null, itemTitle(g), '', 'link'))));
      d.groups.push(grp('관련 프로젝트', projects.filter(p => p.parentId === x.id).map(p => iconRow('project', p.id, 'folder', null, itemTitle(p), STAGE[stageOf(p)], 'link')), { keep: true, empty: '연결된 프로젝트가 없어요' }));
      d.groups.push(grp('관련 할 일', liveItems('task').filter(t => pcStr(t, 'parentId') === x.id).map(subTask)));
      d.groups.push(grp('관련 메모', noteRows(notesLinked('parentId', x.id))));
      d.foot = [editBtn()];
      return d;
    }
    if (ref.type === 'project') {
      const stage = stageOf(x);
      d.tag = '프로젝트 · ' + STAGE[stage];
      d.title = itemTitle(x);
      const goal = liveItem(x.parentId, 'goal');
      const [a, b] = shortRange(pcStr(x, 'startDate'), pcStr(x, 'endDate'));
      const due = parseYmd(x.dueDate);
      const period = a && b ? a + ' – ' + b : a ? a + ' –' : b ? '~ ' + b : due ? '~ ' + (due.getMonth() + 1) + '.' + due.getDate() : '';
      d.props = [prop('상태', '', { chip: STAGE[stage], hot: stage === 'active' }),
        prop('관련 목표', goal ? itemTitle(goal) : '연결 안 함', goal ? { link: () => openRef({ type: 'goal', id: goal.id }, 'link') } : { none: true }),
        prop('기간', period || '정하지 않음', { none: !period })];
      if (CAT_LABEL[x.category]) d.extra.push(h('div', { class: 'card props' }, prop('분류', CAT_LABEL[x.category])));
      const body = bodyOf(x);
      d.blocks = body ? blockEls(bodyBlocks(body)) : [];
      const tasks = liveItems('task').filter(t => t.projectId === x.id);
      d.groups.push(grp('연결된 할 일', tasks.map(subTask), { keep: true, empty: '연결된 할 일이 없어요', add: { label: '이 프로젝트에 할 일 추가', run: () => startNew('task', { projectId: x.id }) } }));
      d.groups.push(grp('관련 메모', noteRows(notesLinked('projectId', x.id))));
      d.foot = [editBtn()];
      return d;
    }
    // note
    d.tag = '메모 · ' + dShort(parseYmd(x.date) || startOfDay(new Date(x.updatedAt)));
    d.title = noteTitle(x);
    const body = x.title.trim() ? x.body.trim() : x.body.trim().split('\n').slice(1).join('\n').trim();
    d.blocks = blockEls(body ? bodyBlocks(body) : [{ p: '아직 내용이 없어요.' }], !body, true);
    const rel = [];
    const proj = liveItem(pcStr(x, 'projectId'), 'project');
    if (proj) rel.push(iconRow('project', proj.id, 'folder', null, itemTitle(proj), '프로젝트', 'link'));
    for (const key of noteEventKeys(x)) {
      const event = S.events.find(e => sharedEventKey(e) === key);
      if (event) rel.push(iconRow('event', event.k, 'cal', safeColor(event.c), event.t, 'Google 일정', 'link'));
    }
    const task = liveItem(pcStr(x, 'taskId'), 'task');
    if (task) rel.push(subTask(task));
    const goal = liveItem(pcStr(x, 'parentId'), 'goal');
    if (goal) rel.push(iconRow('goal', goal.id, 'target', null, itemTitle(goal), '목표', 'link'));
    d.groups.push(grp('연결된 항목', rel));
    d.foot = [editBtn()];
    return d;
  }

  const meetLink = u => httpsLink(u, ['meet.google.com']);

  function fileKind(mime) {
    if (mime === GDOC_MIME) return '문서';
    if (mime === 'application/vnd.google-apps.spreadsheet') return '스프레드시트';
    if (mime === 'application/vnd.google-apps.presentation') return '프레젠테이션';
    if (mime === 'application/pdf') return 'PDF';
    if (/^image\//.test(mime || '')) return '이미지';
    return '파일';
  }

  // attachments open only on allowed https Google hosts; anything else is listed as "열 수 없는 링크"
  function attachRow(a) {
    const title = (typeof a.t === 'string' && a.t.trim()) || '첨부파일';
    const url = attachLink(a.u);
    const kids = [h('span', { class: 'ibox' }, icon('link')), h('span', { class: 'main' }, h('span', { class: 'tt', text: title })),
      h('span', { class: 'rt aside', text: url ? fileKind(a.m) : '열 수 없는 링크' })];
    if (!url) return h('div', { class: 'row ic att off' }, kids);
    return h('a', { class: 'row ic att', href: url, target: '_blank', rel: 'noopener noreferrer' }, kids, icon('ext', 'go'));
  }

  function renderDetail(layer) {
    const box = $('#detail');
    const same = box.dataset.uid === String(layer.uid) && $('#dt-body');
    const keep = same ? $('#dt-body').scrollTop : 0;
    const d = buildDetail(layer.ref);
    const body = h('div', { class: 'page-body', id: 'dt-body' },
      h('span', { class: 'd-tag', id: 'dt-tag' }, d.dot ? h('i', { style: { '--c': d.dot } }) : null, d.tag),
      h('h1', { class: 'd-title' + (d.done ? ' done' : ''), id: 'dt-title', text: d.title }),
      d.banner ? h('div', { class: 'd-banner' }, icon('lock'), h('span', { text: d.banner })) : null,
      d.tiles || null,
      d.props && d.props.length ? h('div', { class: 'card props', id: 'dt-props' }, d.props) : null,
      d.outcome ? h('div', { class: 'outcome', id: 'dt-outcome' }, h('span', { class: 'l', text: '원하는 결과' }), h('span', { class: 'v', text: d.outcome })) : null,
      d.blocks,
      d.groups.filter(Boolean),
      d.extra.length ? h('details', { class: 'secondary' }, h('summary', { text: '추가 정보' }), d.extra) : null);
    box.replaceChildren(
      h('div', { class: 'page-bar' }, backBtn('dt-back'), d.editable ? h('button', { type: 'button', class: 'edit-link', id: 'dt-edit', onclick: d.onEdit, text: '편집' }) : h('span')),
      body,
      d.foot.length ? h('div', { class: 'page-foot', id: 'dt-foot' }, d.foot) : null);
    box.hidden = false;
    box.dataset.uid = String(layer.uid);
    body.scrollTop = keep;
  }

  // ------------------------------------------------------------------ editor (explicit 저장 / 취소; drafts are never lost silently)
  const TYPE_NAME = { task: '할 일', goal: '목표', project: '프로젝트', note: '메모' };
  const TYPE_OBJ = { task: '할 일을', goal: '목표를', project: '프로젝트를', note: '메모를' };

  function draftOf(type, x) {
    x = x || {};
    if (type === 'task') return { t: x.title || '', body: bodyOf(x), status: isWait(x) ? 'waiting' : 'next', plan: DATE_RE.test(x.plannedDate || '') ? x.plannedDate : '', due: DATE_RE.test(x.dueDate || '') ? x.dueDate : '', proj: x.projectId || '' };
    if (type === 'goal') return { t: x.title || '', body: bodyOf(x), outcome: typeof x.desiredResult === 'string' ? x.desiredResult : '', horizon: TIERS.some(t => t[0] === x.horizon) ? x.horizon : 'one-year', status: GOAL_STATUS.some(s => s[0] === x.status) ? x.status : 'active', due: DATE_RE.test(x.dueDate || '') ? x.dueDate : '' };
    if (type === 'project') return { t: x.title || '', body: bodyOf(x), status: PROJECT_GROUPS.some(g => g[0] === x.status) ? x.status : 'active', cat: CAT_LABEL[x.category] ? x.category : '', goal: x.parentId || '', due: DATE_RE.test(x.dueDate || '') ? x.dueDate : '' };
    return { t: x.title || '', body: x.body || '', date: DATE_RE.test(x.date || '') ? x.date : '' };
  }

  function startEdit(ref) {
    const x = refTarget(ref);
    if (!x || ref.type === 'event') return;
    const draft = draftOf(ref.type, x);
    pushLayer({ kind: 'edit', type: ref.type, id: ref.id, baseUpdatedAt: x.updatedAt, draft, orig: JSON.parse(JSON.stringify(draft)) });
  }

  function startNew(type, base) {
    const draft = draftOf(type, base);
    pushLayer({ kind: 'edit', type, id: null, base: base || {}, draft, orig: JSON.parse(JSON.stringify(draft)) });
  }

  function segCtl(id, opts, value, onPick) {
    const box = h('div', { class: 'seg', role: 'group', id });
    const paint = v => { for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset.v === v)); };
    for (const [v, label] of opts) box.append(h('button', { type: 'button', 'data-v': v, onclick: () => { paint(v); onPick(v); } }, label));
    paint(value);
    return box;
  }

  function dateCtl(id, value, onChange) {
    const input = h('input', { type: 'date', id, tabindex: '-1', 'aria-hidden': 'true' });
    const select = h('select', { 'aria-label': '날짜 고르기' });
    const today = startOfDay(S.now);
    const paint = v => {
      select.replaceChildren(h('option', { value: '', text: '없음' }));
      const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      const dates = [];
      for (let d = today; d <= end; d = addDays(d, 1)) dates.push(ymd(d));
      if (parseYmd(v) && !dates.includes(v)) dates.push(v);
      dates.sort().forEach(key => {
        const d = parseYmd(key), n = daysBetween(today, d);
        select.append(h('option', { value: key, text: dShort(d) + (n === 0 ? ' · 오늘' : n === 1 ? ' · 내일' : '') }));
      });
      select.append(h('option', { value: 'custom', text: '다른 날짜 선택…' }));
      select.value = parseYmd(v) ? v : '';
      input.value = select.value;
    };
    input.addEventListener('change', () => { const v = DATE_RE.test(input.value) ? input.value : ''; onChange(v); paint(v); });
    select.addEventListener('change', () => {
      if (select.value === 'custom') {
        select.value = input.value;
        if (typeof input.showPicker === 'function') { try { input.showPicker(); } catch (_) { input.focus(); input.click(); } }
        else { input.focus(); input.click(); }
      } else { const v = select.value; onChange(v); paint(v); }
    });
    paint(value);
    return h('div', { class: 'date-wrap' }, h('div', { class: 'date-box' }, select, input));
  }

  function renderEditor(layer) {
    const box = $('#editor');
    const isNew = !layer.id, type = layer.type, dr = layer.draft;
    const x = isNew ? null : refTarget({ type, id: layer.id });
    const saveBtn = h('button', { type: 'button', class: 'save', id: 'ed-save', onclick: () => saveEditor(layer) }, '저장');
    const dirtyLine = h('div', { class: 'ed-dirty', id: 'ed-dirty' });
    const update = () => {
      const dirty = editDirty(layer);
      const ok = type === 'note' ? !!(dr.t.trim() || dr.body.trim()) : !!dr.t.trim();
      saveBtn.disabled = !ok;
      dirtyLine.classList.toggle('on', dirty);
      dirtyLine.textContent = dirty ? '저장하지 않은 변경이 있어요' : isNew ? '새로 작성 중' : '변경 없음';
    };
    const set = patch => { Object.assign(dr, patch); update(); };
    const title = h('input', { id: 'ed-title', class: 'ed-title', type: 'text', maxlength: '500', autocomplete: 'off', enterkeyhint: 'done', placeholder: '제목 · 주제부터 짧게', 'aria-label': '제목' });
    title.value = dr.t;
    title.addEventListener('input', () => set({ t: title.value }));
    title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); title.blur(); } });
    const fld = (label, ctl, cls, hint) => h('div', { class: 'fld' }, h('span', { class: 'l' + (cls ? ' ' + cls : '') }, label, hint ? h('span', { class: 'hint2', text: hint }) : null), ctl);
    const fields = [title], extra = [];

    if (type === 'task') {
      const hint = h('span', { class: 'h' });
      const paintHint = () => { hint.textContent = dr.status === 'waiting' ? '대기는 실행일이 있어도 대기에 남아요.' : dr.plan ? '실행일이 있어서 ‘예정’에 보여요. 마감 알림은 마감일에만 생겨요.' : '실행일이 없으면 ‘다음’에 보여요.'; };
      paintHint();
      fields.push(h('div', { class: 'fld task-state' }, h('span', { class: 'l', text: '상태' }),
        segCtl('ed-status', [['next', '다음'], ['waiting', '대기']], dr.status, v => { set({ status: v }); paintHint(); }), hint));
      fields.push(fld('실행일 · 하기로 한 날', dateCtl('ed-plan', dr.plan, v => { set({ plan: v }); paintHint(); })));
      fields.push(fld('마감일 · 실제 기한', dateCtl('ed-due', dr.due, v => set({ due: v })), 'due'));
      const projects = liveItems('project').filter(p => (!isArchived(p) && ['active', 'preparing'].includes(projStatus(p))) || p.id === dr.proj);
      const sel = h('select', { id: 'ed-proj', 'aria-label': '프로젝트' }, h('option', { value: '', text: '연결 안 함' }), projects.map(p => h('option', { value: p.id, text: itemTitle(p) })));
      sel.value = projects.some(p => p.id === dr.proj) ? dr.proj : '';
      sel.addEventListener('change', () => set({ proj: sel.value }));
      fields.push(fld('프로젝트 · 선택', sel));
    } else if (type === 'goal') {
      const area = h('textarea', { id: 'ed-outcome', rows: '3', placeholder: '이 목표를 이루면 어떤 상태가 되나요?', 'aria-label': '원하는 결과', maxlength: '20000' });
      area.value = dr.outcome;
      area.addEventListener('input', () => set({ outcome: area.value }));
      fields.push(fld('원하는 결과', area));
      extra.push(fld('구분', segCtl('ed-horizon', [['ultimate', '최종'], ['five-year', '5년'], ['one-year', '1년']], dr.horizon, v => set({ horizon: v }))));
      extra.push(fld('상태', segCtl('ed-gstatus', GOAL_STATUS, dr.status, v => set({ status: v }))));
      extra.push(fld('기한', dateCtl('ed-due', dr.due, v => set({ due: v }))));
    } else if (type === 'project') {
      extra.push(fld('상태', segCtl('ed-pstatus', [['preparing', '준비 중'], ['active', '진행 중'], ['paused', '보류'], ['done', '완료']], dr.status, v => set({ status: v }))));
      const goals = liveItems('goal');
      const sel = h('select', { id: 'ed-goal', 'aria-label': '관련 목표' }, h('option', { value: '', text: '연결 안 함' }), goals.map(g => h('option', { value: g.id, text: itemTitle(g) })));
      sel.value = goals.some(g => g.id === dr.goal) ? dr.goal : '';
      sel.addEventListener('change', () => set({ goal: sel.value }));
      extra.push(fld('관련 목표 · 선택', sel));
      extra.push(fld('분류', segCtl('ed-cat', [['', '없음'], ['work', '업무'], ['personal', '개인'], ['study', '학습']], dr.cat, v => set({ cat: v }))));
      extra.push(fld('기한', dateCtl('ed-due', dr.due, v => set({ due: v }))));
    } else {
      extra.push(fld('날짜', dateCtl('ed-date', dr.date, v => set({ date: v }))));
    }

    {
      const area = h('textarea', { id: 'ed-text', class: 'body', placeholder: '자세한 내용은 여기에 적어요.', 'aria-label': '본문' });
      area.value = dr.body;
      area.addEventListener('input', () => set({ body: area.value }));
      fields.push(fld('본문', area, null, '## 소제목 · - 목록'));
    }
    if (!isNew) extra.push(h('button', { type: 'button', class: 'ed-del', id: 'ed-delete', onclick: () => askDelete(layer), text: TYPE_NAME[type] + ' 삭제' }));
    if (extra.length) fields.push(h('details', { class: 'secondary' }, h('summary', { text: '추가 설정' }), extra));

    box.replaceChildren(
      h('div', { class: 'ed-bar' },
        h('button', { type: 'button', class: 'cancel', id: 'ed-cancel', onclick: () => cancelEditor(layer), text: '취소' }),
        h('span', { class: 'hd', id: 'ed-heading', text: isNew ? '새 ' + TYPE_NAME[type] : TYPE_NAME[type] + ' 편집' }),
        saveBtn),
      dirtyLine,
      h('div', { class: 'ed-body', id: 'ed-body' }, fields));
    box.hidden = false;
    box.dataset.uid = String(layer.uid);
    update();
    if (isNew) setTimeout(() => { if (!box.hidden && box.dataset.uid === String(layer.uid)) title.focus(); }, 60);
  }

  function cancelEditor(layer) {
    if (editDirty(layer)) askLeave(layer, () => { S.allowDiscard = true; closeTop(); }, '나가기');
    else closeTop();
  }

  function makeItem(kind) {
    const now = Date.now();
    const it = { id: uid(), kind, title: '', createdAt: now, updatedAt: now };
    if (kind === 'goal') Object.assign(it, { horizon: 'one-year', status: 'active', desiredResult: null, dueDate: null });
    else if (kind === 'project') Object.assign(it, { status: 'active', category: null, parentId: null, dueDate: null });
    else Object.assign(it, { status: 'next', projectId: null, dueDate: null, plannedDate: null, completedAt: null });
    return it;
  }

  // returns true when saved; stay: keep the layer (the caller navigates next)
  function saveEditor(layer, stay) {
    const d = layer.draft, type = layer.type, title = d.t.trim();
    if (type === 'note' ? !(title || d.body.trim()) : !title) { toast(type === 'note' ? '제목이나 내용을 적어 주세요' : '제목을 적어 주세요'); return false; }
    let id = layer.id;
    const current = id ? (type === 'note' ? noteById(id) : itemById(id)) : null;
    if (id && (!current || current.deleted || current.updatedAt !== layer.baseUpdatedAt)) {
      toast('다른 기기에서 바뀐 항목이에요. 작성한 내용을 복사한 뒤 다시 열어 주세요.');
      return false;
    }
    if (type !== 'note' && d.body !== layer.orig.body && current && current.pc != null && !isObj(current.pc)) {
      toast('다른 버전의 상세 정보가 있어 본문을 덮어쓸 수 없어요. 앱을 업데이트해 주세요.');
      return false;
    }
    if (type === 'note') {
      let n = id ? noteById(id) : null;
      if (!n || n.deleted) { const now = Date.now(); n = { id: uid(), title: '', body: '', date: null, createdAt: now, updatedAt: now }; S.notes.push(n); }
      n.title = d.t.trim().slice(0, 500);
      n.body = d.body.slice(0, 200000);
      n.date = DATE_RE.test(d.date) ? d.date : null;
      n.updatedAt = Date.now();
      id = n.id;
      persistNotes();
    } else {
      let it = id ? itemById(id) : null;
      if (!it || it.deleted) { it = makeItem(type); S.ws.items.push(it); }
      it.title = title.slice(0, 500);
      // Body is the existing shared desktop field. Change only this key; keep every other pc key.
      if (d.body !== layer.orig.body) it.pc = Object.assign({}, isObj(it.pc) ? it.pc : {}, { body: d.body.slice(0, 200000) });
      if (type === 'task') {
        const wasWait = isWait(it);
        if (d.status === 'waiting') { if (!wasWait) it.status = 'waiting'; }
        else if (it.status !== 'done' && (wasWait || (it.status === 'scheduled' && !d.plan))) it.status = 'next';
        it.plannedDate = d.plan || null;
        it.dueDate = d.due || null;
        it.projectId = d.proj || null;
      } else if (type === 'goal') {
        it.desiredResult = d.outcome.trim() ? d.outcome.slice(0, 20000) : null;
        it.horizon = d.horizon;
        it.status = d.status;
        it.dueDate = d.due || null;
      } else {
        it.status = d.status;
        it.category = d.cat || null;
        it.parentId = d.goal || null;
        it.dueDate = d.due || null;
      }
      it.updatedAt = Date.now();
      id = it.id;
      persistWs();
    }
    const fresh = !layer.id;
    layer.orig = JSON.parse(JSON.stringify(layer.draft));
    layer.baseUpdatedAt = (type === 'note' ? noteById(id) : itemById(id)).updatedAt;
    if (stay) { layer.id = id; return true; }
    if (fresh) {
      toast('새로 만들었어요');
      replaceTop({ kind: 'detail', ref: { type, id } });
    } else {
      toast('저장했어요 · 다른 기기에도 동기화돼요');
      closeTop();
    }
    return true;
  }

  function askDelete(layer) {
    showSheet({
      title: '이 ' + TYPE_OBJ[layer.type] + ' 삭제할까요?', text: '연결된 다른 기기에서도 함께 사라져요.',
      actions: [{ label: '삭제', cls: 'outline danger', run: () => {
        if (layer.type === 'note') {
          const n = noteById(layer.id);
          if (n) { n.deleted = true; n.title = ''; n.body = ''; n.updatedAt = Date.now(); persistNotes(); }
        } else {
          touchItem(layer.id, x => { x.deleted = true; x.title = ''; if (x.desiredResult != null) x.desiredResult = null; });
        }
        layer.orig = JSON.parse(JSON.stringify(layer.draft));
        const below = S.layers[S.layers.length - 2];
        const both = below && below.kind === 'detail' && below.ref.id === layer.id;
        closeLayers(both ? 2 : 1);
        toast(TYPE_OBJ[layer.type] + ' 삭제했어요');
      } }],
      keep: '취소',
    });
  }

  // ------------------------------------------------------------------ completing tasks
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
    render();
    if (done && !quiet) toast('‘' + itemTitle(t) + '’ 완료 · 보관함으로 옮겼어요', { label: '되돌리기', run: () => setDone(id, false, true) });
  }

  // ------------------------------------------------------------------ + button
  function updateFab() {
    let label = '할 일';
    if (S.tab === 'goals') label = S.gseg === 'projects' ? '프로젝트' : '목표';
    else if (S.tab === 'notes') label = '메모';
    $('#fab-label').textContent = label;
    $('#fab').setAttribute('aria-label', label + ' 추가');
  }

  function fabNew() {
    const today = ymd(startOfDay(S.now));
    if (S.tab === 'cal') startNew('task', { plannedDate: ymd(S.sel) });
    else if (S.tab === 'tasks') startNew('task', S.status === 'wait' ? { status: 'waiting' } : S.status === 'plan' ? { plannedDate: today } : {});
    else if (S.tab === 'goals') startNew(S.gseg === 'projects' ? 'project' : 'goal', S.gseg === 'projects' ? { status: S.pseg } : { horizon: 'one-year' });
    else startNew('note', { date: today });
  }

  // ------------------------------------------------------------------ settings and the Android 알림 page
  function openSettings() {
    S.confirmWipe = false;
    const top = topLayer();
    if (top && (top.kind === 'settings' || top.kind === 'notify')) return;
    pushLayer({ kind: 'settings' });
  }

  function openNotify() {
    S.quietOpen = false;
    pushLayer({ kind: 'notify' });
    if (native) { updateBriefing({ type: 'briefing:get' }); updatePush({ type: 'push:get' }); }
  }

  function renderSettings() {
    const top = topLayer();
    if (top && (top.kind === 'settings' || top.kind === 'notify') && !$('#settings').hidden) renderSettingsPage(top);
  }

  function renderSettingsPage(layer) {
    const box = $('#settings');
    const same = box.dataset.uid === String(layer.uid) && $('#st-body');
    const keep = same ? $('#st-body').scrollTop : 0;
    const body = h('div', { class: 'st-body', id: 'st-body' }, layer.kind === 'notify' ? notifyContent() : settingsContent());
    box.replaceChildren(h('div', { class: 'page-bar' }, backBtn('st-close')), body);
    box.hidden = false;
    box.dataset.uid = String(layer.uid);
    body.scrollTop = keep;
  }

  const stHead = (title, sub) => h('div', { class: 'st-head' }, h('b', { text: title }), h('span', { text: sub }));
  const stSec = (title, note, ...kids) => h('section', { class: 'st-sec' },
    title ? h('div', { class: 'sec-h' }, h('span', { class: 't', text: title }), note ? h('span', { class: 'nt', text: note }) : null) : null, kids);
  function stRow(o) {
    const kids = [
      o.dot ? h('span', { class: 's-dot', style: { '--tone': 'var(--' + o.dot + ')' } }) : null,
      h('span', { class: 'k' }, o.k, o.small ? h('small', { text: o.small }) : null),
      o.v != null ? h('span', { class: 'v' + (o.vCls ? ' ' + o.vCls : ''), id: o.vid || null, text: o.v }) : null,
      o.ctl || null,
      o.onclick ? icon('chev', 'go') : null,
    ];
    return o.onclick ? h('button', { type: 'button', class: 'st-row btnrow', id: o.id || null, onclick: o.onclick }, kids) : h('div', { class: 'st-row', id: o.id || null }, kids);
  }
  const switchEl = (id, on, label, onChange, disabled) => h('button', {
    type: 'button', class: 'switch', role: 'switch', id, 'aria-checked': String(!!on), 'aria-label': label, disabled: disabled ? true : null, onclick: () => onChange(!on),
  });
  const timeText = ms => { const d = new Date(ms); return sameDay(d, new Date()) ? hm(d) : md(d) + ' ' + hm(d); };
  const stLine = (t, text, id) => h('div', { class: 'st-line', id: id || null }, h('span', { class: 't', text: t }), h('span', { text }));

  // the seven connection states of the design (first / ok / syncing / offline / reauth / partial / fail)
  function syncState() {
    if (!native && !clientId()) return { k: 'setup', tone: 'info', title: 'Google 연결 준비가 필요해요', desc: '아래 웹 클라이언트 ID를 넣으면 Google 계정을 연결할 수 있어요. 지금 쓰는 내용은 이 기기에 저장돼요.' };
    if (!prefs.connected) return { k: 'first', tone: 'info', title: 'Google 계정을 연결해 주세요', desc: '연결하면 Google 캘린더 일정을 읽어 오고, 할 일·목표·메모를 다른 기기와 맞춰요.', action: 'Google 계정 연결', run: connect };
    if (S.sync === 'busy') return { k: 'syncing', tone: 'info', title: '동기화 중…', desc: '계속 사용해도 돼요.' };
    if (!tokenValid()) return { k: 'reauth', tone: 'err', title: 'Google 연결이 만료됐어요', action: '다시 연결', run: connect,
      desc: native ? '새 일정을 읽어 오지 못하고 있어요. 다시 연결하면 이어서 동기화해요.' : '보안을 위해 한 시간마다 다시 확인해요. 다시 연결하면 이어서 동기화해요.' };
    if (S.sync === 'error' && S.syncKind === 'offline') return { k: 'offline', tone: 'warn', title: '오프라인 · 이 기기에만 저장 중', desc: '바꾼 내용은 이 기기에 저장돼 있어요. 인터넷이 다시 연결되면 동기화해요.', action: '다시 시도', run: syncAll };
    if (S.sync === 'error') return { k: 'fail', tone: 'err', title: '동기화하지 못했어요', desc: S.syncMsg || '잠시 후 다시 시도해 주세요.', action: '다시 시도', run: syncAll };
    if (!S.canCal) return { k: 'partial', tone: 'warn', title: '캘린더 읽기 권한이 없어요', desc: '할 일·메모 동기화는 정상이에요. Google 일정을 보려면 캘린더 읽기 권한을 허용해 주세요.', action: '권한 확인', run: () => requestToken('consent') };
    if (!S.canDrive) return { k: 'partial', tone: 'warn', title: '드라이브 권한이 없어요', desc: '메모와 할 일은 이 기기에만 저장돼요. 다른 기기와 맞추려면 드라이브 권한을 허용해 주세요.', action: '권한 확인', run: () => requestToken('consent') };
    return { k: 'ok', tone: 'ok', title: '동기화됨' + (S.lastSync ? ' · ' + hm(new Date(S.lastSync)) : ''), desc: '모든 기기와 맞춰져 있어요.', action: '지금 동기화', run: syncAll };
  }

  function settingsContent() {
    const out = [stHead('설정', '이 기기의 화면과 Google 연결')];
    const more = [];
    const design = look.design === 'B' ? 'B' : 'A';
    const designs = [['A', '차분한 플래너', '부드러운 보라 · 둥근 체크 · 여유 있는 간격'], ['B', '업무 대시보드', '검정과 빨강 · 네모 체크 · 또렷한 대비']];
    out.push(stSec('화면', '이 기기에만 적용돼요', h('div', { class: 'st-card', id: 'st-look' },
      h('div', { class: 'st-block', role: 'radiogroup', 'aria-label': '디자인' }, h('span', { class: 'l', text: '디자인' }),
        designs.map(([k, label, desc]) => h('button', { type: 'button', class: 'radio', role: 'radio', id: 'st-design-' + k, 'aria-checked': String(design === k), onclick: () => setLook({ design: k }) },
          h('span', { class: 'rd' }), h('span', { class: 'rt' }, h('b', { text: label }), h('span', { text: desc }))))),
      h('div', { class: 'st-block' }, h('span', { class: 'l', text: '테마' }),
        segCtl('st-theme', [['light', '라이트'], ['dark', '다크'], ['system', '시스템 따름']], look.theme === 'light' || look.theme === 'dark' ? look.theme : 'system', v => setLook({ theme: v })),
        h('span', { class: 'h', text: '시스템 따름을 고르면 기기의 밝기 설정에 맞춰 바뀌어요.' })))));

    const st = syncState();
    const acct = [h('div', { class: 'st-state tone-' + st.tone, id: 'st-state', 'data-state': st.k },
      h('div', { class: 'top' }, h('span', { class: 's-dot' }), h('div', null, h('b', { text: st.title }), h('span', { text: st.desc }))),
      prefs.connected ? h('div', { class: 'acct' }, h('span', null, 'Google 일정 ', h('b', { text: '읽기 전용' })),
        h('span', null, '마지막 동기화 ', h('b', { text: S.lastSync ? hm(new Date(S.lastSync)) : '아직 없음' }))) : null,
      st.action ? h('button', { type: 'button', class: 'act', id: 'st-action', onclick: st.run, text: st.action }) : null)];
    if (prefs.connected) {
      const copyOn = tokenValid() ? S.canDrive && S.canCopy : !!prefs.copy;
      const btns = [];
      const doc = driveId(prefs.docId);
      if (copyOn && doc) btns.push(h('a', { class: 'btn outline', id: 'st-doc', href: 'https://docs.google.com/document/d/' + doc + '/edit', target: '_blank', rel: 'noopener noreferrer' }, '드라이브에서 열기', icon('ext')));
      if (!copyOn && tokenValid()) btns.push(h('button', { type: 'button', class: 'btn outline', onclick: () => requestToken('consent'), text: '다시 연결' }));
      if (st.action !== '지금 동기화') btns.push(h('button', { type: 'button', class: 'btn outline', disabled: tokenValid() ? null : true, onclick: syncAll, text: '지금 동기화' }));
      btns.push(h('button', { type: 'button', class: 'btn outline', id: 'st-disconnect', onclick: disconnect, text: '연결 해제' }));
      acct.push(h('div', { class: 'st-card' },
        stRow({ id: 'st-conn', k: '연결', small: tokenValid() ? [S.canCal ? '일정 읽기' : '', S.canDrive ? '메모·할 일 동기화' : ''].filter(Boolean).join(' · ') || '받은 권한이 없어요' : '다시 연결하면 동기화를 이어 가요',
          v: tokenValid() ? '연결됨' : '다시 연결 필요', vCls: tokenValid() ? 'ok' : 'off' }),
        stRow({ id: 'st-copy', k: '드라이브에서 보기', small: copyOn ? "드라이브의 MyPlanner 폴더에 '메모' 문서로 보여요. 문서에서 고친 내용은 앱에 반영되지 않아요." : null, v: copyOn ? '켜짐' : '꺼짐 — 다시 연결하면 켜져요' }),
        h('div', { class: 'st-btns' }, btns)));
    }
    out.push(stSec('Google 계정', 'Google 캘린더는 읽기만 해요', acct));

    if (native) out.push(stSec('알림', 'Android 앱 전용', h('div', { class: 'st-card' }, stRow({ id: 'st-notify', k: '알림', small: '정기 브리핑 · 외부 알림 · 진동 방식', onclick: openNotify }))));

    more.push(stSec('데이터', '이 기기로 내려받기', h('div', { class: 'st-card' }, h('div', { class: 'st-btns' },
      h('button', { type: 'button', class: 'btn outline', id: 'st-export-notes', onclick: exportNotes, text: '메모 내보내기 (JSON)' }),
      h('button', { type: 'button', class: 'btn outline', id: 'st-export-ws', onclick: exportWorkspace, text: '할 일·목표 내보내기 (JSON)' })))));

    if (!native) {
      const field = h('input', { id: 'st-client', type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: '1234567890-xxxx.apps.googleusercontent.com', 'aria-label': '웹 클라이언트 ID' });
      field.value = prefs.clientId || '';
      more.push(stSec('웹 클라이언트 ID', '브라우저에서만', h('div', { class: 'st-card' }, h('div', { class: 'st-field' },
        h('p', { text: DEFAULT_CLIENT_ID ? '기본 ID가 들어 있어요. 다른 ID를 쓰려면 아래에 넣으세요.' : 'Google 연결에 쓰는 공개 ID예요 (비밀번호가 아니에요). 한 번만 만들면 됩니다.' }),
        h('ol', null,
          h('li', null, 'Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보'),
          h('li', null, '사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 유형 "웹 애플리케이션"'),
          h('li', null, '승인된 JavaScript 원본에 ', h('code', { text: location.origin.startsWith('https://') ? location.origin : 'https://anewbyeol.kr' }), ' 추가'),
          h('li', null, '라이브러리에서 Google Calendar API와 Google Drive API 사용 설정'),
          h('li', null, '만든 클라이언트 ID를 아래에 붙여 넣고 저장')),
        field,
        h('button', { type: 'button', class: 'btn outline small', id: 'st-client-save', text: '저장', onclick: () => {
          const v = field.value.trim();
          if (v && !CLIENT_ID_RE.test(v)) { toast('클라이언트 ID 형식이 아니에요. "...apps.googleusercontent.com"으로 끝나야 해요.'); return; }
          prefs.clientId = v;
          savePrefs();
          tokenClient = null;
          if (clientId()) { loadGis(); initTokenClient(); }
          toast(v ? '저장했어요. 이제 Google로 연결할 수 있어요.' : '기본값으로 되돌렸어요.');
          renderSettings();
        } })))));
    }

    let wipe;
    if (!S.confirmWipe) {
      wipe = stRow({ id: 'st-wipe', k: h('span', { class: 'danger-text', text: '이 기기에서 지우기' }), small: '이 기기에 저장된 메모·할 일·일정 캐시를 지워요', onclick: () => { S.confirmWipe = true; renderSettings(); } });
    } else {
      const count = liveNotes().length, items = S.ws.items.filter(i => !i.deleted && keepItem(i)).length;
      wipe = h('div', { class: 'st-field' },
        h('p', { text: '이 기기에 저장된 메모 ' + count + '개, 할 일·목표 ' + items + '개와 일정 캐시를 지워요. ' + (S.dirty || S.wsDirty || !S.canDrive ? '드라이브에 동기화되지 않은 내용은 되살릴 수 없어요.' : '드라이브에 있는 내용은 다시 연결하면 돌아와요.') }),
        h('div', { class: 'st-btns' },
          h('button', { type: 'button', class: 'btn outline danger-text', id: 'st-wipe-yes', text: '지우기', onclick: wipeDevice }),
          h('button', { type: 'button', class: 'btn outline', text: '취소', onclick: () => { S.confirmWipe = false; renderSettings(); } })));
    }
    more.push(stSec('이 기기', null, h('div', { class: 'st-card' }, wipe)));
    out.push(h('details', { class: 'secondary', open: S.settingsMore ? true : null,
      ontoggle: ev => { S.settingsMore = ev.currentTarget.open; } }, h('summary', { text: '데이터·연결 고급 설정' }), more));
    return out;
  }

  // ---- 알림 (Android app only): periodic briefing and external pushes, both through the native bridge
  async function updatePush(msg) {
    if (!native || pushBusy) return;
    const epoch = authEpoch;
    pushBusy = true; renderSettings();
    const result = await nativeRequest(msg);
    pushBusy = false;
    if (epoch !== authEpoch) { renderSettings(); return; }
    let saved = '';
    if (result.type === 'push:state' && ['enabled', 'registered', 'canNotify', 'configured'].every(k => typeof result[k] === 'boolean') &&
        Number.isFinite(result.lastReceivedAt) && result.lastReceivedAt >= 0) {
      pushState = Object.fromEntries(['enabled', 'registered', 'canNotify', 'configured', 'lastReceivedAt'].map(k => [k, result[k]]));
      pushState.vibrationMode = ['repeat10', 'untilAcknowledged'].includes(result.vibrationMode) ? result.vibrationMode : null;
      pushState.deviceLabel = typeof result.deviceLabel === 'string' ? result.deviceLabel.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
      pushState.versionName = typeof result.versionName === 'string' && /^[0-9]+(?:\.[0-9]+){1,3}$/.test(result.versionName) ? result.versionName : '';
      pushState.canOpenNotificationSettings = result.canOpenNotificationSettings === true;
      const messages = {
        firebase_config_missing: '외부 알림을 준비 중이에요. 앱 업데이트 후 다시 확인해 주세요.',
        needs_google_connection: 'Google 계정을 다시 연결해 주세요.',
        drive_permission: 'Google 계정을 다시 연결하고 동기화 권한을 허용해 주세요.',
        busy: '등록을 마치는 중이에요. 잠시 후 다시 확인해 주세요.',
        invalid_vibration_mode: '지원하지 않는 진동 방식이에요. 앱을 업데이트하고 다시 시도해 주세요.',
        registration_cleanup_failed: '기기 등록 해제를 확인하지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.',
      };
      pushMessage = typeof result.error === 'string' && result.error ? messages[result.error] || '기기 등록을 확인하지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.' : '';
      if (!result.error && msg.type === 'push:set') {
        if ('vibrationMode' in msg && pushState.vibrationMode !== msg.vibrationMode) pushMessage = '진동 방식이 적용되지 않았어요. 현재 앱 설정을 확인해 주세요.';
        else if ('vibrationMode' in msg) saved = '‘' + (msg.vibrationMode === 'repeat10' ? '10초 반복 진동' : '확인할 때까지 반복 진동') + '’으로 저장했어요';
        else saved = msg.enabled ? '외부 알림을 켰어요' : '외부 알림을 껐어요';
      }
    } else {
      pushState = null;
      pushMessage = '외부 알림 상태를 확인하지 못했어요. 앱 업데이트 후 다시 시도해 주세요.';
    }
    renderSettings();
    if (saved) toast(saved);
  }

  async function updateBriefing(msg) {
    if (!native || briefingBusy) return;
    briefingBusy = true; renderSettings();
    const result = await nativeRequest(msg);
    if (result.type === 'briefing' && typeof result.enabled === 'boolean' && Number.isInteger(result.intervalHours) &&
        result.intervalHours >= 1 && result.intervalHours <= 24 && Number.isInteger(result.quietStart) && result.quietStart >= 0 &&
        result.quietStart <= 23 && Number.isInteger(result.quietEnd) && result.quietEnd >= 0 && result.quietEnd <= 23) {
      briefing = {
        enabled: result.enabled, intervalHours: result.intervalHours, quietStart: result.quietStart, quietEnd: result.quietEnd,
        last: Number.isFinite(result.last) && result.last > 0 ? result.last : 0,
        notifications: typeof result.notifications === 'boolean' ? result.notifications : null,
        // APK versionCode 5+: schedule mode and the latest posted briefings (older apps omit both)
        mode: result.mode === 'interval' || result.mode === 'morningEvening' ? result.mode : null,
        recent: Array.isArray(result.recent) ? result.recent.filter(r => isObj(r) && Number.isFinite(r.at) && r.at > 0 && typeof r.text === 'string')
          .slice(0, 5).map(r => ({ at: r.at, text: r.text.slice(0, 200) })) : null,
      };
      briefingMessage = msg.type === 'briefing:set' ? '브리핑 설정을 저장했어요.' : '';
    } else if (msg.type === 'briefing:test' && typeof result.ok === 'boolean') {
      briefingMessage = typeof result.message === 'string' ? result.message : '브리핑 테스트를 마쳤어요.';
    } else briefingMessage = result.message || '브리핑 설정을 불러오지 못했어요.';
    briefingBusy = false;
    renderSettings();
    if (msg.type === 'briefing:set' && briefingMessage === '브리핑 설정을 저장했어요.') toast(briefingMessage);
    if (msg.type === 'briefing:test' && result.ok) {
      const message = briefingMessage;
      toast(message);
      await updateBriefing({ type: 'briefing:get' });
      briefingMessage = message;
      renderSettings();
    }
  }

  async function openNotificationSettings() {
    if (!pushState || !pushState.canOpenNotificationSettings) {
      toast('앱을 업데이트하면 여기서 Android 알림 설정을 열 수 있어요.');
      return;
    }
    const result = await nativeRequest({ type: 'notifications:settings' });
    if (result.ok !== true) toast(typeof result.message === 'string' ? result.message : 'Android 설정을 열지 못했어요. 기기의 설정 앱에서 MyPlanner 알림을 켜 주세요.');
  }

  function notifyContent() {
    const b = briefing, p = pushState;
    const out = [stHead('알림', 'Android 앱 전용 · 정기 브리핑과 외부 알림은 따로 움직여요')];
    const perm = b && typeof b.notifications === 'boolean' ? b.notifications : p ? p.canNotify : null;
    let reg;
    if (!p) reg = { dot: 'faint', small: pushBusy ? '앱에서 확인하는 중이에요' : '외부 알림 상태를 확인하지 못했어요', v: '' };
    else if (!p.configured) reg = { dot: 'err', small: '앱의 외부 알림 설정이 필요해요', v: '설정 필요', vCls: 'off' };
    else if (!prefs.connected) reg = { dot: 'warn', small: 'Google 계정을 연결하면 이 기기를 등록할 수 있어요', v: 'Google 계정 연결 필요' };
    else if (p.registered) reg = { dot: 'ok', small: '외부 알림을 받을 수 있어요', v: '등록됨', vCls: 'ok' };
    else reg = { dot: 'warn', small: p.enabled ? '등록을 마치는 중이에요' : '외부 알림을 켜면 이 기기를 등록해요', v: '등록 대기' };
    out.push(h('div', { class: 'st-card', id: 'notify-status' },
      stRow({ id: 'notify-perm', dot: perm === false ? 'err' : perm ? 'ok' : 'faint', k: '알림 권한',
        small: perm === false ? '꺼져 있어요 · Android 설정에서 켜 주세요' : perm ? '브리핑과 외부 알림을 표시할 수 있어요' : '앱에서 확인하는 중이에요',
        v: perm === false && p && p.canOpenNotificationSettings ? null : perm === false ? '꺼짐' : perm ? '허용됨' : '', vCls: perm === false ? 'off' : 'ok', vid: 'notify-permission',
        ctl: perm === false && p && p.canOpenNotificationSettings ? h('button', { type: 'button', class: 'st-perm-open', id: 'notify-open-system', text: '설정 열기', onclick: openNotificationSettings }) : null }),
      stRow({ id: 'notify-reg', dot: reg.dot, k: '기기 등록', small: [p && p.deviceLabel, p && p.versionName ? '앱 ' + p.versionName : '', reg.small].filter(Boolean).join(' · '), v: reg.v, vCls: reg.vCls, vid: 'push-registration' })));
    if (perm === false) out.push(h('div', { class: 'st-alert', id: 'notify-perm-alert', text: '알림 권한이 꺼져 있어서 브리핑과 외부 알림이 모두 표시되지 않아요. 설정은 저장돼 있고, 권한을 켜면 바로 다시 받아요.' }));
    if (perm === false && p && !p.canOpenNotificationSettings) out.push(h('button', { type: 'button', class: 'st-status', id: 'notify-perm-update', text: '앱 업데이트 후 Android 알림 설정 열기', onclick: openNotificationSettings }));

    const bKids = [];
    if (b) {
      bKids.push(stRow({ k: '브리핑 받기', ctl: switchEl('briefing-enabled', b.enabled, '브리핑 받기', on => updateBriefing({ type: 'briefing:set', enabled: on }), briefingBusy) }));
      if (b.enabled) {
        const modeOk = b.mode != null;
        const cur = b.mode === 'morningEvening' ? 'am_pm' : b.intervalHours === 1 ? '1h' : b.intervalHours === 3 ? '3h' : '';
        const seg = segCtl('briefing-interval', [['1h', '1시간마다'], ['3h', '3시간마다'], ['am_pm', '아침·저녁']], cur, v => {
          if (v === 'am_pm' && !modeOk) { renderSettings(); toast('아침·저녁은 앱을 업데이트하면 쓸 수 있어요'); return; }
          if (v === 'am_pm') updateBriefing({ type: 'briefing:set', mode: 'morningEvening' });
          else updateBriefing(Object.assign({ type: 'briefing:set', intervalHours: v === '1h' ? 1 : 3 }, modeOk ? { mode: 'interval' } : {}));
        });
        if (!modeOk) seg.querySelector('[data-v="am_pm"]').setAttribute('aria-disabled', 'true');
        if (briefingBusy) for (const x of seg.children) x.disabled = true;
        const hint = b.mode === 'morningEvening' ? '아침 8시와 저녁 6시쯤 알려요. 조용한 시간에는 보내지 않아요.'
          : !cur ? '현재 ' + b.intervalHours + '시간마다 · 위에서 고르면 바뀌어요'
          : !modeOk ? '아침·저녁은 앱을 업데이트하면 쓸 수 있어요.' : '';
        bKids.push(h('div', { class: 'st-block' }, h('span', { class: 'l', text: '간격' }), seg, hint ? h('span', { class: 'h', id: 'briefing-interval-hint', text: hint }) : null));
        const none = b.quietStart === b.quietEnd;
        bKids.push(stRow({ id: 'briefing-quiet', k: '조용한 시간', small: none ? '조용한 시간 없이 알려요' : '이 시간에는 브리핑을 보내지 않아요',
          v: none ? '없음' : pad(b.quietStart) + ':00 – ' + pad(b.quietEnd) + ':00', vCls: 'numv', onclick: () => { S.quietOpen = !S.quietOpen; renderSettings(); } }));
        if (S.quietOpen) {
          const hours = (id, value, label) => {
            const s = h('select', { id, 'aria-label': label, disabled: briefingBusy ? true : null }, Array.from({ length: 24 }, (_, n) => h('option', { value: String(n), text: pad(n) + ':00' })));
            s.value = String(value);
            return s;
          };
          const start = hours('briefing-start', b.quietStart, '조용한 시간 시작'), end = hours('briefing-end', b.quietEnd, '조용한 시간 끝');
          const save = () => updateBriefing({ type: 'briefing:set', quietStart: +start.value, quietEnd: +end.value });
          start.addEventListener('change', save);
          end.addEventListener('change', save);
          bKids.push(h('div', { class: 'st-block' }, h('div', { class: 'quiet' }, start, h('span', { text: '부터' }), end, h('span', { text: '까지' })),
            h('span', { class: 'h', text: '시작과 끝을 같게 하면 조용한 시간 없이 알려요.' })));
        }
        const lines = b.recent ? b.recent.map((r, i) => stLine(timeText(r.at), r.text, i === 0 ? 'briefing-last' : null))
          : b.last > 0 ? [stLine(timeText(b.last), '브리핑을 보냈어요', 'briefing-last')] : [];
        bKids.push(h('div', { class: 'st-block', id: 'briefing-recent' }, h('span', { class: 'l', text: '최근 알림' }),
          lines.length ? lines : h('span', { class: 'h', id: 'briefing-last', text: '아직 없음' })));
        bKids.push(h('div', { class: 'st-btns' }, h('button', { type: 'button', class: 'btn outline', id: 'briefing-test', disabled: briefingBusy ? true : null, onclick: () => updateBriefing({ type: 'briefing:test' }), text: '테스트 알림 보내기' })));
      }
    } else {
      bKids.push(stRow({ k: '정기 브리핑', small: briefingBusy ? '앱에서 확인하는 중이에요…' : '브리핑 설정을 불러오지 못했어요' }));
    }
    out.push(stSec('정기 브리핑', '남은 일정과 할 일을 정해진 간격으로 요약', h('div', { class: 'st-card', id: 'st-briefing' }, bKids)),
      h('p', { class: 'st-status', id: 'briefing-status', role: 'status', hidden: !(briefingBusy || briefingMessage), text: briefingBusy ? '앱에서 확인하는 중이에요…' : briefingMessage }));

    const pKids = [];
    if (p) {
      pKids.push(stRow({ k: '외부 알림 받기', ctl: switchEl('push-enabled', p.enabled, '외부 알림 받기', on => updatePush({ type: 'push:set', enabled: on }), pushBusy || !prefs.connected || !p.configured) }));
      if (!p.canNotify && perm !== false) pKids.push(stRow({ k: '외부 알림 표시', small: '휴대폰 설정에서 MyPlanner의 외부 알림을 켜 주세요', v: '꺼짐', vCls: 'off', vid: 'push-permission' }));
      if (p.enabled) {
        const supported = p.vibrationMode !== null;
        const modes = [['repeat10', '10초 반복 진동', '약 10초 동안 진동하고 멈춰요.', ''], ['untilAcknowledged', '확인할 때까지 반복 진동', '알림을 확인하거나 진동 중지를 누를 때까지 반복해요.', '실기기 검수 중']];
        pKids.push(h('div', { class: 'st-block', id: 'push-modes', role: 'radiogroup', 'aria-label': '진동 방식' }, h('span', { class: 'l', text: '진동 방식' }),
          modes.map(([k, label, desc, tag]) => h('button', {
            type: 'button', class: 'radio', role: 'radio', id: 'push-mode-' + k, 'aria-checked': String(supported && p.vibrationMode === k),
            disabled: pushBusy || !supported ? true : null,
            onclick: () => { if (p.vibrationMode !== k) updatePush({ type: 'push:set', enabled: p.enabled, vibrationMode: k }); },
          }, h('span', { class: 'rd' }), h('span', { class: 'rt' }, h('b', null, label, tag ? h('span', { class: 'tag', text: tag }) : null), h('span', { text: desc })))),
          h('span', { class: 'h', id: 'push-vibration-help', text: '소리는 기본으로 쓰지 않아요. 알림 창을 열거나 알림의 열기·지우기·진동 중지를 누르면 반복 진동이 멈춰요. 휴대폰 알림 설정을 따라요.' }),
          supported ? null : h('span', { class: 'h', id: 'push-vibration-update', text: '진동 방식을 고르려면 앱을 업데이트해 주세요.' })));
        pKids.push(h('div', { class: 'st-block' }, h('span', { class: 'l', text: '최근 수신' }),
          p.lastReceivedAt > 0 ? stLine(timeText(p.lastReceivedAt), '외부 알림을 받았어요', 'push-last') : h('span', { class: 'h', id: 'push-last', text: '아직 없음' }),
          h('span', { class: 'h', text: '알림을 확인해도 할 일은 완료로 바뀌지 않아요.' })));
      }
    } else {
      pKids.push(stRow({ k: '외부 알림', small: pushBusy ? '앱에서 확인하는 중이에요…' : '상태를 확인하지 못했어요' }));
    }
    out.push(stSec('외부 알림', 'PC나 다른 서비스가 보낸 알림', h('div', { class: 'st-card', id: 'st-push' }, pKids)),
      h('p', { class: 'st-status', id: 'push-status', role: 'status', hidden: !(pushBusy || pushMessage), text: pushBusy ? '앱에서 확인하는 중이에요…' : pushMessage }));
    if (p && p.vibrationMode) out.push(h('div', { class: 'st-saved', id: 'push-saved', text: '저장된 진동 방식 · ' + (p.vibrationMode === 'repeat10' ? '10초 반복 진동' : '확인할 때까지 반복 진동') + ' · 소리 없음' }));
    out.push(h('div', { class: 'st-btns' }, h('button', {
      type: 'button', class: 'btn outline', id: 'notify-refresh', disabled: briefingBusy || pushBusy ? true : null, text: '알림 상태 새로고침',
      onclick: () => { updateBriefing({ type: 'briefing:get' }); updatePush({ type: 'push:get' }); },
    })));
    return out;
  }

  // ------------------------------------------------------------------ export and wipe
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
    Object.assign(look, { design: 'A', theme: 'system' });
    applyLook();
    tokenClient = null;
    setSync('idle');
    for (const l of S.layers) if (l.kind === 'edit') l.orig = JSON.parse(JSON.stringify(l.draft));
    closeLayers(S.layers.length);
    toast('이 기기의 데이터를 지웠어요');
  }

  // ------------------------------------------------------------------ tabs, buttons, clock
  function setTab(tab) {
    S.tab = VIEWS[tab] ? tab : 'cal';
    // tablets: a detail follows the list it came from; drafts and settings stay in the pane
    if (isTablet() && S.layers.length && S.layers.every(l => l.kind === 'detail')) closeLayers(S.layers.length);
    $('#list-scroll').scrollTop = 0;
    renderList();
  }

  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('#fab').addEventListener('click', fabNew);
  $('#open-settings').addEventListener('click', openSettings);
  $('#sync').addEventListener('click', () => {
    if (prefs.connected && !tokenValid()) connect();
    else if (tokenValid()) syncAll();
    else openSettings();
  });
  {
    const wide = window.matchMedia('(min-width: 768px)');
    const onWide = () => render();
    if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
  }

  function tick() {
    const prev = S.now;
    S.now = new Date();
    if (!sameDay(prev, S.now) && sameDay(S.sel, prev)) S.sel = startOfDay(S.now);
    if (S.tab === 'cal' || !sameDay(prev, S.now)) renderList(); // "N분 후" and the 오늘 lists move on
    setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    S.now = new Date();
    render();
    if (native && prefs.connected && !tokenValid()) nativeToken(false).then(ok => { if (ok) syncAll(); });
    else if (tokenValid() && Date.now() - S.lastSync > 60000) syncAll();
    const top = topLayer();
    if (native && top && top.kind === 'notify') { updateBriefing({ type: 'briefing:get' }); updatePush({ type: 'push:get' }); }
  });

  // a reload keeps history.state; without this, closing the next page would go back to the previous site
  if (history.state && (history.state.sheet || Number.isFinite(history.state.mp))) history.replaceState(null, '');
  // deep links: #notes / #tasks / #goals open that tab, #new starts a note for today (home-screen shortcut)
  function followHash() {
    const tab = { '#notes': 'notes', '#tasks': 'tasks', '#goals': 'goals' }[location.hash];
    if (tab) setTab(tab);
    else if (location.hash === '#new') {
      history.replaceState(null, '', location.pathname + location.search);
      const top = topLayer();
      if (!(top && top.kind === 'edit')) startNew('note', { date: ymd(startOfDay(new Date())) });
    }
  }
  window.addEventListener('hashchange', followHash);

  S.authTried = !native;
  render();
  followHash();
  setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  if (native) nativeToken(false).then(ok => { S.authTried = true; if (ok) syncAll(); else render(); });
  else if (clientId()) loadGis();
})();
