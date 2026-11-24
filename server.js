// Servidor do Luna's Life: serve o jogo e repassa mensagens entre jogadores da mesma sala (WebSocket, sem dependências).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { createChatGuard } = require('./chat-guard.js');   // limite de velocidade, validação, filtros e anti-spam do chat
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public'), MAX = 10;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const rooms = new Map(); // sala -> Map(id -> { socket, pres }) com .skew (ms que o relógio da sala adiantou dormindo)
const DAY_MS = 600000;  // ciclo de 24 h do jogo = 10 min reais (igual ao cliente)
const SLEEP_X = 24; // com TODOS da sala dormindo (presença sl = 1) o relógio do jogo corre 24x mais rápido

// Atualização automática: o .exe baixa /update/manifest.json (versão do package.json + hash de cada arquivo de public/) e, se a versão for maior, baixa os arquivos.
const VERSION = (() => { try { return require('./package.json').version; } catch (e) { return '0.0.0'; } })();
let manifestCache = null;
function listFiles(dir, rel) {
  let out = []; rel = rel || '';
  fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).forEach(e => {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(listFiles(dir, r)); else if (e.isFile() && !e.name.startsWith('.')) out.push(r);
  });
  return out;
}
function manifest() {
  const names = listFiles(PUB).sort(), key = VERSION + '|' + names.map(n => { const s = fs.statSync(path.join(PUB, n)); return n + ':' + s.size + ':' + s.mtimeMs; }).join('|');
  if (!manifestCache || manifestCache.key !== key) {
    const files = names.map(name => { const d = fs.readFileSync(path.join(PUB, name)); return { name, size: d.length, sha256: crypto.createHash('sha256').update(d).digest('hex') }; });
    manifestCache = { key, json: JSON.stringify({ version: VERSION, files }) };
  }
  return manifestCache.json;
}

const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/update/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(manifest());
  }
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

// Comandos do chat (/day, /rain...): o servidor é quem manda; vale para TODOS da sala. Estado da sala: members.skew (horário) e members.env (chuva/lua).
const TIMES = { day: 12, afternoon: 17, night: 21, dawn: 3 };
function setHour(members, h) { const T = Date.now() + members.skew; members.skew += Math.floor(T / DAY_MS) * DAY_MS + h / 24 * DAY_MS - T; }
function runCommand(members, c, a, who) {   // devolve { msg, clock, env } ou null (comando desconhecido)
  if (TIMES[c] !== undefined) { setHour(members, TIMES[c]); return { msg: who + ' changed the time to ' + c + '.', clock: true }; }
  if (c === 'rain') {
    if (a === 'auto') { members.env.rain = null; return { msg: who + ' set the weather back to natural.', env: true }; }
    members.env.rain = 1; return { msg: who + ' made it rain.', env: true };
  }
  if (c === 'stoprain') { members.env.rain = 0; return { msg: who + ' stopped the rain.', env: true }; }
  if (c === 'redmoon') {
    if (a === 'off' || a === 'auto') { members.env.red = null; return { msg: who + ' brought the normal moon back.', env: true }; }
    const T = Date.now() + members.skew, h = (T % DAY_MS) / DAY_MS * 24, r = { env: true, msg: who + ' summoned the red moon for tonight.' };
    if (!(h >= 19 || h < 5)) { setHour(members, 21); r.clock = true; }   // a lua vermelha só aparece de noite
    members.env.red = Math.floor((Date.now() + members.skew + DAY_MS * 0.5) / DAY_MS);   // só esta noite (do meio-dia ao meio-dia seguinte)
    return r;
  }
  return null;
}

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
  let members = rooms.get(room); if (!members) { rooms.set(room, members = new Map()); members.skew = 0; members.env = { rain: null, red: null }; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  if (members.size >= MAX) {   // sala cheia (máx. 10): aceita a conexão só para avisar o jogador e fecha
    socket.write(frame(JSON.stringify({ t: 'full', max: MAX })));
    return setTimeout(() => socket.destroy(), 200);
  }
  socket.setNoDelay(true);

  const id = crypto.randomBytes(4).toString('hex'), me = { socket, pres: {} };
  const send = (s, o) => { if (!s.destroyed) s.write(frame(JSON.stringify(o))); };
  const others = o => members.forEach((m, k) => { if (k !== id) send(m.socket, o); });
  const peers = {}; members.forEach((m, k) => { peers[k] = m.pres; });
  members.set(id, me);
  send(socket, { t: 'hello', peer: id, peers, now: Date.now() + members.skew, env: members.env });
  others({ t: 'pres', peer: id, patch: {} });

  const chat = createChatGuard();   // estado do chat desta conexão (limite de velocidade, últimas mensagens)
  let tokens = 80, last = Date.now(), lastCmd = 0;
  function onMsg(txt) {
    const now = Date.now(); tokens = Math.min(80, tokens + (now - last) * 0.06); last = now;
    if (tokens < 1) return; tokens--;
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.t === 'pres') { const patch = cleanPresence(m.patch); if (typeof patch.n === 'string') patch.n = chat.name(patch.n); Object.assign(me.pres, patch); others({ t: 'pres', peer: id, patch }); }
    else if (m.t === 'ping') send(socket, { t: 'pong', c: m.c });   // mostrador de ping do cliente
    else if (m.t === 'cmd') {   // comandos do chat: /day /afternoon /night /dawn /rain /stoprain /redmoon
      if (now - lastCmd < 2000) return send(socket, { t: 'notice', msg: 'Slow down! Wait a moment before using another command.' });
      lastCmd = now;
      const who = typeof me.pres.n === 'string' && me.pres.n ? me.pres.n : 'Player';
      const r = runCommand(members, typeof m.c === 'string' ? m.c : '', typeof m.a === 'string' ? m.a.toLowerCase().slice(0, 8) : '', who);
      if (!r) return send(socket, { t: 'notice', msg: 'Unknown command. Type / to see the list.' });
      members.forEach(x => {
        if (r.clock) send(x.socket, { t: 'clock', now: Date.now() + members.skew });
        if (r.env) send(x.socket, { t: 'env', rain: members.env.rain, red: members.env.red });
        send(x.socket, { t: 'emit', peer: 'server', topic: 'chat', data: { n: 'Notice', t: r.msg } });   // formato de chat: aparece para todos, ate em clientes antigos (sem balao: 'server' nao e jogador)
      });
    }
    else if (m.t === 'emit' && m.topic === 'chat') {   // chat: só passa pelo filtro do servidor; o que sai é reconstruído como { n, t }
      const r = chat.check(m.data);
      send(socket, { t: 'chatack', ok: !!r.ok });   // o cliente usa isto para pintar de vermelho a mensagem barrada
      if (r.note) send(socket, { t: 'notice', msg: r.note });
      if (r.ok) {
        if (typeof me.pres.n === 'string' && me.pres.n) r.data.n = me.pres.n;   // o nome no chat e sempre o da presença (ja limpo): ninguém fala como outro nome, e o silenciar dos clientes pega
        others({ t: 'emit', peer: id, topic: 'chat', data: r.data });
      }
    }
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

if (require.main === module) server.listen(PORT, () => console.log("Luna's Life rodando em http://localhost:" + PORT));
module.exports = { server, runCommand };
