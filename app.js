/* 振込予定 & Todo — アプリ本体
   Supabase が設定されていればクラウド保存、未設定なら端末内（localStorage）保存で動きます。 */

const CFG = window.APP_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2));
const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');
const man = (n) => (n % 10000 === 0 ? n / 10000 + '万' : (n / 10000).toFixed(1) + '万');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const todayStr = () => ymd(new Date());
const COL_PALETTE = ['#8FA3A4', '#F26A0A', '#FFC46B', '#3C9A9E', '#FF9A2E', '#2B6F72', '#C9A0DC'];
const DEFAULT_COLS = [['着手前', '#8FA3A4'], ['着手しました', '#F26A0A'], ['先方確認中', '#FFC46B'], ['完了', '#3C9A9E']];

/* ===================== 金額の暗号化（鍵はこの端末の中だけ） ===================== */
const ENC_KEY_NAME = 'furikomi-enc-key';
let _cryptoKey = null;
const b64e = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
async function getKey() {
  if (_cryptoKey) return _cryptoKey;
  let raw = localStorage.getItem(ENC_KEY_NAME);
  if (!raw) { raw = b64e(crypto.getRandomValues(new Uint8Array(32))); localStorage.setItem(ENC_KEY_NAME, raw); }
  _cryptoKey = await crypto.subtle.importKey('raw', b64d(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return _cryptoKey;
}
async function encryptText(text) {
  const key = await getKey(); const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(text)));
  return b64e(iv) + '.' + b64e(ct);
}
async function decryptText(payload) {
  try { const [iv, ct] = payload.split('.'); const key = await getKey();
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(iv) }, key, b64d(ct)); return new TextDecoder().decode(pt);
  } catch (_) { return null; }
}

/* ===================== 保存先 ===================== */
class LocalStore {
  constructor() { this.key = 'furikomi-app-v1'; this.data = JSON.parse(localStorage.getItem(this.key) || 'null') || { jobs: [], boards: [], columns: [], cards: [] }; }
  _save() { localStorage.setItem(this.key, JSON.stringify(this.data)); }
  async loadAll() { return JSON.parse(JSON.stringify(this.data)); }
  async upsert(table, row) { const arr = this.data[table]; const i = arr.findIndex((r) => r.id === row.id); if (i >= 0) arr[i] = { ...arr[i], ...row }; else arr.push(row); this._save(); return row; }
  async remove(table, id) { this.data[table] = this.data[table].filter((r) => r.id !== id); this._save(); }
  async savePush() { /* ローカルモードでは何もしない */ }
  async loadShared() { this.data.shared = this.data.shared || { savings_entries: [], wishes: [], shared_notes: [] }; return JSON.parse(JSON.stringify(this.data.shared)); }
  async upsertShared(table, row) { const arr = this.data.shared[table]; const i = arr.findIndex((r) => r.id === row.id); if (i >= 0) arr[i] = { ...arr[i], ...row }; else arr.push(row); this._save(); return row; }
  async removeShared(table, id) { this.data.shared[table] = this.data.shared[table].filter((r) => r.id !== id); this._save(); }
}

