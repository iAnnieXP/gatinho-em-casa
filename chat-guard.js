'use strict';
// Segurança do chat do Luna's Life. Roda SÓ no servidor (filtro no cliente é fácil de contornar).
//
//   const guard = createChatGuard();           // um por conexão (guarda limite de velocidade e histórico)
//   const r = guard.check(data);               // data = { n: nome, t: texto } vindo do cliente
//     r.ok   -> pode repassar r.data ({ n, t } já limpos); r.note (opcional) é um aviso para quem enviou
//     !r.ok  -> descartar; r.note (opcional) é o motivo para mostrar a quem enviou
//   guard.name(str)                            // limpa um nome (usado também no nome da presença)
//
// Pipeline de check(): limite de velocidade -> formato -> limpeza (controle/invisível/16/50)
//   -> MAIÚSCULAS e letras repetidas -> links/e-mails/telefones -> palavrões -> anti-repetição.

const CONFIG = {
  rate: { burst: 3, everyMs: 1500, noteEveryMs: 3000 },  // rajada de 3, depois 1 mensagem a cada 1,5 s
  maxText: 50,           // caracteres do texto
  maxName: 16,           // caracteres do nome
  defaultName: 'Kitten',
  maxRun: 3,             // o mesmo caractere/emoji mais de 3 vezes seguidas vira 3 ("oooooi" -> "oooi")
  caps: { minLetters: 6, ratio: 0.7 },   // texto quase todo em MAIÚSCULAS vira minúsculo
  repeat: { windowMs: 20000, remember: 5 },  // mesma mensagem dentro de 20 s é bloqueada
  words: 'mask',         // palavrões: 'mask' (troca por ***) ou 'block' (descarta a mensagem)
  contacts: 'block',     // links, e-mails, telefones, redes sociais: 'mask' ou 'block'
  phoneMinDigits: 8,     // a partir de quantos dígitos seguidos (com separadores) vira telefone
  mask: '***',
};

const NOTES = {
  rate: "Slow down! You're sending messages too fast.",
  words: 'Message not sent: please watch your language.',
  contacts: "Message not sent: links, e-mails, phone numbers and other contacts aren't allowed.",
  repeat: "Message not sent: please don't repeat the same message.",
  masked: 'Part of your message was hidden (blocked words or contact info).',
};

/* ---------- listas ---------- */
// Palavras INTEIRAS (minúsculas, sem acento). Cada letra aceita repetição ("puuuta"); letra dobrada na palavra
// exige pelo menos 2 ("ass" não pega "as"). Plural simples (s/es) é aceito. Frases usam espaço.
const WORDS = [
  // português
  'puta', 'puto', 'putinha', 'putaria', 'merda', 'merdinha', 'bosta', 'porra', 'foda', 'foder', 'fuder', 'fode', 'fodeu', 'fudeu',
  'fodase', 'fodido', 'fodida', 'fudido', 'fdp', 'pqp', 'vsf', 'vtnc', 'vtmnc', 'tnc', 'cu', 'cuzao', 'bucetao', 'xoxota', 'xota',
  'piroca', 'siririca', 'boquete', 'tesao', 'viado', 'viadinho', 'bicha', 'sapatao', 'boiola', 'otario', 'otaria', 'idiota',
  'imbecil', 'babaca', 'escroto', 'escrota', 'retardado', 'retardada', 'mongoloide', 'arrombado', 'arrombada', 'vagabundo',
  'vagabunda', 'vadia', 'prostituta', 'crioulo', 'sexo', 'pornografia', 'porno', 'nudes', 'transar', 'estupro', 'estuprar',
  'estuprador', 'pedofilo', 'pedofila', 'pedofilia', 'nazista', 'se mata', 'vai se matar',
  // inglês
  'fucking', 'fucker', 'motherfucker', 'shit', 'shitty', 'bullshit', 'bitch', 'bitches', 'asshole', 'ass', 'dumbass', 'bastard', 'whore',
  'slut', 'cunt', 'dick', 'dickhead', 'cock', 'pussy', 'penis', 'vagina', 'boobs', 'blowjob', 'handjob', 'porn', 'sex', 'nude',
  'nigger', 'nigga', 'faggot', 'fag', 'tranny', 'retard', 'retarded', 'rape', 'rapist', 'pedophile', 'pedophilia', 'nazi', 'hitler',
  'kys', 'kill yourself',
];
// Trechos fortes: procurados mesmo grudados ou com espaços/símbolos no meio ("c a r a l h o", "filhodaputa").
// Só entram termos que não aparecem dentro de palavras normais.
const STRONG = ['caralho', 'buceta', 'fuck', 'punheta', 'filhodaputa', 'filhadaputa', 'putaquepariu', 'vaisefoder', 'vaisefuder',
  'tomanocu', 'tomarnocu', 'vaitomarnocu', 'arrombad'];
