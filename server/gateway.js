// The Last War - Steam lobby/P2P gateway for the game client (steam_api64 emulator).
// Line protocol over TCP (UTF-8, tab separated, one message per line, binary as base64).
const net = require('net'), fs = require('fs'), path = require('path');

module.exports = function startGateway(port, opts = {}) {
  const log = opts.log || (() => {});
  const lobbies = new Map();   // id(string) -> lobby
  const users = new Map();     // steamid(string) -> {sock, name, lobby}
  let seq = 1;

  const esc = s => String(s == null ? '' : s).replace(/[\t\r\n\\]/g, c => ({ '\t': '\\t', '\r': '\\r', '\n': '\\n', '\\': '\\\\' }[c]));
  const unesc = s => String(s).replace(/\\(.)/g, (_, c) => ({ t: '\t', r: '\r', n: '\n', '\\': '\\' }[c] || c));
  const send = (sock, ...f) => { if (sock && !sock.destroyed) sock.write(f.map(esc).join('\t') + '\n'); };
  const toMembers = (lb, ...f) => { for (const m of lb.members) send(users.get(m.sid)?.sock, ...f); };
  const toOthers = (lb, from, ...f) => { for (const m of lb.members) if (m.sid !== from) send(users.get(m.sid)?.sock, ...f); };

  // Valve lobby ids: universe 1, type chat(7), instance 0x40000 -> 0x0186... style
  const newLobbyId = () => String(0x0186000000000000n | BigInt(seq++));
  const dataLine = lb => [...lb.data.entries()].map(([k, v]) => esc(k) + '=' + esc(v)).join('\x1f');

  function listItem(lb) { return ['LISTITEM', lb.id, lb.members.length, lb.max, lb.owner, dataLine(lb)]; }

  function leave(u) {
    if (!u.lobby) return; const lb = lobbies.get(u.lobby); u.lobby = null; if (!lb) return;
    lb.members = lb.members.filter(m => m.sid !== u.sid);
    if (!lb.members.length) { lobbies.delete(lb.id); log('lobby ' + lb.id + ' closed'); return; }
    if (lb.owner === u.sid) lb.owner = lb.members[0].sid;
    toMembers(lb, 'MEMBER', lb.id, u.sid, 'left', lb.owner, u.name);
  }

  const server = net.createServer(sock => {
    sock.setNoDelay(true); sock.setKeepAlive(true, 10000); sock.setEncoding('utf8'); let buf = ''; let me = null;
    sock.on('data', chunk => {
      buf += chunk; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line) continue;
        const f = line.split('\t').map(unesc); const cmd = f[0];
        try {
          if (cmd === 'HELLO' || cmd === 'AUTH') {
            let sid, name;
            if (cmd === 'AUTH') { const acc = opts.accounts && opts.accounts.byGameToken(f[1]); if (!acc) { send(sock, 'ERR', 'auth', 'invalid game token - log in with the launcher'); continue; } sid = acc.steamId; name = acc.display; }
            else { if (opts.requireAuth) { send(sock, 'ERR', 'auth', 'accounts required - log in with the launcher'); continue; } sid = f[1]; name = f[2]; }
            const old = users.get(sid);
            if (old) { if (old.timer) { clearTimeout(old.timer); old.timer = null; } if (old.sock && old.sock !== sock && !old.sock.destroyed) old.sock.destroy(); old.sock = sock; old.name = name || old.name; me = old; log('resume ' + me.name + (me.lobby ? ' (lobby kept)' : '')); }
            else { me = { sid, name: name || ('P' + sid.slice(-4)), sock, lobby: null, timer: null }; users.set(sid, me); log((cmd === 'AUTH' ? 'login ' : 'guest ') + me.name + ' ' + sid); }
            send(sock, 'WELCOME', sid, users.size, me.name);
          } else if (!me) { send(sock, 'ERR', 'hello first');
          } else if (cmd === 'PING') { send(sock, 'PONG', f[1]);
          } else if (cmd === 'LIST') {
            const items = [...lobbies.values()].filter(lb => lb.joinable && lb.type !== 0 && lb.members.length < lb.max || false);
            send(sock, 'LISTBEGIN', f[1] || '', items.length); for (const lb of items) send(sock, ...listItem(lb)); send(sock, 'LISTEND', f[1] || '');
          } else if (cmd === 'CREATE') {
            leave(me); const lb = { id: newLobbyId(), type: +f[2] || 2, max: +f[3] || 8, joinable: true, owner: me.sid, data: new Map(), members: [{ sid: me.sid, data: new Map() }] };
            lobbies.set(lb.id, lb); me.lobby = lb.id; send(sock, 'CREATED', f[1] || '', lb.id); log('create ' + lb.id + ' by ' + me.name);
          } else if (cmd === 'JOIN') {
            const lb = lobbies.get(f[2]); let resp = 1;
            if (!lb) resp = 3; else if (lb.members.length >= lb.max) resp = 4; else if (!lb.joinable && !lb.members.some(m => m.sid === me.sid)) resp = 5;
            if (resp !== 1) { send(sock, 'ENTER', f[1] || '', f[2], resp); }
            else {
              leave(me); lb.members.push({ sid: me.sid, data: new Map() }); me.lobby = lb.id;
              const mem = lb.members.map(m => [m.sid, users.get(m.sid)?.name || '', [...m.data.entries()].map(([k, v]) => esc(k) + '=' + esc(v)).join('\x1f')].join('\x1d')).join('\x1e');
              send(sock, 'ENTER', f[1] || '', lb.id, 1, lb.owner, lb.max, dataLine(lb), mem);   // the full lobby state travels in ONE frame so the game never sees a half-built lobby
              for (const m of lb.members) { for (const [k, v] of m.data) send(sock, 'MEMBERDATA', lb.id, m.sid, k, v); if (m.sid !== me.sid) send(sock, 'MEMBER', lb.id, m.sid, 'present', lb.owner, users.get(m.sid)?.name || ''); }
              toOthers(lb, me.sid, 'MEMBER', lb.id, me.sid, 'entered', lb.owner, me.name); log(me.name + ' joined ' + lb.id);
            }
          } else if (cmd === 'LBINFO' && opts.accounts) { opts.accounts.boardInfo(f[2], +f[3] || 0, +f[4] || 0);
          } else if (cmd === 'LBGET' && opts.accounts) {
            const sids = (f[6] || '').split(',').filter(Boolean); const r = opts.accounts.boardGet(f[2], +f[3] || 0, +f[4] || 0, +f[5] || 0, me.sid, sids);
            const rows = r.list.map(e => [e.rank, e.sid, e.score, (e.details || []).join(','), e.name || users.get(e.sid)?.name || ('P' + String(e.sid).slice(-4))].join('\x1d')).join('\x1e');
            send(sock, 'LBRES', f[1] || '', f[2], r.total, rows);
          } else if (cmd === 'LBSET' && opts.accounts) {
            const det = (f[5] || '').split(',').filter(Boolean).map(Number); const r = opts.accounts.boardSet(f[2], me.sid, +f[3] || 1, +f[4] || 0, det);
            log('score ' + me.name + ' ' + f[2] + ' = ' + f[4]); send(sock, 'LBSETRES', f[1] || '', f[2], r.score, r.changed ? 1 : 0, r.rank, r.prev);
          } else if (cmd === 'STATGET' && opts.accounts) {
            const st = opts.accounts.statsGet(f[2] || me.sid); send(sock, 'STATRES', f[1] || '', f[2] || me.sid, Object.entries(st).map(([k, v]) => esc(k) + '=' + esc(v)).join('\x1f'));
          } else if (cmd === 'STATSET' && opts.accounts) { opts.accounts.statsSet(me.sid, f[1], f[2]);          } else if (cmd === 'RSLIST' && opts.dataDir) {
            const dir = path.join(opts.dataDir, 'cloud', String(me.sid).replace(/\D/g, '')); fs.mkdirSync(dir, { recursive: true });
            for (const n of fs.readdirSync(dir)) { try { send(sock, 'RSFILE', n, fs.readFileSync(path.join(dir, n)).toString('base64')); } catch {} }
            send(sock, 'RSEND');
          } else if (cmd === 'RSPUT' && opts.dataDir) {
            const dir = path.join(opts.dataDir, 'cloud', String(me.sid).replace(/\D/g, '')); fs.mkdirSync(dir, { recursive: true });
            const n = String(f[1]).replace(/[^\w.\-]/g, '_').slice(0, 80); const buf = Buffer.from(f[2] || '', 'base64');
            if (n && buf.length <= 4 * 1024 * 1024 && (fs.existsSync(path.join(dir, n)) || fs.readdirSync(dir).length < 64)) fs.writeFileSync(path.join(dir, n), buf);
          } else if (cmd === 'RSDEL' && opts.dataDir) {
            const n = String(f[1]).replace(/[^\w.\-]/g, '_').slice(0, 80); try { fs.unlinkSync(path.join(opts.dataDir, 'cloud', String(me.sid).replace(/\D/g, ''), n)); } catch {}          } else if (cmd === 'FRIENDS' && opts.accounts) {
            const fl = opts.accounts.friendSids(me.sid); send(sock, 'FRIENDLIST', f[1] || '', fl.map(x => [x.sid, x.name, users.get(x.sid)?.sock ? 1 : 0, users.get(x.sid)?.lobby || ''].join('\x1d')).join('\x1e'));
          } else if (cmd === 'INVITE') { const t = users.get(f[1]); if (t && me.lobby) send(t.sock, 'INVITED', me.sid, me.name, me.lobby);
          } else if (cmd === 'LEAVE') { leave(me);
          } else {
            const lb = lobbies.get(me.lobby);
            if (cmd === 'SETDATA' && lb) { if (f[3] === '\u0000DEL') lb.data.delete(f[2]); else lb.data.set(f[2], f[3]); toOthers(lb, me.sid, 'DATA', lb.id, f[2], f[3]);
            } else if (cmd === 'SETMEMBER' && lb) { const m = lb.members.find(x => x.sid === me.sid); if (m) m.data.set(f[2], f[3]); toOthers(lb, me.sid, 'MEMBERDATA', lb.id, me.sid, f[2], f[3]);
            } else if (cmd === 'CHAT' && lb) { toOthers(lb, me.sid, 'CHAT', lb.id, me.sid, f[2]);
            } else if (cmd === 'JOINABLE' && lb && lb.owner === me.sid) { lb.joinable = f[1] === '1';
            } else if (cmd === 'LIMIT' && lb && lb.owner === me.sid) { lb.max = +f[1] || lb.max;
            } else if (cmd === 'TYPE' && lb && lb.owner === me.sid) { lb.type = +f[1];
            } else if (cmd === 'OWNER' && lb && lb.owner === me.sid) { lb.owner = f[1]; toMembers(lb, 'MEMBER', lb.id, f[1], 'owner', f[1], users.get(f[1])?.name || '');
            } else if (cmd === 'P2P') { const t = users.get(f[1]); if (t) send(t.sock, 'P2P', me.sid, f[2], f[3]); else send(sock, 'P2PFAIL', f[1]);
            } else if (cmd === 'REQDATA') { const l2 = lobbies.get(f[1]); if (l2) { for (const [k, v] of l2.data) send(sock, 'DATA', l2.id, k, v); for (const m of l2.members) for (const [k, v] of m.data) send(sock, 'MEMBERDATA', l2.id, m.sid, k, v); }
            }
          }
        } catch (e) { log('error ' + e.message); }
      }
    });
    const drop = () => { if (!me || users.get(me.sid) !== me || me.sock !== sock) return; me.sock = null; log('offline ' + me.name + ' (grace 45s)'); me.timer = setTimeout(() => { if (users.get(me.sid) === me && !me.sock) { leave(me); users.delete(me.sid); log('bye ' + me.name); } }, 45000); };
    sock.on('close', drop); sock.on('error', () => {});
  });
  server.listen(port, () => log('gateway on ' + port));
  return { lobbies, users, stats: () => ({ players: users.size, lobbies: lobbies.size }) };
};