class SupaStore {
  constructor(client, userId) { this.sb = client; this.userId = userId; }
  async loadAll() {
    const [j, b, c, k] = await Promise.all([
      this.sb.from('jobs').select('*').order('pay_date'),
      this.sb.from('boards').select('*').order('position'),
      this.sb.from('columns').select('*').order('position'),
      this.sb.from('cards').select('*').order('position')
    ]);
    for (const r of [j, b, c, k]) if (r.error) throw r.error;
    const jobs = [];
    for (const row of j.data) {
      if (row.amount_enc) { const v = await decryptText(row.amount_enc); row.amount = v === null ? 0 : Number(v); row.locked = v === null; }
      jobs.push(row);
    }
    return { jobs, boards: b.data, columns: c.data, cards: k.data };
  }
  async upsert(table, row) {
    let out = { ...row, user_id: this.userId };
    if (table === 'jobs') { out.amount_enc = await encryptText(row.amount); out.amount = 0; }  // 金額はサーバーに平文を置かない
    const { error } = await this.sb.from(table).upsert(out); if (error) throw error; return row;
  }
  async remove(table, id) { const { error } = await this.sb.from(table).delete().eq('id', id); if (error) throw error; }
  async loadShared() {
    const [e, w, n] = await Promise.all([
      this.sb.from('savings_entries').select('*').order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
      this.sb.from('wishes').select('*').order('position').order('created_at'),
      this.sb.from('shared_notes').select('*').order('created_at', { ascending: false })
    ]);
    for (const r of [e, w, n]) if (r.error) throw r.error;
    return { savings_entries: e.data, wishes: w.data, shared_notes: n.data };
  }
  async upsertShared(table, row) { const { error } = await this.sb.from(table).upsert({ ...row, created_by: this.userId }); if (error) throw error; return row; }
  async removeShared(table, id) { const { error } = await this.sb.from(table).delete().eq('id', id); if (error) throw error; }
  async savePush(sub) {
    const j = sub.toJSON();
    const { error } = await this.sb.from('push_subscriptions').upsert({ user_id: this.userId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
    if (error) throw error;
  }
}

/* ===================== 状態 ===================== */
const S = {
  store: null, sb: null, user: null,
  jobs: [], boards: [], columns: [], cards: [],
  year: new Date().getFullYear(), month: new Date().getMonth() + 1,
  filter: 'all', view: 'list',
  activeBoard: null, overview: false, selectedCard: null, editingCol: null,
  edit: { kind: 'office', status: 'pending' },
  cardEdit: { board: null, col: null, job: null, addingCol: false },
  shared: { savings_entries: [], wishes: [], shared_notes: [] }, sharedLoaded: false
};

/* ===================== 画面切り替え ===================== */
function show(id) {
  $$('.screen').forEach((s) => s.classList.add('hidden'));
  $('#' + id).classList.remove('hidden');
  const tab = $('#tabbar');
  const isMain = id === 'screen-jobs' || id === 'screen-todo' || id === 'screen-savings';
  tab.classList.toggle('hidden', !isMain);
  $$('#tabbar button[data-tab]').forEach((b) => b.classList.toggle('on', (b.dataset.tab === 'jobs' && id === 'screen-jobs') || (b.dataset.tab === 'todo' && id === 'screen-todo') || (b.dataset.tab === 'savings' && id === 'screen-savings')));
  window.scrollTo(0, 0);
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400); }

/* ===================== 振込予定 ===================== */
function monthJobs() { return S.jobs.filter((j) => j.pay_date && j.pay_date.startsWith(S.year + '-' + pad(S.month))); }
function shownJobs() { return monthJobs().filter((j) => S.filter === 'all' || j.kind === S.filter).sort((a, b) => a.pay_date.localeCompare(b.pay_date)); }
function isOverdue(j) { return j.status !== 'paid' && j.pay_date < todayStr(); }

function renderJobs() {
  const all = monthJobs(), shown = shownJobs();
  $('#month-label').textContent = S.year + '年' + S.month + '月';
  $('#month-count').textContent = all.length + '件の振込予定';
  $('#tot-total').textContent = yen(shown.reduce((a, j) => a + Number(j.amount), 0));
  $('#tot-paid').textContent = yen(shown.filter((j) => j.status === 'paid').reduce((a, j) => a + Number(j.amount), 0));
  $$('#filter-seg button').forEach((b) => b.classList.toggle('on', b.dataset.filter === S.filter));
  $$('#view-seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  $('#jobs-list').classList.toggle('hidden', S.view !== 'list');
  $('#jobs-cal').classList.toggle('hidden', S.view !== 'cal');

  const list = $('#jobs-list'); list.innerHTML = '';
  if (!shown.length) { list.innerHTML = '<div class="empty">この月の振込予定はまだありません</div>'; }
  for (const j of shown) {
    const over = isOverdue(j);
    const el = document.createElement('div');
    el.className = 'job' + (j.status === 'paid' ? ' paid' : '') + (over ? ' overdue' : '');
    el.innerHTML = `
      <button class="star" aria-label="振込済みチェック">${j.status === 'paid' ? '★' : '☆'}</button>
      <div class="body">
        <div class="name"></div>
        <div class="meta"><span class="tag ${j.kind}">${j.kind === 'office' ? '事務所' : '個人'}</span><span>${j.pay_date.slice(5).replace('-', '/')} 振込</span>${over ? '<span class="tag over">期限超過</span>' : ''}</div>
      </div>
      <div class="amt">${j.locked ? '🔒' : yen(j.amount)}</div>`;
    $('.name', el).textContent = j.name;
    $('.star', el).addEventListener('click', (e) => { e.stopPropagation(); togglePaid(j); });
    $('.body', el).addEventListener('click', () => openJobEdit(j));
    $('.amt', el).addEventListener('click', () => openJobEdit(j));
    list.appendChild(el);
  }
  renderCalendar(shown);
  renderBanner();
}

function renderCalendar(shown) {
  const grid = $('#cal-grid'); grid.innerHTML = '';
  const first = new Date(S.year, S.month - 1, 1).getDay();
  const days = new Date(S.year, S.month, 0).getDate();
  for (let i = 0; i < first; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'cell' }));
  for (let d = 1; d <= days; d++) {
    const ds = S.year + '-' + pad(S.month) + '-' + pad(d);
    const items = shown.filter((j) => j.pay_date === ds);
    const sum = items.reduce((a, j) => a + Number(j.amount), 0);
    const allPaid = items.length > 0 && items.every((j) => j.status === 'paid');
    const anyOver = items.some(isOverdue);
    const dow = (first + d - 1) % 7;
    const cell = document.createElement('button');
    cell.className = 'cell' + (items.length ? ' has' : '') + (allPaid ? ' paid' : '') + (anyOver && !allPaid ? ' over' : '') + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '') + (ds === todayStr() ? ' today' : '');
    cell.innerHTML = `<div class="d">${d}</div>` + (items.length ? `<div class="a">${man(sum)}</div><div class="dots">${items.map((j) => `<i style="background:${j.kind === 'office' ? '#5C66D6' : '#F283BB'}"></i>`).join('')}</div>` : '');
    cell.addEventListener('click', () => { if (items.length === 1) openJobEdit(items[0]); else if (items.length > 1) { S.view = 'list'; renderJobs(); } else openJobEdit(null, ds); });
    grid.appendChild(cell);
  }
}

function renderBanner() {
  const now = new Date();
  const m = now.getMonth() + 1, y = now.getFullYear();
  const cur = S.jobs.filter((j) => j.pay_date && j.pay_date.startsWith(y + '-' + pad(m)));
  const sum = cur.reduce((a, j) => a + Number(j.amount), 0);
  $('#banner-title').textContent = m + '月の振込予定は' + cur.length + '件・' + yen(sum);
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  $('#banner-sub').textContent = perm === 'granted' ? '毎月1日 9:00と各予定日に通知' : (perm === 'unsupported' ? 'ホーム画面に追加すると通知が使えます' : 'タップして通知をオンにする');
}

async function togglePaid(j) {
  j.status = j.status === 'paid' ? 'pending' : 'paid';
  await S.store.upsert('jobs', j);
  renderJobs();
}