// Contatos fora do jogo (palavra inteira): redes sociais e provedores de e-mail.
const SOCIAL = ['discord', 'whatsapp', 'whats', 'wpp', 'zap', 'zapzap', 'telegram', 'snapchat', 'instagram', 'insta', 'tiktok', 'kik',
  'skype', 'gmail', 'hotmail', 'outlook', 'yahoo', 'icloud', 'arroba'];
const TLDS = 'com|net|org|br|io|gg|xyz|info|link|app|dev|site|online|shop|store|click|top|club|live|fun|biz|ws|cc';
const DIGIT_WORDS = new Set(['zero', 'um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'meia', 'sete', 'oito', 'nove',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '+': 't' };
const HOMO = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'ј': 'j', 'ԁ': 'd', 'ɡ': 'g',
  'ο': 'o', 'α': 'a', 'ν': 'v', 'ρ': 'p', 'ι': 'i', 'κ': 'k', 'τ': 't', 'υ': 'u', 'ϲ': 'c', 'ѵ': 'v', 'ß': 'ss', 'ı': 'i' };
const RESERVED_NAMES = new Set(['notice', 'you', 'system', 'server', 'admin', 'moderator', 'mod']);

/* ---------- regex ---------- */
function wordPattern(w) {   // "porra" -> p+o+r{2,}a+
  let out = '', i = 0;
  while (i < w.length) {
    let j = i; while (j < w.length && w[j] === w[i]) j++;
    out += w[i] + (j - i > 1 ? '{' + (j - i) + ',}' : '+'); i = j;
  }
  return out;
}
const phrasePattern = p => p.split(' ').map(wordPattern).join('\\s+');
const ALTS = WORDS.map(phrasePattern).join('|');
const B1 = '(?<![\\p{L}\\p{N}])', B2 = '(?![\\p{L}\\p{N}])';
const WORD_G = new RegExp(B1 + '(?:' + ALTS + ')(?:s|es)?' + B2, 'gu');
const WORD_FULL = new RegExp('^(?:' + ALTS + ')(?:s|es)?$', 'u');
const STRONG_G = new RegExp(STRONG.map(wordPattern).join('|'), 'g');
const SOCIAL_G = new RegExp(B1 + '(?:' + SOCIAL.map(wordPattern).join('|') + ')' + B2, 'gu');
const CONTACT_RES = [
  /(?:(?:https?|ftp|wss?)\s?:\s?\/\s?\/|www\s?\.)\S*/gu,                                   // http://..., www....
  new RegExp('(?<![\\p{L}\\p{N}@.-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9-]+)*(?:\\s?\\.|\\s?[(\\[{]dot[)\\]}]\\s?|\\sdot\\s)(?:' + TLDS + ')(?![\\p{L}\\p{N}])(?:[/?#:]\\S*)?', 'gu'),  // site.com, site (dot) com
  /(?<![\p{L}\p{N}])(?:t\.me|wa\.me|youtu\.be|bit\.ly|goo\.gl)(?![\p{L}\p{N}])\S*/gu,   // encurtadores/convites
  /[a-z0-9._%+-]+\s?(?:@|[(\[{]at[)\]}])\s?[a-z0-9-]+(?:\.[a-z0-9-]+)+/gu,                 // e-mail
  SOCIAL_G,
];

/* ---------- limpeza ---------- */
// Invisíveis: controle, surrogates soltos, uso privado, formato (menos ZWJ, tratado à parte), caracteres "em branco", seletores de variação (menos FE0F).
const STRIP = /[\p{Cc}\p{Cs}\p{Co}­͏ᅟᅠ឴឵᠋-᠏⠀ㅤ︀-︎ﾠ￹-￼\u{E0100}-\u{E01EF}]|(?!‍)\p{Cf}/gu;
const ZWJ_BAD = /(?<![\p{Extended_Pictographic}️])‍|‍(?!\p{Extended_Pictographic})/gu;   // ZWJ só entre emojis

function cut(s, max) { const a = Array.from(s); return a.length > max ? a.slice(0, max).join('') : s; }

function clean(raw, max, cfg) {
  let s = String(raw).slice(0, 1024);
  s = s.replace(/[\p{Z}\t\n\r\u000b\u000c\u0085]/gu, ' ').replace(STRIP, '').normalize('NFC');
  s = s.replace(ZWJ_BAD, '').replace(/(\p{M}{2})\p{M}+/gu, '$1');          // texto "zalgo": no máx. 2 acentos empilhados
  s = s.replace(/ +/g, ' ').trim();
  if (cfg.maxRun) s = s.replace(new RegExp('(\\P{M}\\p{M}*)\\1{' + cfg.maxRun + ',}', 'gu'), (m, c) => c.repeat(cfg.maxRun));
  return cut(s, max).replace(/‍$/, '').trim();
}

/* ---------- normalização com mapa de volta ao texto original ---------- */
function fold(text) {   // minúsculas, sem acento, homóglifos -> latino; at[i]/end[i] = posição do caractere original
  let f = '', at = [], end = [], i = 0;
  for (const ch of text) {
    let c = ch.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '');
    c = c.replace(/[^\x00-\x7f]/gu, x => (HOMO[x] !== undefined ? HOMO[x] : x));
    for (let k = 0; k < c.length; k++) { f += c[k]; at.push(i); end.push(i + ch.length); }
    i += ch.length;
  }
  return { f, at, end };
}
function unitsPlain(F) {   // símbolos viram separadores
  const out = [], re = /[\p{L}\p{N}]+/gu; let m;
  while ((m = re.exec(F.f))) out.push({ t: m[0], s: F.at[m.index], e: F.end[m.index + m[0].length - 1] });
  return out;
}
function unitsLeet(F) {   // "p0rr4", "$hit": troca números/símbolos por letras, mas só em pedaços que já têm letra (assim "455" continua número)
  const out = [], re = /[\p{L}\p{N}@$!+]+/gu; let m;
  while ((m = re.exec(F.f))) {
    let t = m[0], a = m.index, b = a + t.length;
    while (t && (t[0] === '!' || t[0] === '+')) { t = t.slice(1); a++; }          // ! e + nas pontas são pontuação ("puta!")
    while (t && (t[t.length - 1] === '!' || t[t.length - 1] === '+')) { t = t.slice(0, -1); b--; }
    if (!t || !/\p{L}/u.test(t)) continue;
    out.push({ t: t.replace(/[013457@$!+]/g, c => LEET[c]), s: F.at[a], e: F.end[b - 1] });
  }
  return out;
}

