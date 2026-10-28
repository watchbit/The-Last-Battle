const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

function zipEntry(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const n = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (n === name) {
      const start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
      const data = buf.subarray(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

module.exports = function Admin(dataDir, accounts, gateway) {
  const upd = path.join(dataDir, 'updates'), game = path.join(dataDir, 'game');
  fs.mkdirSync(upd, { recursive: true }); fs.mkdirSync(game, { recursive: true });
  const idxFile = path.join(upd, 'index.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch { return { news: '', patches: [] }; } };
  const store = idx => { idx.patches.sort((a, b) => a.id - b.id); fs.writeFileSync(idxFile + '.tmp', JSON.stringify(idx, null, 1)); fs.renameSync(idxFile + '.tmp', idxFile); };
  const pub = () => { const i = load(); return { news: i.news || '', patches: i.patches.filter(p => p.published) }; };
  const user = process.env.TLW_ADMIN_USER || 'admin', pass = process.env.TLW_ADMIN_PASSWORD || '';
  const authed = req => {
    if (!pass) return false;
    const m = String(req.headers.authorization || '').match(/^Basic (.+)$/); if (!m) return false;
    const [u, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
    const a = Buffer.from(u + ':' + rest.join(':')), b = Buffer.from(user + ':' + pass);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const raw = (req, limit) => new Promise((ok, no) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > limit) { no(new Error('too large')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });
  const file = (res, f, type) => {
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res);
  };
  const inside = (root, rel) => { const f = path.resolve(root, rel); return f.startsWith(path.resolve(root) + path.sep) ? f : null; };

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/updates/index.json') return json(res, 200, pub());
    let m;
    if ((m = p.match(/^\/updates\/(patch_\d{3,}\.zip)$/))) { const e = load().patches.find(x => x.file === m[1] && x.published); if (!e) { res.writeHead(404); return res.end(); } return file(res, path.join(upd, m[1]), 'application/zip'); }
    if (p === '/game/manifest.json') return file(res, path.join(game, 'manifest.json'), 'application/json');
    if (p.startsWith('/game/files/')) { const f = inside(path.join(game, 'files'), decodeURIComponent(p.slice(12))); if (!f) { res.writeHead(403); return res.end(); } return file(res, f); }
    if (!p.startsWith('/admin')) return false;
    if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TLB admin", charset="UTF-8"' }); return res.end(pass ? 'auth required' : 'admin disabled: set TLW_ADMIN_PASSWORD'); }
    if (p === '/admin' || p === '/admin/') return file(res, path.join(__dirname, 'admin', 'index.html'), 'text/html; charset=utf-8');
    if (p === '/admin/api/state') return json(res, 200, { index: load(), users: accounts.adminList(), online: gateway.stats(), lobbies: gateway.lobbies.size });
    if (p === '/admin/api/news' && req.method === 'POST') { const i = load(); i.news = String(JSON.parse((await raw(req, 65536)).toString() || '{}').news || '').slice(0, 4000); store(i); return json(res, 200, { ok: true }); }
    if (p === '/admin/api/patch' && req.method === 'POST') {
      let buf; try { buf = await raw(req, 2 * 1024 * 1024 * 1024); } catch (e) { return json(res, 413, { ok: false, error: e.message }); }
      let man; try { man = JSON.parse(zipEntry(buf, 'manifest.json').toString('utf8')); } catch { return json(res, 400, { ok: false, error: 'فایل زیپ پچ معتبر نیست (manifest.json ندارد)' }); }
      const i = load(); const id = Number.isInteger(man.id) && man.id > 0 ? man.id : (Math.max(0, ...i.patches.map(x => x.id)) + 1);
      const name = String(url.searchParams.get('name') || man.name || 'patch ' + id).slice(0, 200);
      const f = 'patch_' + String(id).padStart(3, '0') + '.zip';
      fs.writeFileSync(path.join(upd, f), buf);
      const entry = { id, name, file: f, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), published: url.searchParams.get('publish') === '1', uploaded: Date.now() };
      i.patches = i.patches.filter(x => x.id !== id); i.patches.push(entry); store(i);
      return json(res, 200, { ok: true, patch: entry, replacedId: !Number.isInteger(man.id) ? null : id });
    }
    if ((m = p.match(/^\/admin\/api\/patch\/(\d+)\/(publish|unpublish|delete)$/)) && req.method === 'POST') {
      const i = load(); const e = i.patches.find(x => x.id === +m[1]); if (!e) return json(res, 404, { ok: false });
      if (m[2] === 'delete') { i.patches = i.patches.filter(x => x !== e); try { fs.unlinkSync(path.join(upd, e.file)); } catch {} } else e.published = m[2] === 'publish';
      store(i); return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/admin\/api\/user\/([\w]+)\/(ban|unban|admin|unadmin)$/)) && req.method === 'POST') return json(res, 200, accounts.adminSet(m[1], m[2].endsWith('admin') ? 'admin' : 'banned', !m[2].startsWith('un')));
    return json(res, 404, { ok: false, error: 'unknown' });
  };
};