function openJobEdit(j, presetDate) {
  const f = $('#job-form');
  $('#job-edit-title').textContent = j ? '振込予定を編集' : '振込予定を追加';
  $('#job-id').value = j ? j.id : '';
  $('#job-name').value = j ? j.name : '';
  $('#job-date').value = j ? j.pay_date : (presetDate || S.year + '-' + pad(S.month) + '-' + pad(Math.min(new Date().getDate(), 28)));
  $('#job-amount').value = j ? Number(j.amount).toLocaleString('ja-JP') : '';
  $('#job-memo').value = j ? (j.memo || '') : '';
  $('#job-notify-day').checked = j ? !!j.notify_day : true;
  $('#job-notify-before').checked = j ? !!j.notify_before : false;
  $('#job-notify-time').value = j ? (j.notify_time || '09:00').slice(0, 5) : '09:00';
  S.edit.kind = j ? j.kind : 'office';
  S.edit.status = j ? j.status : 'pending';
  $$('#job-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === S.edit.kind));
  $$('#job-status button').forEach((b) => b.classList.toggle('on', b.dataset.status === S.edit.status));
  $('#job-delete').classList.toggle('hidden', !j);
  show('screen-job-edit');
  if (!j) setTimeout(() => $('#job-name').focus(), 50);
}

async function saveJob(e) {
  e && e.preventDefault();
  const amount = Number(String($('#job-amount').value).replace(/[^\d]/g, ''));
  const name = $('#job-name').value.trim();
  const date = $('#job-date').value;
  if (!name || !date || !amount) { toast('案件名・振込予定日・金額を入れてください'); return; }
  const id = $('#job-id').value || uid();
  const existing = S.jobs.find((j) => j.id === id);
  const row = {
    id, name, kind: S.edit.kind, pay_date: date, amount, status: S.edit.status,
    memo: $('#job-memo').value, notify_day: $('#job-notify-day').checked, notify_before: $('#job-notify-before').checked,
    notify_time: $('#job-notify-time').value || '09:00'
  };
  try {
    await S.store.upsert('jobs', row);
    if (existing) Object.assign(existing, row); else S.jobs.push(row);
    const [y, m] = date.split('-').map(Number); S.year = y; S.month = m;
    renderJobs(); show('screen-jobs'); toast(existing ? '更新しました' : '予定を追加しました');
  } catch (err) { console.error(err); toast('保存に失敗しました: ' + (err.message || err)); }
}

/* ===================== Todo ===================== */
function activeBoard() { return S.boards.find((b) => b.id === S.activeBoard) || S.boards[0]; }
function boardCols(bid) { return S.columns.filter((c) => c.board_id === bid).sort((a, b) => a.position - b.position); }
function colCards(cid) { return S.cards.filter((c) => c.column_id === cid).sort((a, b) => a.position - b.position); }

async function ensureDefaultBoard() {
  if (S.boards.length) return;
  const b = { id: uid(), name: 'おしごと', position: 0 };
  await S.store.upsert('boards', b); S.boards.push(b);
  let i = 0;
  for (const [title, color] of DEFAULT_COLS) { const c = { id: uid(), board_id: b.id, title, color, position: i++ }; await S.store.upsert('columns', c); S.columns.push(c); }
}

function renderTodo() {
  const b = activeBoard(); if (!b) return; S.activeBoard = b.id;
  const tabs = $('#board-tabs'); tabs.innerHTML = '';
  for (const bd of S.boards) {
    const t = document.createElement('button'); t.textContent = bd.name; t.classList.toggle('on', bd.id === b.id);
    t.addEventListener('click', () => { S.activeBoard = bd.id; S.selectedCard = null; S.editingCol = null; renderTodo(); });
    let timer; t.addEventListener('pointerdown', () => { timer = setTimeout(() => renameBoard(bd), 600); }); ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => t.addEventListener(ev, () => clearTimeout(timer)));
    tabs.appendChild(t);
  }
  const add = document.createElement('button'); add.className = 'add'; add.textContent = '＋ ボード';
  add.addEventListener('click', addBoard); tabs.appendChild(add);

  $('#todo-zoom').textContent = S.overview ? '拡大' : '全体';
  const board = $('#board'); board.classList.toggle('overview', S.overview); board.innerHTML = '';
  const sel = S.cards.find((c) => c.id === S.selectedCard) || null;
  $('#todo-hint').textContent = sel ? '「' + sel.text.slice(0, 14) + '」を貼り直す枠を選んでください' : (S.overview ? '全体表示：縮小してすべての枠を見渡せます' : 'メモを長押しして別の枠へドラッグ（タップ→枠を選んでもOK）');

  for (const col of boardCols(b.id)) {
    const el = document.createElement('div'); el.className = 'col'; el.dataset.col = col.id;
    const cards = colCards(col.id);
    const head = document.createElement('div'); head.className = 'col-head';
    if (S.editingCol === col.id) {
      head.innerHTML = `<i style="background:${col.color}"></i><input type="text" aria-label="枠の名前"><button class="ok" aria-label="名前を確定">✓</button>`;
      const inp = $('input', head); inp.value = col.title;
      const done = async () => { col.title = inp.value.trim() || col.title; S.editingCol = null; await S.store.upsert('columns', col); renderTodo(); };
      $('.ok', head).addEventListener('click', done); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
      setTimeout(() => inp.focus(), 30);
    } else {
      head.innerHTML = `<i style="background:${col.color}"></i><div class="t"></div><span class="n">${cards.length}</span><button class="ic" aria-label="枠の名前を変更">✎</button><button class="ic del" aria-label="枠を削除">×</button>`;
      $('.t', head).textContent = col.title;
      $('.ic:not(.del)', head).addEventListener('click', () => { S.editingCol = col.id; S.selectedCard = null; renderTodo(); });
      $('.del', head).addEventListener('click', () => deleteColumn(col));
    }
    el.appendChild(head);

    for (const c of cards) {
      const m = document.createElement('div'); m.className = 'memo' + (c.id === S.selectedCard ? ' sel' : ''); m.dataset.card = c.id;
      const job = c.job_id ? S.jobs.find((j) => j.id === c.job_id) : null;
      const late = c.due && c.due < todayStr() && col.position !== boardCols(b.id).length - 1;
      m.innerHTML = `<div class="tx"></div><div class="mt">${job ? `<span class="tag job"></span>` : ''}${c.due ? `<span class="due${late ? ' late' : ''}">⏱ ${c.due.slice(5).replace('-', '/')}</span>` : ''}</div>`;
      $('.tx', m).textContent = c.text; if (job) $('.tag.job', m).textContent = job.name;
      attachMemoEvents(m, c);
      el.appendChild(m);
    }
    if (sel && sel.column_id !== col.id) {
      const d = document.createElement('button'); d.className = 'drop-btn'; d.textContent = '⬇ ここに貼る';
      d.addEventListener('click', () => moveCard(sel, col.id)); el.appendChild(d);
    } else if (!sel) {
      const a = document.createElement('button'); a.className = 'add-memo'; a.textContent = '＋ メモを追加';
      a.addEventListener('click', () => openCardEdit(null, col.id)); el.appendChild(a);
    }
    board.appendChild(el);
  }
  const ac = document.createElement('button'); ac.className = 'add-col'; ac.textContent = '＋ 枠を追加';
  ac.addEventListener('click', () => addColumn(b.id, null, true)); board.appendChild(ac);
}