/* ---------- detectores (devolvem trechos [início, fim) no texto limpo) ---------- */
function findWords(units) {
  const spans = [];
  if (!units.length) return spans;
  let J = '', offs = [], m;
  units.forEach(u => { if (J) J += ' '; offs.push(J.length); J += u.t; });
  // 1) palavras inteiras e frases
  WORD_G.lastIndex = 0;
  while ((m = WORD_G.exec(J))) {
    const a = m.index, b = a + m[0].length; let i0 = 0, i1 = 0;
    offs.forEach((o, i) => { if (o <= a) i0 = i; if (o < b) i1 = i; });
    spans.push([units[i0].s, units[i1].e]);
  }
  // 2) letras/sílabas soltas ("p u t a", "pu ta"): só junta pedaços de até 2 caracteres (não junta palavras reais como "put a" ou "pen is")
  for (let i = 0; i < units.length; i++) {
    let cat = '';
    for (let j = i; j < units.length && units[j].t.length <= 2 && cat.length < 16; j++) {
      cat += units[j].t;
      if (j > i && cat.length >= 3 && WORD_FULL.test(cat)) spans.push([units[i].s, units[j].e]);
    }
  }
  // 3) termos fortes, mesmo grudados ou espalhados
  let S = '', idx = [];
  units.forEach((u, i) => { for (const ch of u.t) if (ch >= 'a' && ch <= 'z') { S += ch; idx.push(i); } });
  STRONG_G.lastIndex = 0;
  while ((m = STRONG_G.exec(S))) spans.push([units[idx[m.index]].s, units[idx[m.index + m[0].length - 1]].e]);
  return spans;
}

function findContacts(F, cfg) {
  const spans = [], f = F.f; let m;
  CONTACT_RES.forEach(re => {
    re.lastIndex = 0;
    while ((m = re.exec(f))) { if (!m[0]) { re.lastIndex++; continue; } spans.push([F.at[m.index], F.end[m.index + m[0].length - 1]]); }
  });
  // telefone: 8+ dígitos seguidos, com separadores simples e/ou números por extenso ("nove nove um...")
  const toks = [], re = /[\p{L}\p{N}]+/gu; let cur = null;
  while ((m = re.exec(f))) toks.push({ t: m[0], a: m.index, b: m.index + m[0].length });
  const groups = [];
  toks.forEach(k => {
    const n = /^\p{Nd}+$/u.test(k.t) ? k.t.length : (DIGIT_WORDS.has(k.t) ? 1 : 0);
    if (!n) { cur = null; return; }
    if (cur && k.a - cur.b <= 3) { cur.n += n; cur.b = k.b; } else { cur = { a: k.a, b: k.b, n }; groups.push(cur); }
  });
  groups.forEach(g => { if (g.n >= cfg.phoneMinDigits) spans.push([F.at[g.a], F.end[g.b - 1]]); });
  return spans;
}

