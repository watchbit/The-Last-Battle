// The Last War - accounts: registration, login sessions, game tokens, persisted in JSON.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function Accounts(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'accounts.json');
  let db = { nextId: 1, users: {}, boards: {}, ustats: {}, friends: {}, requests: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  db.boards = db.boards || {}; db.ustats = db.ustats || {}; db.friends = db.friends || {}; db.requests = db.requests || {};
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  let dirty = false;
  function save() { dirty = true; }
  setInterval(() => { if (!dirty) return; dirty = false; const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, file); }, 1500).unref();
  process.on('exit', () => { if (dirty) try { fs.writeFileSync(file, JSON.stringify(db)); } catch {} });

  const STEAM_BASE = 76561198000000000n;   // generated ids live in a private range so they never collide with real accounts
  const norm = u => String(u || '').trim().toLowerCase();
  const failures = new Map();              // ip -> [timestamps]
  const throttled = ip => { const a = (failures.get(ip) || []).filter(t => Date.now() - t < 600000); failures.set(ip, a); return a.length >= 10; };
  const fail = ip => { const a = failures.get(ip) || []; a.push(Date.now()); failures.set(ip, a); };

  function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }
  function publicProfile(u) {
    return { username: u.username, display: u.display, steamId: String(u.steamId), created: u.created, stats: u.stats, admin: !!u.admin };
  }
  const card = u => ({ username: u.username, display: u.display, steamId: String(u.steamId), stats: u.stats });
  const fset = name => (db.friends[name] = db.friends[name] || []);
  const rset = name => (db.requests[name] = db.requests[name] || []);
  function friendRequest(u, target) {
    const t = db.users[norm(target)]; if (!t) return { ok: false, error: 'کاربر پیدا نشد' };
    if (t.username === u.username) return { ok: false, error: 'نمی‌توانید به خودتان درخواست بدهید' };
    if (fset(u.username).includes(t.username)) return { ok: false, error: 'از قبل دوست هستید' };
    if (rset(u.username).includes(t.username)) return friendAccept(u, t.username);
    if (!rset(t.username).includes(u.username)) { rset(t.username).push(u.username); save(); }
    return { ok: true, pending: true };
  }
  function friendAccept(u, from) {
    const f = norm(from); const r = rset(u.username); const i = r.indexOf(f); if (i < 0 || !db.users[f]) return { ok: false, error: 'درخواستی پیدا نشد' };
    r.splice(i, 1); if (!fset(u.username).includes(f)) fset(u.username).push(f); if (!fset(f).includes(u.username)) fset(f).push(u.username); save();
    return { ok: true };
  }
  function friendDecline(u, from) { const r = rset(u.username); const i = r.indexOf(norm(from)); if (i >= 0) { r.splice(i, 1); save(); } return { ok: true }; }
  function friendRemove(u, name) { const f = norm(name); db.friends[u.username] = fset(u.username).filter(x => x !== f); db.friends[f] = fset(f).filter(x => x !== u.username); save(); return { ok: true }; }
  function friendsOf(u) { return { friends: fset(u.username).filter(n => db.users[n]).map(n => card(db.users[n])), requests: rset(u.username).filter(n => db.users[n]).map(n => card(db.users[n])) }; }
  function search(q) { const s = norm(q); if (s.length < 2) return []; return Object.values(db.users).filter(u => u.username.includes(s) || u.display.toLowerCase().includes(s)).slice(0, 20).map(card); }
  function leaderboard(by, limit) { const k = ['xp', 'wins', 'level'].includes(by) ? by : 'xp'; return Object.values(db.users).filter(u => !u.banned).sort((a, b) => (b.stats[k] || 0) - (a.stats[k] || 0)).slice(0, Math.min(+limit || 100, 500)).map((u, i) => ({ rank: i + 1, ...card(u) })); }
  function userCard(name) { const u = db.users[norm(name)]; return u ? card(u) : null; }
  function adminList() { return Object.values(db.users).map(u => ({ ...card(u), created: u.created, banned: !!u.banned, admin: !!u.admin })); }
  function adminSet(name, field, value) { const u = db.users[norm(name)]; if (!u || !['banned', 'admin'].includes(field)) return { ok: false }; u[field] = !!value; if (field === 'banned' && value) { u.sessions = []; u.gameToken = ''; } save(); return { ok: true }; }
  function newSession(u) {
    const token = crypto.randomBytes(24).toString('hex');
    u.sessions = (u.sessions || []).filter(s => s.exp > Date.now()).slice(-4);
    u.sessions.push({ h: sha(token), exp: Date.now() + 30 * 86400000 }); save(); return token;
  }


  // ---- Steam-style leaderboards + per-account stat store (served to the game through the gateway)
  const bySid = sid => Object.values(db.users).find(x => x.steamId === String(sid));
  const nameOf = sid => { const u = bySid(sid); return u ? u.display : ''; };
  function board(name, create) { let b = db.boards[name]; if (!b && create) b = db.boards[name] = { sort: 2, display: 0, e: {} }; return b; }
  function ranked(b) {   // sort 1 = ascending (lower is better), otherwise descending
    const a = Object.entries(b.e).map(([sid, e]) => ({ sid, ...e }));
    a.sort((x, y) => (b.sort === 1 ? x.score - y.score : y.score - x.score) || x.t - y.t);
    a.forEach((e, i) => { e.rank = i + 1; }); return a;
  }
  function boardInfo(name, sort, display) { const b = board(name, true); if (sort) b.sort = sort; if (display != null) b.display = display; save(); return b; }
  function boardGet(name, req, r0, r1, sid, users) {
    const b = board(name, false); if (!b) return { total: 0, list: [] };
    const all = ranked(b); let list;
    if (req === 1) { const me = all.find(e => e.sid === String(sid)); const c = me ? me.rank : 1; list = all.filter(e => e.rank >= c + r0 && e.rank <= c + r1); }
    else if (req === 3) { const set = new Set(users); list = all.filter(e => set.has(e.sid)); }
    else if (req === 2) { list = all.filter(e => e.sid === String(sid)); }
    else list = all.filter(e => e.rank >= r0 && e.rank <= r1);
    return { total: all.length, list: list.slice(0, 500).map(e => ({ ...e, name: nameOf(e.sid) })) };
  }
  function boardSet(name, sid, method, score, details) {
    const b = board(name, true); const old = b.e[String(sid)]; const prev = old ? ranked(b).find(e => e.sid === String(sid)).rank : 0;
    const better = !old || (b.sort === 1 ? score < old.score : score > old.score);
    let changed = false;
    if (method === 2 || better) { changed = !old || old.score !== score; b.e[String(sid)] = { score, details: details || [], t: Date.now() }; save(); }
    const e = b.e[String(sid)]; const rank = ranked(b).find(x => x.sid === String(sid)).rank;
    return { score: e.score, changed, rank, prev };
  }
  function statsGet(sid) { return db.ustats[String(sid)] || {}; }
  function statsSet(sid, name, val) { const m = db.ustats[String(sid)] = db.ustats[String(sid)] || {}; m[String(name).slice(0, 80)] = val; save(); }
  return {
    boardInfo, boardGet, boardSet, statsGet, statsSet, nameOf, boardNames: () => Object.keys(db.boards),
    friendRequest, friendAccept, friendDecline, friendRemove, friendsOf, search, leaderboard, userCard, adminList, adminSet,
    friendSids(sid) { const u = bySid(sid); return u ? fset(u.username).filter(n => db.users[n]).map(n => ({ sid: String(db.users[n].steamId), name: db.users[n].display })) : []; },
    register({ username, password, display }, ip) {
      const name = norm(username);
      if (!/^[a-z0-9_]{3,20}$/.test(name)) return { ok: false, error: 'نام کاربری باید ۳ تا ۲۰ حرف انگلیسی/عدد/زیرخط باشد' };
      if (String(password || '').length < 6 || String(password).length > 100) return { ok: false, error: 'رمز عبور باید حداقل ۶ نویسه باشد' };
      const disp = String(display || username).trim().slice(0, 24) || name;
      if (db.users[name]) return { ok: false, error: 'این نام کاربری قبلاً گرفته شده' };
      if (Object.keys(db.users).length >= 100000) return { ok: false, error: 'ظرفیت ثبت‌نام پر است' };
      const salt = crypto.randomBytes(16).toString('hex');
      const u = { username: name, display: disp, salt, hash: hashPassword(String(password), salt), steamId: STEAM_BASE + BigInt(db.nextId++), created: Date.now(),
        stats: { wins: 0, losses: 0, xp: 0, level: 1 }, sessions: [], gameToken: '' };
      u.steamId = String(u.steamId); db.users[name] = u; save();
      return { ok: true, token: newSession(u), profile: publicProfile(u) };
    },
    login({ username, password }, ip) {
      if (throttled(ip)) return { ok: false, error: 'تلاش‌های ناموفق زیاد؛ چند دقیقه بعد دوباره امتحان کنید' };
      const u = db.users[norm(username)];
      if (!u || hashPassword(String(password || ''), u.salt) !== u.hash) { fail(ip); return { ok: false, error: 'نام کاربری یا رمز عبور اشتباه است' }; }
      if (u.banned) return { ok: false, error: 'این حساب مسدود شده است' };
      return { ok: true, token: newSession(u), profile: publicProfile(u) };
    },
    bySession(token) {
      const h = sha(String(token || '')); for (const u of Object.values(db.users)) if (!u.banned && (u.sessions || []).some(s => s.h === h && s.exp > Date.now())) return u; return null;
    },
    logout(token) { const h = sha(String(token || '')); for (const u of Object.values(db.users)) { const n = (u.sessions || []).length; u.sessions = (u.sessions || []).filter(s => s.h !== h); if (u.sessions.length !== n) save(); } },
    setDisplay(u, display) { const d = String(display || '').trim().slice(0, 24); if (!d) return { ok: false, error: 'نام نمایشی خالی است' }; u.display = d; save(); return { ok: true, profile: publicProfile(u) }; },
    changePassword(u, oldPw, newPw) { if (hashPassword(String(oldPw || ''), u.salt) !== u.hash) return { ok: false, error: 'رمز فعلی اشتباه است' }; if (String(newPw || '').length < 6) return { ok: false, error: 'رمز جدید کوتاه است' }; u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPassword(String(newPw), u.salt); u.sessions = []; save(); return { ok: true }; },
    issueGameToken(u) { const t = crypto.randomBytes(20).toString('hex'); u.gameToken = sha(t); save(); return t; },
    byGameToken(t) { const h = sha(String(t || '')); if (!t) return null; for (const u of Object.values(db.users)) if (u.gameToken === h) return u; return null; },
    profile: publicProfile,
    count: () => Object.keys(db.users).length,
    addResult(steamId, won) { const u = Object.values(db.users).find(x => x.steamId === String(steamId)); if (!u) return; if (won) u.stats.wins++; else u.stats.losses++; u.stats.xp += won ? 30 : 10; u.stats.level = 1 + Math.floor(u.stats.xp / 200); save(); }
  };
};