function attachMemoEvents(m, c) {
  let timer = null, dragging = false, ghost = null, startX = 0, startY = 0, hot = null;
  const cleanup = () => { clearTimeout(timer); if (ghost) ghost.remove(); ghost = null; m.classList.remove('dragging'); $$('.col').forEach((x) => x.classList.remove('drop-ok', 'drop-hot')); if (dragging) document.body.style.overflow = ''; dragging = false; hot = null; };
  m.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    startX = e.clientX; startY = e.clientY;
    timer = setTimeout(() => {
      dragging = true; m.classList.add('dragging'); document.body.style.overflow = 'hidden';
      ghost = m.cloneNode(true); ghost.classList.add('ghost'); ghost.classList.remove('dragging', 'sel');
      ghost.style.width = m.offsetWidth + 'px'; document.body.appendChild(ghost);
      moveGhost(e.clientX, e.clientY);
      $$('.col').forEach((x) => { if (x.dataset.col !== c.column_id) x.classList.add('drop-ok'); });
      if (navigator.vibrate) navigator.vibrate(12);
      try { m.setPointerCapture(e.pointerId); } catch (_) {}
    }, 260);
  });
  const moveGhost = (x, y) => { if (!ghost) return; ghost.style.left = (x - ghost.offsetWidth / 2) + 'px'; ghost.style.top = (y - 30) + 'px'; };
  m.addEventListener('pointermove', (e) => {
    if (!dragging) { if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) clearTimeout(timer); return; }
    e.preventDefault(); moveGhost(e.clientX, e.clientY);
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const col = under && under.closest ? under.closest('.col') : null;
    if (hot && hot !== col) hot.classList.remove('drop-hot');
    hot = col && col.dataset.col !== c.column_id ? col : null; if (hot) hot.classList.add('drop-hot');
    const vh = window.innerHeight; if (e.clientY > vh - 80) window.scrollBy(0, 10); else if (e.clientY < 120) window.scrollBy(0, -10);
  });
  const end = () => {
    if (dragging) { const target = hot ? hot.dataset.col : null; cleanup(); if (target) moveCard(c, target); return; }
    clearTimeout(timer);
  };
  m.addEventListener('pointerup', end); m.addEventListener('pointercancel', cleanup);
  m.addEventListener('click', (e) => { if (dragging) return; S.selectedCard = S.selectedCard === c.id ? null : c.id; renderTodo(); });
  m.addEventListener('dblclick', () => openCardEdit(c));
  m.addEventListener('contextmenu', (e) => e.preventDefault());
}

