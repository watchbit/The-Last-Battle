const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fa = n => Number(n || 0).toLocaleString('fa-IR');
let api, me = null, authMode = 'login', rankBy = 'xp', poll = null;

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200); }
function show(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  ({ multi: loadLobbies, friends: loadFriends, ranks: loadRanks, profile: loadProfile, settings: loadSettings })[page]?.();
}
function needLogin() { if (me) return false; toast('برای این بخش ابتدا وارد شوید'); $('auth').hidden = false; return true; }

function setAuthMode(m) {
  authMode = m;
  document.querySelectorAll('[data-auth]').forEach(b => b.classList.toggle('active', b.dataset.auth === m));
  $('aDispRow').hidden = m !== 'register'; $('aSubmit').textContent = m === 'login' ? 'ورود' : 'ساخت حساب'; $('aErr').textContent = '';
}
async function submitAuth(e) {
  e.preventDefault();
  const u = $('aUser').value.trim(), p = $('aPass').value;
  const r = authMode === 'login' ? await api.login(u, p) : await api.register(u, p, $('aDisp').value.trim());
  if (!r.ok) { $('aErr').textContent = r.error || 'خطا'; return; }
  setMe(r.profile); $('auth').hidden = true; $('aPass').value = '';
}
function setMe(p) { me = p; $('whoName').textContent = p ? p.display : 'مهمان'; }

async function refreshHome() {
  const s = await api.settings();
  const u = await api.updates();
  $('btnInstall').hidden = s.installed; $('btnUpdate').hidden = true;
  if (!u.ok) { $('updState').textContent = u.error; return; }
  $('news').textContent = u.news || 'خبری نیست.';
  if (!s.installed) $('updState').textContent = s.game_dir ? 'بازی در پوشه انتخاب‌شده پیدا نشد.' : 'پوشه بازی انتخاب نشده؛ از تنظیمات انتخاب کنید یا بازی را دانلود کنید.';
  else if (u.pending.length) { $('updState').textContent = `${fa(u.pending.length)} آپدیت جدید آماده نصب است.`; $('btnUpdate').hidden = false; }
  else $('updState').textContent = `بازی به‌روز است (${fa(u.applied.length)} پچ نصب‌شده).`;
}
async function startJob(fn) {
  const r = await fn(); if (!r.ok) { toast(r.error); return; }
  $('prog').hidden = false; clearInterval(poll);
  poll = setInterval(async () => {
    const j = await api.progress();
    $('progBar').style.width = (j.total ? Math.min(100, 100 * j.done / j.total) : 0) + '%';
    $('progMsg').textContent = j.error || j.message;
    if (!j.running) { clearInterval(poll); if (!j.error) $('prog').hidden = true; toast(j.error || j.message); refreshHome(); }
  }, 500);
}
async function play(mode) {
  if (mode === 'multiplayer' && needLogin()) return;
  const r = await api.play(mode);
  toast(r.ok ? 'بازی در حال اجراست...' : r.error);
}

