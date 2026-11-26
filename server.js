// Servidor do Luna's Life: serve o jogo e repassa mensagens entre jogadores da mesma sala (WebSocket, sem dependências).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { createChatGuard } = require('./chat-guard.js');   // limite de velocidade, validação, filtros e anti-spam do chat
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public'), MAX = 10;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const devs = new Map(); // id do dispositivo -> { socket, bye } (um jogador por computador)
const rooms = new Map(); // sala -> Map(id -> { socket, pres }) com .skew (ms que o relógio da sala adiantou dormindo)
// Registro de jogadores no Discord: a cada conexão, manda nick + sala + hora para um canal via webhook (sem IP).
// A URL vem SÓ da variável de ambiente DISCORD_WEBHOOK (nunca no código/config.json, pois o .exe embute este arquivo). Sem ela, não faz nada.
const https = require('https');
const WEBHOOK = process.env.DISCORD_WEBHOOK || '', hookQueue = []; let hookBusy = false;
function hookPump() {   // 1 mensagem a cada 1,5 s (limite do Discord); fila de no máx. 100 para não acumular
  if (hookBusy || !hookQueue.length) return; hookBusy = true;
  let u; try { u = new URL(WEBHOOK); } catch (e) { hookQueue.length = 0; hookBusy = false; return; }
  const body = JSON.stringify(hookQueue.shift());
  const lib = u.protocol === 'http:' ? http : https;   // http só serve para testar com um servidor local; o Discord é sempre https
  const rq = lib.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, r => {
    r.resume(); r.on('end', () => { const wait = r.statusCode === 429 ? Number(r.headers['retry-after'] || 2) * 1000 : 1500; setTimeout(() => { hookBusy = false; hookPump(); }, wait); });
  });
  rq.on('error', () => setTimeout(() => { hookBusy = false; hookPump(); }, 3000)); rq.setTimeout(8000, () => rq.destroy()); rq.end(body);
}
function logJoin(nick, room, online) {
  if (!WEBHOOK || hookQueue.length >= 100) return;
  const safe = String(nick).replace(/[`\\]/g, '').slice(0, 40) || '(sem nome)';   // sem crases/barras: não quebra a formatação nem faz @menção
  hookQueue.push({ content: '\u{1F431} **' + safe.replace(/[*_~|>@#]/g, '') + '** entrou na sala `' + room + '` (' + online + ' online) \u2014 <t:' + Math.floor(Date.now() / 1000) + ':f>', allowed_mentions: { parse: [] } });
  hookPump();
}

// DENÚNCIAS. Toda mensagem entregue (chat ou privada) sai do servidor com uma assinatura (sg = HMAC-SHA256 de tipo, sala/destinatário, remetente, hora e texto).
// O cliente guarda a assinatura e a devolve ao denunciar; assim o servidor sabe que o texto é mesmo o que ele entregou (ninguém inventa denúncia contra outro jogador)
// e não precisa guardar histórico (funciona mesmo depois de reiniciar). A chave deriva da URL do webhook, que já é secreta; sem webhook não há denúncia.
const REPORT_KEY = crypto.createHash('sha256').update('luna-report|' + (process.env.REPORT_SECRET || WEBHOOK)).digest();
const REPORT_MAX_AGE = 31 * 24 * 3600 * 1000, REPORT_QUEUE = 150;   // denúncias valem por 31 dias (a fila de mensagens privadas guarda 30)
const reportedSigs = new Map();   // assinatura -> hora: a mesma mensagem não vai duas vezes ao Discord
function signMsg(kind, where, from, ts, text) {   // where = sala (chat) ou nome do destinatário em minúsculas (privada)
  return crypto.createHmac('sha256', REPORT_KEY).update([kind, where, from, ts, text].join('\u0001')).digest('hex');
}
function validSig(kind, where, from, ts, text, sg) {
  if (typeof sg !== 'string' || !/^[0-9a-f]{64}$/.test(sg)) return false;
  return crypto.timingSafeEqual(Buffer.from(signMsg(kind, where, from, ts, text)), Buffer.from(sg));
}
const dc = s => String(s).replace(/[`\\*_~|>@#]/g, '').slice(0, 60) || '(sem nome)';   // texto que vai ao Discord: sem formatação nem @menção
function sendReport(r) {   // r = { kind, room, from, reporter, text, ts, why }; devolve false se não deu para enfileirar
  if (!WEBHOOK || hookQueue.length >= REPORT_QUEUE) return false;
  const priv = r.kind === 'dm';
  hookQueue.push({
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '\u{1F6A9} Denúncia: ' + (priv ? 'mensagem privada' : 'chat público'), color: 0xe74c3c,
      fields: [
        { name: 'Denunciado', value: dc(r.from), inline: true }, { name: 'Quem denunciou', value: dc(r.reporter), inline: true },
        { name: priv ? 'Conversa' : 'Sala', value: priv ? 'privada' : '`' + String(r.room).replace(/[^a-z0-9_.-]/g, '').slice(0, 48) + '`', inline: true },
        { name: 'Mensagem', value: '```\n' + String(r.text).replace(/`/g, "'").slice(0, 200) + '\n```' },
        ...(r.why ? [{ name: 'Motivo da denúncia', value: '```\n' + String(r.why).replace(/`/g, "'").slice(0, 200) + '\n```' }] : []),
        { name: 'Enviada', value: '<t:' + Math.floor(r.ts / 1000) + ':f>' },
      ],
      footer: { text: 'Nomes não têm conta: quem denuncia e quem é denunciado são os nomes que cada um digitou.' },
    }],
  });
  hookPump(); return true;
}

// Mensagens privadas para quem está offline: ficam numa fila por nome (máx. 25 por destinatário, 30 dias) e são entregues quando o jogador entra com esse nome.
// Guardadas também num arquivo (dm-queue.json) para sobreviver a reinícios; se o disco não for gravável, fica só na memória.
const DM_FILE = process.env.DM_FILE || path.join(__dirname, 'dm-queue.json'), DM_MAX = 25, DM_TTL = 30 * 24 * 3600 * 1000, DM_PEOPLE = 5000;
const dmPending = new Map(); let dmSaveT = null;
try { const o = JSON.parse(fs.readFileSync(DM_FILE, 'utf8')), now0 = Date.now(); Object.keys(o).forEach(k => { const a = (Array.isArray(o[k]) ? o[k] : []).filter(r => r && typeof r.from === 'string' && typeof r.text === 'string' && now0 - r.ts < DM_TTL).slice(-DM_MAX); if (a.length) dmPending.set(k, a); }); } catch (e) {}
function dmSaveSoon() {
  if (dmSaveT) return;
  dmSaveT = setTimeout(() => { dmSaveT = null; try { const o = {}; dmPending.forEach((a, k) => { o[k] = a; }); fs.writeFileSync(DM_FILE, JSON.stringify(o)); } catch (e) {} }, 2000); dmSaveT.unref();
}
function dmQueue(key, rec) {
  const a = dmPending.get(key) || []; a.push(rec); while (a.length > DM_MAX) a.shift();
  dmPending.delete(key); dmPending.set(key, a);   // reinsere: o mais recente fica no fim
  if (dmPending.size > DM_PEOPLE) dmPending.delete(dmPending.keys().next().value);
  dmSaveSoon();
}

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

// Perfil do jogador (menu Profile): foto pequena (JPEG em data URL), título (número da lista do cliente), descrição, emoji e cor de fundo.
// O servidor valida tudo e passa a descrição pelo mesmo filtro do chat; o que sai daqui já é seguro para os outros clientes.
const PROF_MAX_PHOTO = 20000, PROF_MAX_DESC = 50, PROF_DEFAULT = { ph: '', t: 0, d: '', e: '\u{1F431}', bg: '#d9ccf2' };
function cleanProfile(p, guard) {
  if (!p || typeof p !== 'object') return null;
  return {
    ph: typeof p.ph === 'string' && p.ph.length <= PROF_MAX_PHOTO && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(p.ph) ? p.ph : PROF_DEFAULT.ph,
    t: Number.isInteger(p.t) && p.t >= 0 && p.t < 32 ? p.t : PROF_DEFAULT.t,
    d: guard.text(p.d, PROF_MAX_DESC),
    e: typeof p.e === 'string' && p.e.length <= 12 && /^[\p{Extended_Pictographic}\u200d\ufe0f]+$/u.test(p.e) ? p.e : PROF_DEFAULT.e,
    bg: typeof p.bg === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.bg) ? p.bg.toLowerCase() : PROF_DEFAULT.bg,
  };
}

function cleanPresence(o) {
  const out = {}; if (!o || typeof o !== 'object') return out;
  Object.keys(o).slice(0, 12).forEach(k => {
    const v = o[k]; if (!/^[a-z][a-z0-9_]{0,11}$/.test(k)) return;
    if (typeof v === 'number' && isFinite(v)) out[k] = v; else if (typeof v === 'string') out[k] = v.slice(0, 24);
  });
  return out;
}

server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x'), key = req.headers['sec-websocket-key'];
  const room = (u.searchParams.get('room') || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 48);
  if (u.pathname !== '/ws' || !key || !room) return socket.destroy();
  // Um jogador por computador: o cliente manda um ID de dispositivo (dev). Se o mesmo ID entrar de novo, a conexão ANTIGA é derrubada.
  // Tem de acontecer antes de pegar/criar a sala: a saída da conexão antiga pode apagar a sala se ela ficar vazia.
  const dev = (u.searchParams.get('dev') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32), devEntry = { socket, bye: null };
  if (dev.length >= 8) {
    const old = devs.get(dev);
    if (old && !old.socket.destroyed) { try { if (old.bye) old.bye(); sendTo(old.socket, { t: 'kicked' }); } catch (e) {} const os = old.socket; setTimeout(() => os.destroy(), 300); }
    devs.set(dev, devEntry);
  }
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

  let logged = false;   // registra a entrada uma vez por conexão (no 1º nick, ou depois de 5 s sem nick)
  const logOnce = n => { if (logged) return; logged = true; logJoin(n, room, members.size); };
  setTimeout(() => logOnce(''), 5000).unref();
  const chat = createChatGuard();   // estado do chat desta conexão (limite de velocidade, últimas mensagens)
  let tokens = 80, last = Date.now(), lastCmd = 0, profTok = 4, profLast = Date.now(), reqTok = 8, reqLast = Date.now(), repTok = 3, repLast = Date.now();   // profTok: balde do envio de perfil (rajada de 4, depois 1 a cada 1,5 s); reqTok: balde dos pedidos de perfil
  function onMsg(txt) {
    const now = Date.now(); tokens = Math.min(80, tokens + (now - last) * 0.06); last = now;
    if (tokens < 1) return; tokens--;
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.t === 'pres') { const patch = cleanPresence(m.patch); if (typeof patch.n === 'string') patch.n = chat.name(patch.n); Object.assign(me.pres, patch); if (patch.n) { logOnce(patch.n); const dk = patch.n.toLowerCase(); if (me.dmKey !== dk) { me.dmKey = dk; const q = dmPending.get(dk); if (q) { dmPending.delete(dk); dmSaveSoon(); q.forEach(x => send(socket, { t: 'dm', from: x.from, text: x.text, ts: x.ts, sg: x.sg, late: 1 })); } } } others({ t: 'pres', peer: id, patch }); }
    else if (m.t === 'find') {   // seguir amigo: procura um jogador pelo nome em TODAS as salas e devolve em qual ele está (here = a sua própria sala)
      const q = typeof m.name === 'string' ? chat.name(m.name).toLowerCase() : '';
      let hit = null;   // ho = escondeu o status online (aparece como offline); nf = não deixa ser seguido
      if (q) rooms.forEach((mem, rn) => { if (hit && hit.here) return; mem.forEach((x, k) => { if (k !== id && typeof x.pres.n === 'string' && x.pres.n.toLowerCase() === q && x.pres.ho !== 1 && !(hit && hit.here)) hit = { room: rn, here: mem === members, full: mem.size >= MAX, n: x.pres.n, nf: x.pres.nf === 1 }; }); });
      send(socket, hit && hit.nf && !hit.here ? { t: 'found', ok: true, blocked: true, q: m.q } : hit ? { t: 'found', ok: true, q: m.q, room: hit.room, here: hit.here, full: hit.full, n: hit.n } : { t: 'found', ok: false, q: m.q });
    }
    else if (m.t === 'dm') {   // mensagem privada por nome, em QUALQUER sala; mesmo filtro/limite do chat. Destinatário offline: vai para a fila e chega quando ele entrar.
      const reply = (ok, why, note, t, queued) => send(socket, { t: 'dmack', q: m.q, ok, why, note, tx: t, queued: !!queued });
      const to = typeof m.to === 'string' ? chat.name(m.to).toLowerCase() : '', from = typeof me.pres.n === 'string' ? me.pres.n : '';
      if (!from || !to || to === from.toLowerCase()) return reply(false, 'blocked');
      const r = chat.check({ n: from, t: m.text });
      if (!r.ok) return reply(false, 'blocked', r.note);
      let tgt = null; rooms.forEach(mem => mem.forEach((x, k) => { if (k !== id && typeof x.pres.n === 'string' && x.pres.n.toLowerCase() === to && (!tgt || mem === members)) tgt = x; }));
      const rec = { from, text: r.data.t, ts: Date.now() }; rec.sg = signMsg('dm', to, rec.from, rec.ts, rec.text);   // assinada para o destinatário (to já está em minúsculas)
      if (tgt) { send(tgt.socket, { t: 'dm', from: rec.from, text: rec.text, ts: rec.ts, sg: rec.sg }); reply(true, '', r.note, rec.text, tgt.pres.ho === 1); }   // quem escondeu o status recebe na hora, mas o remetente vê o mesmo aviso de "fila" (não revela que está online)
      else { dmQueue(to, rec); reply(true, '', r.note, rec.text, true); }
    }
    else if (m.t === 'who') {   // lista de amigos: quais destes nomes estão online em QUALQUER sala (quem escondeu o status online não aparece)
      const want = new Set((Array.isArray(m.names) ? m.names : []).slice(0, 60).filter(n => typeof n === 'string').map(n => chat.name(n).toLowerCase())), on = [];
      rooms.forEach(mem => mem.forEach((x, k) => { const n = typeof x.pres.n === 'string' ? x.pres.n.toLowerCase() : ''; if (k !== id && n && x.pres.ho !== 1 && want.has(n) && !on.includes(n)) on.push(n); }));
      send(socket, { t: 'whoR', q: m.q, on });
    }
    else if (m.t === 'report') {   // denunciar uma mensagem recebida (chat ou privada): confere a assinatura e manda ao Discord
      const reply = (ok, why) => send(socket, { t: 'reportack', q: m.q, ok, why });
      repTok = Math.min(3, repTok + (now - repLast) / 20000); repLast = now;   // rajada de 3, depois 1 a cada 20 s (impede inundar o Discord)
      if (repTok < 1) return reply(false, 'slow');
      repTok--;   // toda tentativa gasta ficha (válida ou não): ninguém fica testando assinaturas nem inundando
      const me_n = typeof me.pres.n === 'string' ? me.pres.n : '';
      const kind = m.k === 'dm' ? 'dm' : m.k === 'chat' ? 'chat' : '';
      const from = typeof m.from === 'string' ? m.from : '', text = typeof m.text === 'string' ? m.text : '', ts = m.ts;
      if (!kind || !me_n || !from || !text || from.length > 40 || text.length > 200 || !Number.isFinite(ts) || ts > now + 60000 || now - ts > REPORT_MAX_AGE) return reply(false, 'invalid');
      const where = kind === 'dm' ? me_n.toLowerCase() : (typeof m.room === 'string' ? m.room.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 48) : '');
      if (!where || from.toLowerCase() === me_n.toLowerCase() || !validSig(kind, where, from, ts, text, m.sg)) return reply(false, 'invalid');
      const why = typeof m.why === 'string' ? m.why.replace(/\s+/g, ' ').trim().slice(0, 150) : '';   // motivo escrito por quem denuncia (clientes antigos não mandam)
      if (reportedSigs.has(m.sg)) return reply(true, 'dup');   // já denunciada: para quem denuncia, deu certo
      if (!sendReport({ kind, room: where, from, reporter: me_n, text, ts, why })) return reply(false, 'unavailable');
      reportedSigs.set(m.sg, now); if (reportedSigs.size > 2000) reportedSigs.delete(reportedSigs.keys().next().value);
      reply(true, '');
    }
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
        r.data.ts = Date.now(); r.data.sg = signMsg('chat', room, r.data.n, r.data.ts, r.data.t);   // assinatura para denúncia (ver acima)
        others({ t: 'emit', peer: id, topic: 'chat', data: r.data });
      }
    }
    else if (m.t === 'emit' && m.topic === 'profile') {   // perfil: { p: perfil } guarda e repassa (já limpo); { req: 1 } devolve os perfis de quem já está na sala; { req: 1, to: id } devolve só o de um jogador
      const d = m.data;
      if (d && d.req) {   // pedido de perfil: balde próprio (rajada de 8, depois 1 a cada 0,4 s), para abrir perfis à vontade sem travar o envio do seu
        reqTok = Math.min(8, reqTok + (now - reqLast) / 400); reqLast = now;
        if (reqTok < 1) return; reqTok--;
        const give = (o, k) => { if (k !== id && o && o.profile) send(socket, { t: 'emit', peer: k, topic: 'profile', data: { p: o.profile } }); };
        if (typeof d.to === 'string') give(members.get(d.to), d.to);   // sempre o perfil mais recente guardado no servidor
        else members.forEach(give);
        return;
      }
      profTok = Math.min(4, profTok + (now - profLast) / 1500); profLast = now;
      if (profTok < 1) return; profTok--;
      if (d && d.p) { const c = cleanProfile(d.p, chat); if (c) { me.profile = c; others({ t: 'emit', peer: id, topic: 'profile', data: { p: c } }); } }
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
      if (len > 24576 || !(buf[1] & 128)) return socket.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4), pl = Buffer.from(buf.slice(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) pl[i] ^= mask[i & 3];
      buf = buf.slice(off + 4 + len);
      if (op === 8) return socket.end();
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, pl.length]), pl])); continue; }
      if (op === 1 && fin) onMsg(pl.toString());
    }
  });
  const bye = () => { if (dev && devs.get(dev) === devEntry) devs.delete(dev); if (!members.delete(id)) return; others({ t: 'leave', peer: id }); if (!members.size) rooms.delete(room); };
  devEntry.bye = bye;
  socket.on('close', bye); socket.on('error', bye);
});

if (require.main === module) server.listen(PORT, () => console.log("Luna's Life rodando em http://localhost:" + PORT));
module.exports = { server, runCommand, cleanProfile, signMsg };