async function moveCard(c, colId) {
  c.column_id = colId; c.position = colCards(colId).length; S.selectedCard = null;
  await S.store.upsert('cards', c); renderTodo();
}
async function addBoard() {
  const name = prompt('ボードの名前', '新しいボード'); if (name === null) return;
  const b = { id: uid(), name: name.trim() || '新しいボード', position: S.boards.length };
  await S.store.upsert('boards', b); S.boards.push(b);
  let i = 0; for (const [title, color] of DEFAULT_COLS.slice(0, 3).concat([DEFAULT_COLS[3]])) { const col = { id: uid(), board_id: b.id, title, color, position: i++ }; await S.store.upsert('columns', col); S.columns.push(col); }
  S.activeBoard = b.id; renderTodo();
}
async function renameBoard(b) {
  const name = prompt('ボードの名前を変更（空にすると削除）', b.name); if (name === null) return;
  if (!name.trim()) { if (S.boards.length <= 1) { toast('最後のボードは削除できません'); return; } if (!confirm('このボードとメモをすべて削除しますか？')) return; for (const c of boardCols(b.id)) { for (const k of colCards(c.id)) await S.store.remove('cards', k.id); await S.store.remove('columns', c.id); } await S.store.remove('boards', b.id); S.cards = S.cards.filter((k) => !boardCols(b.id).some((c) => c.id === k.column_id)); S.columns = S.columns.filter((c) => c.board_id !== b.id); S.boards = S.boards.filter((x) => x.id !== b.id); S.activeBoard = null; renderTodo(); return; }
  b.name = name.trim(); await S.store.upsert('boards', b); renderTodo();
}
async function addColumn(boardId, title, startEditing) {
  const cols = boardCols(boardId);
  const c = { id: uid(), board_id: boardId, title: title || '新しい枠', color: COL_PALETTE[cols.length % COL_PALETTE.length], position: cols.length };
  await S.store.upsert('columns', c); S.columns.push(c);
  if (startEditing) { S.editingCol = c.id; S.selectedCard = null; renderTodo(); }
  return c;
}
async function deleteColumn(col) {
  const cards = colCards(col.id);
  if (!confirm('枠「' + col.title + '」を削除しますか？' + (cards.length ? '（メモ' + cards.length + '件も消えます）' : ''))) return;
  for (const k of cards) await S.store.remove('cards', k.id);
  await S.store.remove('columns', col.id);
  S.cards = S.cards.filter((k) => k.column_id !== col.id); S.columns = S.columns.filter((c) => c.id !== col.id); renderTodo();
}

/* ---- メモ追加/編集 ---- */
function openCardEdit(c, presetCol) {
  const b = activeBoard();
  S.cardEdit = { id: c ? c.id : null, board: c ? (S.columns.find((x) => x.id === c.column_id) || {}).board_id || b.id : b.id, col: c ? c.column_id : (presetCol || boardCols(b.id)[0].id), job: c ? c.job_id || null : null, addingCol: false };
  $('#card-edit-title').textContent = c ? 'メモを編集' : 'メモを追加';
  $('#card-id').value = c ? c.id : ''; $('#card-text').value = c ? c.text : ''; $('#card-due').value = c ? (c.due || '') : '';
  $('#card-delete').classList.toggle('hidden', !c);
  renderCardEdit(); show('screen-card-edit'); if (!c) setTimeout(() => $('#card-text').focus(), 50);
}
function renderCardEdit() {
  const ce = S.cardEdit;
  const bp = $('#card-board-pick'); bp.innerHTML = '';
  for (const b of S.boards) { const t = document.createElement('button'); t.type = 'button'; t.textContent = b.name; t.classList.toggle('on', b.id === ce.board); t.addEventListener('click', () => { ce.board = b.id; ce.col = boardCols(b.id)[0] ? boardCols(b.id)[0].id : null; ce.addingCol = false; renderCardEdit(); }); bp.appendChild(t); }
  const cp = $('#card-col-pick'); cp.innerHTML = '';
  for (const c of boardCols(ce.board)) { const t = document.createElement('button'); t.type = 'button'; t.innerHTML = `<i style="background:${c.color}"></i><span></span>`; $('span', t).textContent = c.title; t.classList.toggle('on', c.id === ce.col); t.addEventListener('click', () => { ce.col = c.id; renderCardEdit(); }); cp.appendChild(t); }
  if (ce.addingCol) {
    const w = document.createElement('div'); w.className = 'newcol'; w.innerHTML = '<input type="text" placeholder="新しい枠の名前" aria-label="新しい枠の名前"><button type="button">追加</button>';
    const inp = $('input', w); const ok = async () => { const c = await addColumn(ce.board, inp.value.trim() || '新しい枠'); ce.col = c.id; ce.addingCol = false; renderCardEdit(); };
    $('button', w).addEventListener('click', ok); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    cp.appendChild(w); setTimeout(() => inp.focus(), 30);
  } else { const a = document.createElement('button'); a.type = 'button'; a.className = 'add'; a.textContent = '＋ 枠を追加'; a.addEventListener('click', () => { ce.addingCol = true; renderCardEdit(); }); cp.appendChild(a); }
  const jp = $('#card-job-pick'); jp.innerHTML = '';
  const recent = [...S.jobs].sort((a, b) => b.pay_date.localeCompare(a.pay_date)).slice(0, 8);
  if (!recent.length) jp.innerHTML = '<span style="font-size:12px;font-weight:400">（振込予定を登録するとここに出ます）</span>';
  for (const j of recent) { const t = document.createElement('button'); t.type = 'button'; t.className = 'job'; t.textContent = j.name; t.classList.toggle('on', j.id === ce.job); t.addEventListener('click', () => { ce.job = ce.job === j.id ? null : j.id; renderCardEdit(); }); jp.appendChild(t); }
  const col = S.columns.find((c) => c.id === ce.col);
  $('#card-submit').textContent = '「' + (col ? col.title : '') + '」に' + (ce.id ? '保存' : '貼る');
}
async function saveCard(e) {
  e && e.preventDefault();
  const text = $('#card-text').value.trim(); if (!text) { toast('メモを入れてください'); return; }
  const ce = S.cardEdit; if (!ce.col) { toast('貼る枠を選んでください'); return; }
  const id = ce.id || uid(); const existing = S.cards.find((c) => c.id === id);
  const row = { id, column_id: ce.col, board_id: ce.board, text, due: $('#card-due').value || null, job_id: ce.job || null, position: existing && existing.column_id === ce.col ? existing.position : colCards(ce.col).length };
  try { await S.store.upsert('cards', row); if (existing) Object.assign(existing, row); else S.cards.push(row); S.activeBoard = ce.board; S.selectedCard = null; renderTodo(); show('screen-todo'); toast(existing ? '更新しました' : '貼りました'); }
  catch (err) { console.error(err); toast('保存に失敗しました: ' + (err.message || err)); }
}