async function loadLobbies() {
  const r = await api.lobbies();
  if (!r.ok) { $('lobbies').innerHTML = `<tr><td colspan="4">${esc(r.error)}</td></tr>`; return; }
  const p = await api.server_ping(); $('mpStats').textContent = p.ok ? `${fa(p.players || 0)} بازیکن آنلاین، ${fa(p.accounts || 0)} حساب` : '';
  $('lobbies').innerHTML = r.lobbies.length ? r.lobbies.map(l => `<tr><td>${esc(l.name || '-')}</td><td>${esc(l.map)}</td><td>${esc(l.host)}</td><td>${fa(l.players)}/${fa(l.max)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">لابی بازی وجود ندارد.</td></tr>';
}

function userItem(u, actions, state) {
  return `<div class="item"><span class="name">${esc(u.display)} <span class="muted ltr">@${esc(u.username)}</span></span>${state || ''}<span class="muted">سطح ${fa(u.stats.level)}</span>${actions}</div>`;
}
async function loadFriends() {
  if (!me) { $('fList').innerHTML = '<p class="muted">برای دیدن دوستان وارد شوید.</p>'; return; }
  const r = await api.friends(); if (!r.ok) return toast(r.error);
  $('reqBadge').hidden = !r.requests.length; $('reqBadge').textContent = fa(r.requests.length);
  $('fRequests').innerHTML = r.requests.length ? r.requests.map(u => userItem(u, `<button class="primary" data-acc="${esc(u.username)}">پذیرش</button><button data-dec="${esc(u.username)}">رد</button>`)).join('') : '<p class="muted">درخواستی ندارید.</p>';
  $('fList').innerHTML = r.friends.length ? r.friends.map(u => userItem(u, `<button class="danger" data-rem="${esc(u.username)}">حذف</button>`, `<span class="state ${u.online ? 'on' : ''}">${u.inGame ? 'در لابی' : u.online ? 'آنلاین' : 'آفلاین'}</span>`)).join('') : '<p class="muted">هنوز دوستی ندارید؛ از جستجو یا رتبه‌بندی دوست اضافه کنید.</p>';
}
async function searchUsers() {
  if (needLogin()) return;
  const r = await api.search_users($('fSearch').value.trim()); if (!r.ok) return toast(r.error);
  $('fResults').innerHTML = r.users.length ? r.users.map(u => userItem(u, u.username === me.username ? '' : `<button data-add="${esc(u.username)}">درخواست دوستی</button>`)).join('') : '<p class="muted">کسی پیدا نشد.</p>';
}
async function friendAction(fn, name, ok) { const r = await fn(name); toast(r.ok ? (r.pending ? 'درخواست دوستی فرستاده شد' : ok) : r.error); loadFriends(); }

async function loadRanks() {
  const r = await api.leaderboard(rankBy);
  if (!r.ok) { $('ranks').innerHTML = `<tr><td colspan="6">${esc(r.error)}</td></tr>`; return; }
  $('ranks').innerHTML = r.rows.map(u => `<tr class="click" data-prof="${esc(u.username)}"><td>${fa(u.rank)}</td><td>${esc(u.display)}</td><td>${fa(u.stats.level)}</td><td>${fa(u.stats.xp)}</td><td>${fa(u.stats.wins)}</td><td>${fa(u.stats.losses)}</td></tr>`).join('');
}
async function openProfile(name) {
  const r = await api.user_profile(name); if (!r.ok) return toast(r.error);
  const u = r.user, mine = me && me.username === u.username;
  $('modalBody').innerHTML = `<h3>${esc(u.display)} <span class="muted ltr">@${esc(u.username)}</span></h3>
    <div class="stats"><div><b>${fa(u.stats.level)}</b>سطح</div><div><b>${fa(u.stats.xp)}</b>تجربه</div><div><b>${fa(u.stats.wins)}</b>برد</div><div><b>${fa(u.stats.losses)}</b>باخت</div></div>
    <div class="row">${mine ? '' : `<button class="primary" data-add="${esc(u.username)}">افزودن به دوستان</button>`}<button id="mClose">بستن</button></div>`;
  $('modal').hidden = false;
}

async function loadProfile() {
  if (!me) { $('pStats').innerHTML = '<p class="muted">وارد نشده‌اید.</p>'; return; }
  const r = await api.me(); if (r.ok) setMe(r.profile);
  const s = me.stats;
  $('pStats').innerHTML = `<div><b>${fa(s.level)}</b>سطح</div><div><b>${fa(s.xp)}</b>تجربه</div><div><b>${fa(s.wins)}</b>برد</div><div><b>${fa(s.losses)}</b>باخت</div>`;
  $('pDisp').value = me.display;
}
async function loadSettings() {
  const s = await api.settings();
  $('sGame').textContent = s.game_dir || 'انتخاب نشده'; $('sServer').value = s.server;
  document.querySelectorAll('input[name=lang]').forEach(r => r.checked = r.value === s.language);
}

function wire() {
  document.querySelectorAll('[data-auth]').forEach(b => b.onclick = () => setAuthMode(b.dataset.auth));
  $('authForm').onsubmit = submitAuth;
  $('offline').onclick = () => { $('auth').hidden = true; };
  document.querySelectorAll('.nav').forEach(b => b.onclick = () => show(b.dataset.page));
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => play(b.dataset.mode));
  $('btnUpdate').onclick = () => startJob(api.apply_updates);
  $('btnInstall').onclick = async () => { const s = await api.settings(); if (!s.game_dir) { await api.pick_game_folder(); } startJob(api.install_game); };
  $('mpRefresh').onclick = loadLobbies;
  $('fSearchBtn').onclick = searchUsers;
  $('fSearch').onkeydown = e => { if (e.key === 'Enter') searchUsers(); };
  document.querySelectorAll('[data-rank]').forEach(b => b.onclick = () => { rankBy = b.dataset.rank; document.querySelectorAll('[data-rank]').forEach(x => x.classList.toggle('active', x === b)); loadRanks(); });
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-add],[data-acc],[data-dec],[data-rem],[data-prof],#mClose'); if (!t) return;
    if (t.id === 'mClose') $('modal').hidden = true;
    else if (t.dataset.add) { if (!needLogin()) friendAction(api.friend_request, t.dataset.add, 'دوست شدید'); $('modal').hidden = true; }
    else if (t.dataset.acc) friendAction(api.friend_accept, t.dataset.acc, 'درخواست پذیرفته شد');
    else if (t.dataset.dec) friendAction(api.friend_decline, t.dataset.dec, 'درخواست رد شد');
    else if (t.dataset.rem) { if (confirm('از فهرست دوستان حذف شود؟')) friendAction(api.friend_remove, t.dataset.rem, 'حذف شد'); }
    else if (t.dataset.prof) openProfile(t.dataset.prof);
  });
  $('pDispSave').onclick = async () => { const r = await api.set_display($('pDisp').value.trim()); toast(r.ok ? 'نام ذخیره شد' : r.error); if (r.ok) setMe(r.profile); };
  $('pPassSave').onclick = async () => { const r = await api.change_password($('pOld').value, $('pNew').value); toast(r.ok ? 'رمز تغییر کرد؛ دوباره وارد شوید' : r.error); if (r.ok) { setMe(null); $('auth').hidden = false; } };
  $('logout').onclick = async () => { await api.logout(); setMe(null); $('auth').hidden = false; show('home'); };
  $('sPick').onclick = async () => { await api.pick_game_folder(); loadSettings(); refreshHome(); };
  $('sVerify').onclick = () => { show('home'); startJob(api.verify_game); };
  document.querySelectorAll('input[name=lang]').forEach(r => r.onchange = async () => { await api.set_language(r.value); toast('زبان بازی ذخیره شد'); });
  $('sServerSave').onclick = async () => { await api.set_server($('sServer').value); toast('سرور ذخیره شد'); refreshHome(); };
}

async function heartbeat() {
  const p = await api.server_ping(); $('srv').classList.toggle('on', !!p.ok);
  if (me) { const r = await api.friends(); if (r.ok) { $('reqBadge').hidden = !r.requests.length; $('reqBadge').textContent = fa(r.requests.length); } }
}

window.addEventListener('pywebviewready', async () => {
  api = window.pywebview.api; wire();
  const r = await api.me();
  if (r.ok) { setMe(r.profile); $('auth').hidden = true; }
  refreshHome(); heartbeat(); setInterval(heartbeat, 20000);
});
