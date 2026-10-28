// The Last War - matchmaking / lobby server (prototype, in-memory). No dependencies.
// Run: node server.js [port]   (default 8080). Serves the launcher UI from ./ui and the API under /api.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +(process.argv[2] || process.env.PORT || 8080);
const UI = path.join(__dirname, 'ui');

const players = new Map();   // token -> {name, token, room, queue, seen}
const rooms = new Map();     // id -> {id,name,mode,map,nation,max,pass,host,members:[token],state}
const queue = [];            // [{token,mode,map,nation,since}]
const clients = new Set();   // SSE responses
const MAX = { '1v1': 2, '2v2': 4, '4v4': 8, 'coop': 4 };
let seq = 1;

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
const me = req => players.get((req.headers.authorization || '').replace('Bearer ', ''));
const pub = r => ({ id: r.id, name: r.name, mode: r.mode, map: r.map, nation: r.nation, max: r.max, locked: !!r.pass, state: r.state,
  host: players.get(r.host)?.name, players: r.members.map(t => ({ name: players.get(t)?.name, ready: !!players.get(t)?.ready })) });
const stats = () => ({ online: players.size, rooms: rooms.size, queued: queue.length,
  playing: [...rooms.values()].filter(r => r.state === 'playing').length });
function broadcast(event, data) { const m = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(m); }
function push(token, event, data) { for (const c of clients) if (c.token === token) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const roomsChanged = () => broadcast('rooms', { rooms: [...rooms.values()].map(pub), stats: stats() });

function leaveRoom(p) {
  const r = rooms.get(p.room); p.room = null; p.ready = false; if (!r) return;
  r.members = r.members.filter(t => t !== p.token);
  if (!r.members.length) rooms.delete(r.id); else if (r.host === p.token) r.host = r.members[0];
  for (const t of r.members) push(t, 'room', pub(r));
}
function joinRoom(p, r) {
  if (p.room) leaveRoom(p); r.members.push(p.token); p.room = r.id;
  for (const t of r.members) push(t, 'room', pub(r));
}
function tryMatch() {
  for (let i = 0; i < queue.length; i++) for (let j = i + 1; j < queue.length; j++) {
    const a = queue[i], b = queue[j];
    if (a.mode !== b.mode || (MAX[a.mode] || 2) !== 2) continue;
    queue.splice(j, 1); queue.splice(i, 1);
    const pa = players.get(a.token), pb = players.get(b.token); if (!pa || !pb) return tryMatch();
    pa.queue = pb.queue = false;
    const id = 'r' + seq++; const room = { id, name: `رتبه‌ای ${pa.name} / ${pb.name}`, mode: a.mode, map: a.map, nation: a.nation, max: 2, pass: '', host: pa.token, members: [], state: 'lobby' };
    rooms.set(id, room); joinRoom(pa, room); joinRoom(pb, room);
    push(a.token, 'matched', pub(room)); push(b.token, 'matched', pub(room)); roomsChanged(); return;
  }
}
// drop idle players
setInterval(() => { const now = Date.now(); for (const p of [...players.values()]) if (now - p.seen > 60000) { leaveRoom(p); const q = queue.findIndex(x => x.token === p.token); if (q >= 0) queue.splice(q, 1); players.delete(p.token); } roomsChanged(); }, 15000);

const DATA = process.env.TLW_DATA || path.join(__dirname, 'data');
const accounts = require('./accounts')(DATA);
const gateway = require('./gateway')(+(process.env.GATEWAY_PORT || 8081), { log: m => console.log('[gw] ' + m), accounts, dataDir: DATA, requireAuth: process.env.TLW_REQUIRE_AUTH === '1' });
require('./control')(+(process.env.CONTROL_PORT || 8082), accounts, DATA, { log: m => console.log('[ctl] ' + m), gateway });
const admin = require('./admin')(DATA, accounts, gateway);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = me(req);
  if (p) p.seen = Date.now();
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST' }); return res.end(); }
  if (url.pathname === '/api/events') {
    const t = url.searchParams.get('token'); res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.token = t; clients.add(res); res.write(`event: hello\ndata: ${JSON.stringify(stats())}\n\n`); req.on('close', () => clients.delete(res)); return;
  }
  if (await admin(req, res, url) !== false) return;
  if (url.pathname.startsWith('/api/')) {
    const b = req.method === 'POST' ? await body(req) : {};
    if (url.pathname === '/api/ping') return send(res, 200, { ok: true, t: Date.now() });
    if (url.pathname === '/api/stats') return send(res, 200, { ...stats(), gateway: gateway.stats() });
    if (url.pathname === '/api/lobbies') return send(res, 200, { lobbies: [...gateway.lobbies.values()].map(l => ({ id: l.id, name: l.data.get('KEY_NAME') || '', map: l.data.get('KEY_MAP') || '', mode: l.data.get('KEY_GAMETYPE') || '', players: l.members.length, max: l.max, joinable: l.joinable, host: gateway.users.get(l.owner)?.name || '' })) });
    if (url.pathname === '/api/login') {
      const name = String(b.name || '').trim().slice(0, 24) || 'Player' + Math.floor(Math.random() * 9000 + 1000);
      const token = crypto.randomBytes(12).toString('hex'); players.set(token, { name, token, room: null, queue: false, ready: false, seen: Date.now() }); roomsChanged();
      return send(res, 200, { token, name, stats: stats() });
    }
    if (url.pathname === '/api/rooms' && req.method === 'GET') return send(res, 200, { rooms: [...rooms.values()].map(pub), stats: stats() });
    if (!p) return send(res, 401, { error: 'login required' });
    if (url.pathname === '/api/rooms' && req.method === 'POST') {
      const mode = MAX[b.mode] ? b.mode : '1v1'; const id = 'r' + seq++;
      const room = { id, name: String(b.name || 'اتاق ' + p.name).slice(0, 40), mode, map: String(b.map || 'normandy').slice(0, 30), nation: String(b.nation || 'ger'), max: MAX[mode], pass: String(b.pass || ''), host: p.token, members: [], state: 'lobby' };
      rooms.set(id, room); joinRoom(p, room); roomsChanged(); return send(res, 200, pub(room));
    }
    let m;
    if ((m = url.pathname.match(/^\/api\/rooms\/(\w+)\/(join|leave|ready|start)$/))) {
      const r = rooms.get(m[1]); if (!r) return send(res, 404, { error: 'room not found' });
      if (m[2] === 'join') { if (r.members.length >= r.max) return send(res, 409, { error: 'room full' }); if (r.pass && r.pass !== String(b.pass || '')) return send(res, 403, { error: 'wrong password' }); joinRoom(p, r); }
      else if (m[2] === 'leave') leaveRoom(p);
      else if (m[2] === 'ready') { p.ready = !p.ready; for (const t of r.members) push(t, 'room', pub(r)); }
      else if (m[2] === 'start') { if (r.host !== p.token) return send(res, 403, { error: 'host only' }); r.state = 'playing'; for (const t of r.members) push(t, 'start', { room: pub(r), connect: { note: 'game connection is handled by the launcher/game client' } }); }
      roomsChanged(); return send(res, 200, pub(r));
    }
    if (url.pathname === '/api/queue/join') { if (p.room) leaveRoom(p); if (!queue.find(x => x.token === p.token)) queue.push({ token: p.token, mode: MAX[b.mode] ? b.mode : '1v1', map: b.map || 'normandy', nation: b.nation || 'ger', since: Date.now() }); p.queue = true; tryMatch(); broadcast('stats', stats()); return send(res, 200, { queued: true, position: queue.length }); }
    if (url.pathname === '/api/queue/leave') { const i = queue.findIndex(x => x.token === p.token); if (i >= 0) queue.splice(i, 1); p.queue = false; broadcast('stats', stats()); return send(res, 200, { queued: false }); }
    return send(res, 404, { error: 'unknown endpoint' });
  }
  // static launcher UI
  let f = path.join(UI, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)); if (!f.startsWith(UI) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
server.listen(PORT, () => console.log('The Last War server on http://0.0.0.0:' + PORT));