function maskSpans(text, spans, mask) {
  const L = spans.slice().sort((x, y) => x[0] - y[0]), merged = [];
  L.forEach(s => { const p = merged[merged.length - 1]; if (p && s[0] <= p[1]) p[1] = Math.max(p[1], s[1]); else merged.push([s[0], s[1]]); });
  let out = '', pos = 0;
  merged.forEach(s => { out += text.slice(pos, s[0]) + mask; pos = s[1]; });
  return out + text.slice(pos);
}

function inspect(text, cfg) {
  const F = fold(text);
  const words = findWords(unitsPlain(F)).concat(findWords(unitsLeet(F)));
  const contacts = findContacts(F, cfg);
  return { words, contacts };
}

function shoutFix(s, cfg) {
  const letters = s.match(/\p{L}/gu) || [], upper = s.match(/\p{Lu}/gu) || [];
  return letters.length >= cfg.caps.minLetters && upper.length / letters.length >= cfg.caps.ratio ? s.toLowerCase() : s;
}
function repeatKey(s) {   // "Oiiii!!" e "oi" são a mesma mensagem
  const k = fold(s).f.replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
  return k || s;
}

/* ---------- API ---------- */
function createChatGuard(overrides) {
  const cfg = Object.assign({}, CONFIG, overrides || {});
  cfg.rate = Object.assign({}, CONFIG.rate, (overrides || {}).rate);
  cfg.repeat = Object.assign({}, CONFIG.repeat, (overrides || {}).repeat);
  let tokens = cfg.rate.burst, lastRefill = null, lastRateNote = -1e12, recent = [];
  const nameCache = { raw: null, out: null };

  function name(raw) {
    if (nameCache.raw === raw) return nameCache.out;
    let n = clean(raw, cfg.maxName, cfg);
    if (n) { const r = inspect(n, cfg); if (r.words.length || r.contacts.length) n = ''; }
    if (!n || RESERVED_NAMES.has(n.toLowerCase())) n = cfg.defaultName;
    nameCache.raw = raw; nameCache.out = n;
    return n;
  }

  function check(data, now) {
    now = now === undefined ? Date.now() : now;
    // 1) limite de velocidade (balde de fichas): conta toda tentativa, mesmo as que depois forem recusadas
    if (lastRefill === null) lastRefill = now;
    tokens = Math.min(cfg.rate.burst, tokens + (now - lastRefill) / cfg.rate.everyMs); lastRefill = now;
    if (tokens < 1) {
      const note = now - lastRateNote >= cfg.rate.noteEveryMs ? NOTES.rate : undefined;
      if (note) lastRateNote = now;
      return { ok: false, note };
    }
    tokens -= 1;
    // 2) formato esperado: { n: string, t: string } (qualquer outra coisa é descartada em silêncio)
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.t !== 'string' || typeof data.n !== 'string') return { ok: false };
    // 3) limpeza
    let t = clean(data.t, cfg.maxText, cfg);
    if (!t) return { ok: false };
    t = shoutFix(t, cfg);
    // 4) links/e-mails/telefones e palavrões
    const r = inspect(t, cfg), spans = [];
    if (r.contacts.length) { if (cfg.contacts === 'block') return { ok: false, note: NOTES.contacts }; spans.push.apply(spans, r.contacts); }
    if (r.words.length) { if (cfg.words === 'block') return { ok: false, note: NOTES.words }; spans.push.apply(spans, r.words); }
    let masked = false;
    if (spans.length) {
      t = cut(maskSpans(t, spans, cfg.mask), cfg.maxText); masked = true;
      if (!t.replace(/[*\s]/g, '')) return { ok: false, note: NOTES.words };
    }
    // 5) anti-repetição: mesma mensagem dentro da janela
    const key = repeatKey(t);
    recent = recent.filter(x => now - x.t < cfg.repeat.windowMs);
    if (recent.some(x => x.k === key)) return { ok: false, note: NOTES.repeat };
    recent.push({ k: key, t: now }); if (recent.length > cfg.repeat.remember) recent.shift();
    return { ok: true, data: { n: name(data.n), t }, note: masked ? NOTES.masked : undefined };
  }

  return { check, name };
}

module.exports = { createChatGuard, CONFIG };