/* ===================== 二人貯金（全員で共有） ===================== */
async function loadShared() {
  try { S.shared = await S.store.loadShared(); S.sharedLoaded = true; }
  catch (e) { console.error(e); toast('共有データの読み込みに失敗: ' + (e.message || e)); }
}
function savTotal() { return S.shared.savings_entries.reduce((a, r) => a + Number(r.amount), 0); }
function renderSavings() {
  const total = savTotal();
  $('#sav-total').textContent = yen(total);
  const wl = $('#wish-list'); wl.innerHTML = '';
  if (!S.shared.wishes.length) wl.innerHTML = '<div class="empty green">やりたいことを追加してみましょう</div>';
  for (const w of S.shared.wishes) {
    const budget = Number(w.budget || 0);
    const pct = budget > 0 ? Math.min(100, Math.round(total / budget * 100)) : 100;
    const remain = Math.max(0, budget - total);
    const el = document.createElement('button'); el.className = 'wish' + (w.done ? ' done' : '');
    el.innerHTML = `<div class="row1"><span class="wt"></span><span class="wb">${budget ? yen(budget) : '予算なし'}</span></div>
      ${budget ? `<div class="bar${pct >= 100 ? ' full' : ''}"><i style="width:${pct}%"></i></div><div class="wm">${w.done ? '達成しました ✦' : (pct >= 100 ? 'いまの貯金で行ける！' : 'あと ' + yen(remain) + '（' + pct + '%）')}</div>` : ''}
      ${w.memo ? '<div class="wnote"></div>' : ''}`;
    $('.wt', el).textContent = w.title; if (w.memo) $('.wnote', el).textContent = w.memo;
    el.addEventListener('click', () => openSheet('wish', w));
    wl.appendChild(el);
  }
  const nl = $('#note-list'); nl.innerHTML = '';
  if (!S.shared.shared_notes.length) nl.innerHTML = '<div class="empty green">右上の ✎ からメモを貼れます</div>';
  for (const n of S.shared.shared_notes) {
    const el = document.createElement('button'); el.className = 'note'; el.textContent = n.text;
    const sm = document.createElement('small'); sm.textContent = (n.created_at || '').slice(0, 10).replace(/-/g, '/'); el.appendChild(sm);
    el.addEventListener('click', () => openSheet('note', n)); nl.appendChild(el);
  }
  const el2 = $('#entry-list'); el2.innerHTML = '';
  if (!S.shared.savings_entries.length) el2.innerHTML = '<div class="empty green">まだ入出金がありません</div>';
  for (const r of S.shared.savings_entries.slice(0, 50)) {
    const el = document.createElement('button'); el.className = 'entry';
    const a = Number(r.amount);
    el.innerHTML = `<span class="ed">${(r.entry_date || '').slice(5).replace('-', '/')}</span><span class="en"></span><span class="ea ${a >= 0 ? 'in' : 'out'}">${a >= 0 ? '+' : '−'}${yen(Math.abs(a)).slice(1)}</span>`;
    $('.en', el).textContent = r.note || (a >= 0 ? '入金' : '出金');
    el.addEventListener('click', () => openSheet(a >= 0 ? 'in' : 'out', r)); el2.appendChild(el);
  }
}
const SHEET = { mode: null, row: null };
function openSheet(mode, row) {
  SHEET.mode = mode; SHEET.row = row || null;
  const titles = { in: '入金', out: '出金', wish: 'やりたいこと', note: 'メモ' };
  $('#sheet-title').textContent = (row ? '' : '') + titles[mode] + (row ? 'を編集' : 'を追加');
  const f = (id, on) => $('#' + id).classList.toggle('hidden', !on);
  f('sheet-f-amount', mode === 'in' || mode === 'out'); f('sheet-f-date', mode === 'in' || mode === 'out');
  f('sheet-f-title', mode === 'wish'); f('sheet-f-budget', mode === 'wish'); f('sheet-f-note', true);
  $('#sheet-amount').value = row ? Math.abs(Number(row.amount)).toLocaleString('ja-JP') : '';
  $('#sheet-date').value = row ? row.entry_date : todayStr();
  $('#sheet-text').value = row ? (row.title || '') : '';
  $('#sheet-budget').value = row && row.budget ? Number(row.budget).toLocaleString('ja-JP') : '';
  $('#sheet-note').value = row ? (row.memo || row.note || row.text || '') : '';
  $('#sheet-note').placeholder = mode === 'note' ? 'メモの内容' : (mode === 'wish' ? 'メモ（任意）' : '何の入金/出金か（任意）');
  $('#sheet-note').required = mode === 'note';
  $('#sheet-delete').classList.toggle('hidden', !row);
  $('#sheet-ok').textContent = mode === 'wish' && row ? (row.done ? '保存（未達成に戻す）' : '保存') : '保存';
  if (mode === 'wish' && row) { $('#sheet-ok').textContent = '保存'; }
  $('#sheet').classList.remove('hidden');
  setTimeout(() => { const first = mode === 'wish' ? '#sheet-text' : (mode === 'note' ? '#sheet-note' : '#sheet-amount'); $(first).focus(); }, 60);
}
function closeSheet() { $('#sheet').classList.add('hidden'); }
async function saveSheet(e) {
  e && e.preventDefault();
  const m = SHEET.mode, row = SHEET.row; const num = (v) => Number(String(v).replace(/[^\d]/g, ''));
  try {
    if (m === 'in' || m === 'out') {
      const a = num($('#sheet-amount').value); if (!a) { toast('金額を入れてください'); return; }
      const r = { id: row ? row.id : uid(), amount: m === 'in' ? a : -a, note: $('#sheet-note').value.trim(), entry_date: $('#sheet-date').value || todayStr() };
      await S.store.upsertShared('savings_entries', r);
      if (row) Object.assign(row, r); else S.shared.savings_entries.unshift({ ...r, created_at: new Date().toISOString() });
      S.shared.savings_entries.sort((x, y) => (y.entry_date || '').localeCompare(x.entry_date || ''));
    } else if (m === 'wish') {
      const title = $('#sheet-text').value.trim(); if (!title) { toast('やりたいことを入れてください'); return; }
      const r = { id: row ? row.id : uid(), title, budget: num($('#sheet-budget').value) || 0, memo: $('#sheet-note').value.trim(), done: row ? !!row.done : false, position: row ? row.position : S.shared.wishes.length };
      await S.store.upsertShared('wishes', r);
      if (row) Object.assign(row, r); else S.shared.wishes.push(r);
    } else if (m === 'note') {
      const text = $('#sheet-note').value.trim(); if (!text) { toast('メモを入れてください'); return; }
      const r = { id: row ? row.id : uid(), text };
      await S.store.upsertShared('shared_notes', r);
      if (row) Object.assign(row, r); else S.shared.shared_notes.unshift({ ...r, created_at: new Date().toISOString() });
    }
    closeSheet(); renderSavings(); toast('保存しました');
  } catch (err) { console.error(err); toast('保存に失敗: ' + (err.message || err)); }
}
async function deleteSheet() {
  const m = SHEET.mode, row = SHEET.row; if (!row) return;
  if (m === 'wish' && !row.done && confirm('「' + row.title + '」を達成済みにしますか？\n（キャンセル → 削除の確認へ）')) {
    row.done = true; await S.store.upsertShared('wishes', row); closeSheet(); renderSavings(); toast('達成おめでとう ✦'); return;
  }
  if (!confirm('削除しますか？')) return;
  const table = m === 'wish' ? 'wishes' : (m === 'note' ? 'shared_notes' : 'savings_entries');
  await S.store.removeShared(table, row.id);
  S.shared[table] = S.shared[table].filter((r) => r.id !== row.id);
  closeSheet(); renderSavings(); toast('削除しました');
}

