// Contas do Luna's Life (nome + senha). Sem dependências: senha com scrypt + sal, arquivo JSON, sessões em memória.
// Contas ficam em accounts.json (ou em DATA_DIR/accounts.json). No Render gratuito o disco é apagado a cada deploy/reinício:
// para guardar as contas de verdade, use um disco persistente do Render e defina DATA_DIR para a pasta dele (ex.: /var/data).
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const NAME_RE = /^[\p{L}\p{N}]{1,10}$/u;   // igual ao nome do jogo: só letras e números, até 10
const PASS_MIN = 4, PASS_MAX = 15, SESSION_MS = 12 * 3600 * 1000;

function createAccounts(opts) {
  opts = opts || {};
  const file = opts.file || path.join(process.env.DATA_DIR || __dirname, 'accounts.json');
  const guardName = opts.guardName || (n => n);   // mesmo filtro de nomes do chat (palavrões etc.)
  let db = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object') db = j; } catch (e) { /* sem arquivo ainda */ }
  const sessions = new Map();   // token -> { key, exp }
  const tries = new Map();      // ip -> { n, t } (limite de tentativas)

  function save() {
    try { fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); } catch (e) { console.log('Nao consegui salvar as contas: ' + e.message); }
  }
  const key = name => String(name || '').toLowerCase();
  const hash = (pass, salt) => crypto.scryptSync(pass, salt, 32);
  function limited(ip) {   // no máx. 12 tentativas por minuto por IP
    const now = Date.now(); let r = tries.get(ip);
    if (!r || now - r.t > 60000) { r = { n: 0, t: now }; tries.set(ip, r); }
    if (tries.size > 5000) tries.clear();
    return ++r.n > 12;
  }
  function validName(name) { return typeof name === 'string' && NAME_RE.test(name); }
  function validPass(pass) { return typeof pass === 'string' && pass.length >= PASS_MIN && pass.length <= PASS_MAX; }
  function session(k) {
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, { key: k, exp: Date.now() + SESSION_MS });
    if (sessions.size > 5000) sessions.forEach((v, t) => { if (v.exp < Date.now()) sessions.delete(t); });
    return token;
  }

  function register(name, pass, ip) {
    if (limited(ip)) return { ok: false, error: 'slow', msg: 'Too many attempts. Wait a minute and try again.' };
    if (!validName(name)) return { ok: false, error: 'name', msg: 'Names use only letters and numbers (up to 10).' };
    if (guardName(name) !== name) return { ok: false, error: 'name', msg: 'That name is not allowed. Pick another one.' };
    if (!validPass(pass)) return { ok: false, error: 'pass', msg: 'The password must have ' + PASS_MIN + ' to ' + PASS_MAX + ' characters.' };
    const k = key(name);
    if (db[k]) return { ok: false, error: 'taken', msg: 'That name already has an account. Log in, or pick another name.' };
    const salt = crypto.randomBytes(16);
    db[k] = { name, salt: salt.toString('hex'), hash: hash(pass, salt).toString('hex'), created: Date.now() };
    save();
    return { ok: true, name, token: session(k) };
  }
  function login(name, pass, ip) {
    if (limited(ip)) return { ok: false, error: 'slow', msg: 'Too many attempts. Wait a minute and try again.' };
    const a = typeof name === 'string' ? db[key(name)] : null;
    if (!a || typeof pass !== 'string' || pass.length > PASS_MAX) {
      if (!a) hash('x', Buffer.alloc(16));   // gasta o mesmo tempo, para não revelar se o nome existe pelo tempo de resposta
      return { ok: false, error: a ? 'bad' : 'none', msg: a ? 'Wrong password.' : 'No account with that name. Use "Create account", or clear the password to play as a guest.' };
    }
    const h = hash(pass, Buffer.from(a.salt, 'hex')), want = Buffer.from(a.hash, 'hex');
    if (h.length !== want.length || !crypto.timingSafeEqual(h, want)) return { ok: false, error: 'bad', msg: 'Wrong password.' };
    return { ok: true, name: a.name, token: session(key(name)) };
  }
  const exists = name => !!db[key(name)];
  function canonical(name) { const a = db[key(name)]; return a ? a.name : null; }
  function verify(name, token) {   // o token vale para esta conta?
    const s = typeof token === 'string' ? sessions.get(token) : null;
    if (!s || s.exp < Date.now()) { if (s) sessions.delete(token); return false; }
    return s.key === key(name);
  }
  return { register, login, exists, canonical, verify, PASS_MIN, PASS_MAX };
}
module.exports = { createAccounts, NAME_RE };
