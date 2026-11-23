/* Atualizador automático do Luna's Life.
   Baixa a pasta public/ (o jogo em si) do servidor e guarda numa pasta do usuário; o main.js passa a abrir essa
   versão nova em vez da que veio dentro do .exe. Por isso NÃO precisa gerar/mandar .exe novo a cada atualização.
   (Só main.js, preload.js, server.js embutido e config.json exigem .exe novo: eles ficam dentro do .exe.)
   Segurança: só HTTPS (ou localhost), cada arquivo é conferido pelo hash SHA-256 do manifesto, nomes de arquivo
   são validados (sem sair da pasta) e a pasta nova só vale depois de TUDO baixado e conferido. */
const { app, net } = require('electron');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const VER = /^\d+(\.\d+){0,3}$/;                       // 1.2 / 1.2.3
const NAME = /^[A-Za-z0-9_\-][A-Za-z0-9_.\-\/]*$/;     // nomes simples, sem espaço
const MAX_FILE = 60 * 1024 * 1024;
const root = () => path.join(app.getPath('userData'), 'updates');
const curFile = () => path.join(root(), 'current.json');
const rm = p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function cmp(a, b) {                                   // compara versões: 1 se a > b, -1 se a < b, 0 se iguais
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

/* Qual pasta o jogo deve abrir: a atualização baixada (se for mais nova que o .exe) ou a que veio no .exe. */
function resolveActive(bundledDir) {
  const bundled = { dir: bundledDir, version: app.getVersion(), updated: false };
  try {
    const cur = JSON.parse(fs.readFileSync(curFile(), 'utf8'));
    if (!VER.test(cur.version) || cmp(cur.version, bundled.version) <= 0) return bundled;   // .exe novo já é mais novo que o cache
    const dir = path.join(root(), cur.version);
    if (fs.existsSync(path.join(dir, 'index.html'))) return { dir, version: cur.version, updated: true };
  } catch (e) {}
  return bundled;
}

/* Endereço do servidor de atualizações: config.json "atualizacoes", ou o próprio "servidor". Só HTTPS (localhost liberado p/ teste). */
function baseUrl(cfg) {
  let s = String((cfg && (cfg.atualizacoes || cfg.servidor)) || '').trim(); if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(s) ? 'http://' : 'https://') + s;   /* sem esquema: https (http só para localhost, p/ teste) */
  let u; try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return null;
  return u.origin + (u.pathname.endsWith('/') ? u.pathname : u.pathname + '/');
}

async function get(url, ms) {
  const r = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' em ' + url);
  return Buffer.from(await r.arrayBuffer());
}

/* A atualização está ligada? (precisa de um servidor https configurado em config.json) */
function enabled(cfg) { return !!baseUrl(cfg); }

/* Acorda o servidor (o Render gratuito dorme sem uso e demora até ~1 min para acordar): manda uma requisição HEAD
   (sem corpo, não baixa o jogo) assim que o programa abre, para o servidor já estar de pé quando o jogador for entrar.
   Não mostra nada e ignora qualquer erro. Acorda tanto o "servidor" (multiplayer) quanto o "atualizacoes", se forem diferentes. */
function wake(cfg) {
  const bases = new Set();
  [cfg && cfg.servidor, cfg && cfg.atualizacoes].forEach(x => { const b = x && baseUrl({ servidor: x }); if (b) bases.add(b); });
  if (!bases.size) return Promise.resolve(null);   /* nada configurado: nada para acordar */
  /* devolve uma promessa: true = servidor respondeu, false = não respondeu (erro ou passou de 2 min), null = sem servidor configurado */
  return Promise.all([...bases].map(b => {
    try { return net.fetch(b, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(120000) }).then(() => true, () => false); } catch (e) { return Promise.resolve(false); }
  })).then(r => r.every(Boolean));
}

/* Verifica o servidor; se houver versão MAIOR que currentVersion, baixa tudo e deixa pronta.
   Retorna { version } (baixou), { upToDate: true } (já está na mais nova) ou null (atualização desligada).
   on(evento) é opcional e avisa o andamento: { type: 'found', version } e { type: 'progress', version, done, total }. */
async function check(cfg, currentVersion, on) {
  const emit = ev => { try { if (on) on(ev); } catch (e) {} };
  const base = baseUrl(cfg); if (!base) return null;
  const m = JSON.parse((await get(base + 'update/manifest.json', 90000)).toString('utf8'));   // 90 s: o Render gratuito demora a acordar
  if (!m || !VER.test(m.version) || !Array.isArray(m.files) || !m.files.length || m.files.length > 200) throw new Error('manifesto invalido');
  if (cmp(m.version, currentVersion) <= 0) return { upToDate: true };
  emit({ type: 'found', version: m.version });
  if (!m.files.some(f => f && f.name === 'index.html')) throw new Error('manifesto sem index.html');

  fs.mkdirSync(root(), { recursive: true });
  const finalDir = path.join(root(), m.version), tmp = path.join(root(), '.tmp-' + m.version);
  if (!fs.existsSync(path.join(finalDir, 'index.html'))) {
    rm(tmp); fs.mkdirSync(tmp, { recursive: true });
    try {
      for (const [i, f] of m.files.entries()) {
        if (!f || !NAME.test(f.name) || f.name.includes('..') || f.name.includes('//') || f.name.endsWith('/') || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error('arquivo invalido no manifesto');
        const dest = path.join(tmp, f.name); if (!dest.startsWith(tmp + path.sep)) throw new Error('caminho invalido');
        const buf = await get(base + f.name.split('/').map(encodeURIComponent).join('/'), 180000);
        if (buf.length > MAX_FILE || sha(buf) !== f.sha256) throw new Error('arquivo corrompido: ' + f.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf);
        emit({ type: 'progress', version: m.version, done: i + 1, total: m.files.length });
      }
      rm(finalDir); fs.renameSync(tmp, finalDir);      // só vira "oficial" depois de tudo conferido
    } catch (e) { rm(tmp); throw e; }
  }
  const ptr = curFile() + '.new';
  fs.writeFileSync(ptr, JSON.stringify({ version: m.version })); fs.renameSync(ptr, curFile());
  prune(m.version);
  return { version: m.version };
}

/* Apaga versões antigas baixadas (mantém só a atual). */
function prune(keep) {
  try { fs.readdirSync(root()).forEach(n => { if (n !== keep && n !== 'current.json') rm(path.join(root(), n)); }); } catch (e) {}
}

/* Se a versão baixada não abrir, esquece ela e volta para a do .exe. */
function reset() { rm(root()); }

module.exports = { resolveActive, check, enabled, wake, reset, cmp };