/* ===================== 通知 ===================== */
async function registerSW() { if (!('serviceWorker' in navigator)) return null; try { return await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW登録失敗', e); return null; } }
function b64ToU8(b64) { const p = '='.repeat((4 - (b64.length % 4)) % 4); const s = (b64 + p).replace(/-/g, '+').replace(/_/g, '/'); const r = atob(s); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); }
async function enableNotifications() {
  if (!('Notification' in window) || !('PushManager' in window)) { toast('この表示では通知が使えません。Safariの共有メニューから「ホーム画面に追加」して、そのアイコンから開いてください'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('通知が許可されませんでした'); renderBanner(); return; }
  const reg = await navigator.serviceWorker.ready;
  if (!CFG.VAPID_PUBLIC_KEY || !S.sb) { toast('通知を許可しました（サーバー未設定のため予定日の通知は届きません）'); renderBanner(); return; }
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(CFG.VAPID_PUBLIC_KEY) });
    await S.store.savePush(sub);
    toast('通知をオンにしました');
  } catch (e) { console.error(e); toast('通知の登録に失敗: ' + (e.message || e)); }
  renderBanner();
}

/* ===================== 認証 ===================== */
async function initSupabase() {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return null;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  return createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'furikomi-auth', storage: window.localStorage,
      // iOS の Web Locks の不具合で待ち続けないよう、ロックは使わない
      lock: async (_name, _timeout, fn) => fn() }
  });
}
async function sendOtp(e) {
  e.preventDefault(); const email = $('#login-email').value.trim(); const msg = $('#login-msg');
  msg.textContent = '送信中…';
  const { error } = await S.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) { msg.textContent = '送れませんでした: ' + error.message; return; }
  msg.textContent = email + ' に6桁のコードを送りました（届かない時は迷惑メールも確認）';
  $('#login-form').classList.add('hidden'); $('#otp-form').classList.remove('hidden'); $('#login-otp').focus();
}
async function verifyOtp(e) {
  e.preventDefault(); const email = $('#login-email').value.trim(); const token = $('#login-otp').value.trim(); const msg = $('#login-msg');
  msg.textContent = '確認中…';
  const { data, error } = await S.sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) { msg.textContent = 'コードが違うか期限切れです: ' + error.message; return; }
  msg.textContent = ''; await onLoggedIn(data.user);
}
async function onLoggedIn(user) {
  S.user = user; S.store = new SupaStore(S.sb, user.id);
  if (user.is_anonymous) $('#tab-logout').classList.add('hidden');
  await loadAndStart();
}
async function logout() {
  if (!confirm('ログアウトしますか？')) return;
  if (S.sb) await S.sb.auth.signOut();
  location.reload();
}

/* ===================== 起動 ===================== */
async function loadAndStart() {
  try {
    const d = await S.store.loadAll();
    S.jobs = d.jobs || []; S.boards = d.boards || []; S.columns = d.columns || []; S.cards = d.cards || [];
    await ensureDefaultBoard();
    renderJobs(); renderTodo(); show('screen-todo');
  } catch (e) { console.error(e); toast('読み込みに失敗: ' + (e.message || e)); }
}

