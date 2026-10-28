// The Last War - account/control channel (JSON lines over TLS) used by the launcher.
// Passwords never travel in clear text: the channel is TLS with a self-signed certificate that the launcher pins on first use.
const tls = require('tls'), net = require('net'), fs = require('fs'), path = require('path'), cp = require('child_process');

function loadCreds(dir) {
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem'), pfx = path.join(dir, 'cert.pfx');
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  if (fs.existsSync(pfx)) return { pfx: fs.readFileSync(pfx), passphrase: 'tlw' };
  try { cp.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=tlw-server'], { stdio: 'ignore' }); return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }; } catch { return null; }
}

module.exports = function startControl(port, accounts, dataDir, opts = {}) {
  const gw = opts.gateway;
  const log = opts.log || (() => {});
  const creds = process.env.TLW_PLAIN === '1' ? null : loadCreds(dataDir);
  if (!creds) log('WARNING: no TLS certificate (install openssl or set TLW_PLAIN=1 for local tests) - control channel is PLAIN TEXT');
  const handler = sock => {
    sock.setEncoding('utf8'); sock.setKeepAlive(true, 15000); let buf = ''; let user = null; const ip = (sock.remoteAddress || '').replace('::ffff:', '');
    const reply = (id, obj) => sock.write(JSON.stringify({ id, ...obj }) + '\n');
    sock.on('data', chunk => {
      buf += chunk; if (buf.length > 65536) { sock.destroy(); return; } let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
        try {
          const id = m.id;
          switch (m.cmd) {
            case 'ping': reply(id, { ok: true, accounts: accounts.count(), ...(opts.gateway ? opts.gateway.stats() : {}) }); break;
            case 'lobbies': reply(id, { ok: true, lobbies: opts.gateway ? [...opts.gateway.lobbies.values()].map(l => ({ id: l.id, name: l.data.get('KEY_NAME') || '', map: l.data.get('KEY_MAP') || '', mode: l.data.get('KEY_GAMETYPE') || '', players: l.members.length, max: l.max, joinable: l.joinable, host: opts.gateway.users.get(l.owner)?.name || '' })) : [] }); break;
            case 'register': { const r = accounts.register(m, ip); if (r.ok) user = accounts.bySession(r.token); reply(id, r); break; }
            case 'login': { const r = accounts.login(m, ip); if (r.ok) user = accounts.bySession(r.token); reply(id, r); break; }
            case 'resume': { const u = accounts.bySession(m.token); if (u) { user = u; reply(id, { ok: true, profile: accounts.profile(u) }); } else reply(id, { ok: false, error: 'نشست منقضی شده؛ دوباره وارد شوید' }); break; }
            case 'logout': accounts.logout(m.token); user = null; reply(id, { ok: true }); break;
            default:
              if (!user) { reply(id, { ok: false, error: 'ابتدا وارد شوید' }); break; }
              if (m.cmd === 'me') reply(id, { ok: true, profile: accounts.profile(user) });
              else if (m.cmd === 'setDisplay') reply(id, accounts.setDisplay(user, m.display));
              else if (m.cmd === 'changePassword') reply(id, accounts.changePassword(user, m.oldPassword, m.newPassword));
              else if (m.cmd === 'friends') { const r = accounts.friendsOf(user); const on = gw ? new Set([...gw.users.values()].filter(x => x.sock).map(x => x.sid)) : new Set(); const tag = l => l.map(f => ({ ...f, online: on.has(f.steamId), inGame: !!(gw && gw.users.get(f.steamId)?.lobby) })); reply(id, { ok: true, friends: tag(r.friends), requests: r.requests }); }
              else if (m.cmd === 'friendRequest') reply(id, accounts.friendRequest(user, m.username));
              else if (m.cmd === 'friendAccept') reply(id, accounts.friendAccept(user, m.username));
              else if (m.cmd === 'friendDecline') reply(id, accounts.friendDecline(user, m.username));
              else if (m.cmd === 'friendRemove') reply(id, accounts.friendRemove(user, m.username));
              else if (m.cmd === 'searchUsers') reply(id, { ok: true, users: accounts.search(m.query) });
              else if (m.cmd === 'leaderboard') reply(id, { ok: true, rows: accounts.leaderboard(m.by, m.limit) });
              else if (m.cmd === 'userProfile') { const u = accounts.userCard(m.username); reply(id, u ? { ok: true, user: u } : { ok: false, error: 'کاربر پیدا نشد' }); }
              else if (m.cmd === 'gameToken') reply(id, { ok: true, token: accounts.issueGameToken(user), steamId: user.steamId, display: user.display });
              else reply(id, { ok: false, error: 'دستور ناشناخته' });
          }
        } catch (e) { log('control error ' + e.message); }
      }
    });
    sock.on('error', () => {});
  };
  const server = creds ? tls.createServer({ ...creds, minVersion: 'TLSv1.2' }, handler) : net.createServer(handler);
  server.listen(port, () => log('control channel on ' + port + (creds ? ' (TLS)' : ' (PLAIN)')));
  return server;
};

