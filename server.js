// Servidor do Gatinho em Casa: serve o jogo e repassa mensagens entre jogadores da mesma sala (WebSocket, sem dependências).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public'), MAX = 16;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const rooms = new Map(); // sala -> Map(id -> { socket, pres }) com .skew (ms que o relógio da sala adiantou dormindo)
const SLEEP_X = 24; // com TODOS da sala dormindo (presença sl = 1) o relógio do jogo corre 24x mais rápido

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d);
  });
});

function frame(str) {
  const p = Buffer.from(str), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function sendTo(s, o) { if (!s.destroyed) s.write(frame(JSON.stringify(o))); }
let lastTick = Date.now();
setInterval(() => {   // adianta o relógio de cada sala em que todos estão dormindo e avisa os clientes (1x por segundo)
  const now = Date.now(), dt = Math.min(1000, now - lastTick); lastTick = now;
  rooms.forEach(members => {
    let all = members.size > 0; members.forEach(m => { if (m.pres.sl !== 1) all = false; });
    if (all) members.skew += dt * (SLEEP_X - 1);
    if ((all && now - (members.lastClock || 0) >= 1000) || (!all && members.wasAll)) {
      members.lastClock = now; members.forEach(m => sendTo(m.socket, { t: 'clock', now: now + members.skew }));
    }
    members.wasAll = all;
  });
}, 200).unref();

function cleanPresence(o) {
  const out = {}; if (!o || typeof o !== 'object') return out;
  Object.keys(o).slice(0, 10).forEach(k => {
    const v = o[k]; if (!/^[a-z][a-z0-9_]{0,11}$/.test(k)) return;
    if (typeof v === 'number' && isFinite(v)) out[k] = v; else if (typeof v === 'string') out[k] = v.slice(0, 24);
  });
  return out;
}

server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
  const room = (u.searchParams.get('room') || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 48);
  if (u.pathname !== '/ws' || !key || !room) return socket.destroy();
  let members = rooms.get(room); if (!members) { rooms.set(room, members = new Map()); members.skew = 0; }
  if (members.size >= MAX) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return socket.destroy(); }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  const id = crypto.randomBytes(4).toString('hex'), me = { socket, pres: {} };
  const send = (s, o) => { if (!s.destroyed) s.write(frame(JSON.stringify(o))); };
  const others = o => members.forEach((m, k) => { if (k !== id) send(m.socket, o); });
  const peers = {}; members.forEach((m, k) => { peers[k] = m.pres; });
  members.set(id, me);
  send(socket, { t: 'hello', peer: id, peers, now: Date.now() + members.skew });
  others({ t: 'pres', peer: id, patch: {} });

  let tokens = 80, last = Date.now();
  function onMsg(txt) {
    const now = Date.now(); tokens = Math.min(80, tokens + (now - last) * 0.06); last = now;
    if (tokens < 1) return; tokens--;
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.t === 'pres') { const patch = cleanPresence(m.patch); Object.assign(me.pres, patch); others({ t: 'pres', peer: id, patch }); }
    else if (m.t === 'emit' && /^[a-z][a-z0-9_.-]{0,47}$/.test(m.topic)) others({ t: 'emit', peer: id, topic: m.topic, data: m.data });
  }
  let buf = Buffer.alloc(0);
  socket.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, fin = buf[0] & 128; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16384 || !(buf[1] & 128)) return socket.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4), pl = Buffer.from(buf.slice(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) pl[i] ^= mask[i & 3];
      buf = buf.slice(off + 4 + len);
      if (op === 8) return socket.end();
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, pl.length]), pl])); continue; }
      if (op === 1 && fin) onMsg(pl.toString());
    }
  });
  const bye = () => { if (!members.delete(id)) return; others({ t: 'leave', peer: id }); if (!members.size) rooms.delete(room); };
  socket.on('close', bye); socket.on('error', bye);
});

if (require.main === module) server.listen(PORT, () => console.log('Gatinho em Casa rodando em http://localhost:' + PORT));
module.exports = { server };