function bind() {
  $('#login-form').addEventListener('submit', sendOtp);
  $('#otp-form').addEventListener('submit', verifyOtp);
  $('#otp-back').addEventListener('click', () => { $('#otp-form').classList.add('hidden'); $('#login-form').classList.remove('hidden'); });
  $('#month-prev').addEventListener('click', () => { if (--S.month < 1) { S.month = 12; S.year--; } renderJobs(); });
  $('#month-next').addEventListener('click', () => { if (++S.month > 12) { S.month = 1; S.year++; } renderJobs(); });
  $$('#view-seg button').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.view; renderJobs(); }));
  $$('#filter-seg button').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.filter; renderJobs(); }));
  $('#jobs-add').addEventListener('click', () => openJobEdit(null));
  $('#notify-banner').addEventListener('click', enableNotifications);
  $('#job-back').addEventListener('click', () => show('screen-jobs'));
  $('#job-save').addEventListener('click', saveJob);
  $('#job-form').addEventListener('submit', saveJob);
  $$('#job-kind button').forEach((b) => b.addEventListener('click', () => { S.edit.kind = b.dataset.kind; $$('#job-kind button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $$('#job-status button').forEach((b) => b.addEventListener('click', () => { S.edit.status = b.dataset.status; $$('#job-status button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $$('.presets button').forEach((b) => b.addEventListener('click', () => { $('#job-amount').value = Number(b.dataset.amt).toLocaleString('ja-JP'); }));
  $('#job-amount').addEventListener('blur', () => { const n = Number(String($('#job-amount').value).replace(/[^\d]/g, '')); $('#job-amount').value = n ? n.toLocaleString('ja-JP') : ''; });
  $('#job-delete').addEventListener('click', async () => { const id = $('#job-id').value; if (!id || !confirm('この振込予定を削除しますか？')) return; await S.store.remove('jobs', id); S.jobs = S.jobs.filter((j) => j.id !== id); renderJobs(); show('screen-jobs'); toast('削除しました'); });
  $('#todo-add').addEventListener('click', () => openCardEdit(null));
  $('#todo-zoom').addEventListener('click', () => { S.overview = !S.overview; S.selectedCard = null; S.editingCol = null; renderTodo(); });
  $('#card-back').addEventListener('click', () => show('screen-todo'));
  $('#card-save').addEventListener('click', saveCard);
  $('#card-form').addEventListener('submit', saveCard);
  $('#card-delete').addEventListener('click', async () => { const id = $('#card-id').value; if (!id || !confirm('このメモを削除しますか？')) return; await S.store.remove('cards', id); S.cards = S.cards.filter((c) => c.id !== id); renderTodo(); show('screen-todo'); toast('削除しました'); });
  $$('#tabbar button[data-tab]').forEach((b) => b.addEventListener('click', async () => {
    const t = b.dataset.tab;
    if (t === 'jobs') { show('screen-jobs'); renderJobs(); }
    else if (t === 'todo') { show('screen-todo'); renderTodo(); }
    else { show('screen-savings'); await loadShared(); renderSavings(); }
  }));
  $('#tab-logout').addEventListener('click', logout);
  $('#sav-in').addEventListener('click', () => openSheet('in'));
  $('#sav-out').addEventListener('click', () => openSheet('out'));
  $('#sav-add-wish').addEventListener('click', () => openSheet('wish'));
  $('#sav-add-note').addEventListener('click', () => openSheet('note'));
  $('#sheet-form').addEventListener('submit', saveSheet);
  $('#sheet-cancel').addEventListener('click', closeSheet);
  $('.sheet-bg').addEventListener('click', closeSheet);
  $('#sheet-delete').addEventListener('click', deleteSheet);
  $$('#sheet-amount, #sheet-budget').forEach((i) => i.addEventListener('blur', () => { const n = Number(String(i.value).replace(/[^\d]/g, '')); i.value = n ? n.toLocaleString('ja-JP') : ''; }));
  window.addEventListener('orientationchange', () => setTimeout(renderTodo, 150));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderBanner(); });
}

(async function main() {
  bind(); registerSW();
  S.sb = await initSupabase();
  if (!S.sb) {
    S.store = new LocalStore(); $('#tab-logout').classList.add('hidden');
    await loadAndStart();
    if (!localStorage.getItem('furikomi-local-notice')) { toast('サーバー未設定のため、この端末の中だけに保存します'); localStorage.setItem('furikomi-local-notice', '1'); }
    return;
  }
  // ログイン画面なし：初回は裏で匿名アカウントを自動作成し、以後はこの端末に紐づく
  // 保持の仕組みを二重にする：supabase-js の保存に加えて、自前でもトークンを控えておく
  const SAVE_KEY = 'furikomi-session-backup';
  const backup = (sess) => { try { if (sess) localStorage.setItem(SAVE_KEY, JSON.stringify({ access_token: sess.access_token, refresh_token: sess.refresh_token })); } catch (_) {} };
  S.sb.auth.onAuthStateChange((ev, sess) => { if (sess) backup(sess); });
  let { data } = await S.sb.auth.getSession();
  if (!data.session) {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (saved && saved.refresh_token) { const r = await S.sb.auth.setSession(saved); if (r.data && r.data.session) data = r.data; }
    } catch (e) { console.warn('セッション復元に失敗', e); }
  }
  if (data.session) { backup(data.session); await onLoggedIn(data.session.user); return; }
  const { data: anon, error } = await S.sb.auth.signInAnonymously();
  if (anon && anon.session) backup(anon.session);
  if (error || !anon.user) {
    console.error(error);
    toast('サーバーに接続できないため、この端末の中だけに保存します');
    S.store = new LocalStore(); $('#tab-logout').classList.add('hidden'); await loadAndStart(); return;
  }
  await onLoggedIn(anon.user);
})();
