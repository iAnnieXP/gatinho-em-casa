// Testes do chat-guard. Rode com:  node test-chat-guard.js   (sem dependências)
const assert = require('assert');
const { createChatGuard } = require('./chat-guard.js');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FALHOU: ' + name + '\n   ' + e.message); } }
const send = (txt, opts, n) => createChatGuard(opts).check({ n: n || 'Luna', t: txt }, 0);
const out = (txt, opts) => { const r = send(txt, opts); return r.ok ? r.data.t : null; };

// ---- limite de velocidade ----
t('rajada de 3, depois bloqueia, depois libera 1 a cada 1,5 s', () => {
  const g = createChatGuard(); const m = i => g.check({ n: 'a', t: 'msg ' + 'abcdefghij'[i] }, 1000);
  assert(m(0).ok && m(1).ok && m(2).ok); assert(!m(3).ok);
  assert(g.check({ n: 'a', t: 'depois de esperar' }, 2600).ok);
});
t('aviso de velocidade é limitado (1 a cada 3 s)', () => {
  const g = createChatGuard(); for (let i = 0; i < 3; i++) g.check({ n: 'a', t: 'm' + 'xyz'[i] + 'q' }, 0);
  assert(g.check({ n: 'a', t: 'um' }, 10).note); assert(!g.check({ n: 'a', t: 'dois' }, 20).note);
});

// ---- validação ----
t('formato inválido é descartado', () => {
  const g = createChatGuard(), c = d => g.check(d, 0).ok;
  assert(!c(null) && !c('oi') && !c([]) && !c({ n: 'a' }) && !c({ t: 'oi' }) && !c({ n: 5, t: 'oi' }) && !c({ n: 'a', t: { x: 1 } }));
});
t('corta em 50 caracteres e nome em 16', () => {
  const r = send('ab '.repeat(100), null, 'AbCd'.repeat(10));
  assert.strictEqual(Array.from(r.data.t).length <= 50, true); assert.strictEqual(r.data.n.length, 16);
});
t('só os campos n e t saem', () => { const r = createChatGuard().check({ n: 'a', t: 'oi gente', evil: '<script>' }, 0); assert.deepStrictEqual(Object.keys(r.data), ['n', 't']); });
t('remove controle e texto invisível', () => {
  assert.strictEqual(out('o\u0000i​ ‮gen⁠te­﻿'), 'oi gente');
  assert.strictEqual(out('⠀ㅤ ​'), null);   // só invisível = vazio
  assert.strictEqual(out('linha1\nlinha2\t\tfim'), 'linha1 linha2 fim');
});
t('emojis continuam inteiros (ZWJ, FE0F)', () => {
  assert.strictEqual(out('oi 😺❤️ 👨‍👩‍👧'), 'oi 😺❤️ 👨‍👩‍👧');
  assert.strictEqual(out('a‍b'), 'ab');
});
t('texto "zalgo" é limitado', () => { assert(out('o' + '́'.repeat(30) + 'i').length <= 4); });
t('nome: reservado, palavrão, contato e vazio viram Kitten', () => {
  const g = createChatGuard(), n = x => g.name(x);
  assert.strictEqual(n('Notice'), 'Kitten'); assert.strictEqual(n('  '), 'Kitten'); assert.strictEqual(n('p0rr4'), 'Kitten'); assert.strictEqual(n('zap 11999998888'), 'Kitten');
  assert.strictEqual(n('Luna'), 'Luna');
});

// ---- palavrões: pega ----
const caught = ['porra', 'p0rr4', 'PORRA', 'puuuuuta', 'p u t a', 'p.u.t.a', 'p-u-t-a', 'pu ta', 'puta!', 'c4r4lh0', 'c a r a l h o', 'filho da puta',
  'filhodaputa', 'vai se fuder', 'vaisefoder', 'f u c k', 'fuuuck', 'fucking', 'sh1t', '$hit', 'b!tch', 'asshole', 'a$$hole', 'seu idiota', 'm3rd4',
  'vsf', 'kill yourself', 'bucetaaa', 'ｐｕｔａ', 'pυta', 'рuta' /* cirílico */, 'puta.', 'fdp', 'p0rn', 'cu'];
caught.forEach(w => t('bloqueia/mascara: ' + w, () => {
  const r = send('oi ' + w + ' tchau'); assert(r.ok && /\*\*\*/.test(r.data.t) && !/[^\x00-\x7f]/.test(r.data.t.replace(/[oitchau *]/g, '')) || /\*\*\*/.test(r.data.t), 'saiu: ' + JSON.stringify(r));
  assert(/^oi .*\*\*\*.* tchau$/.test(r.data.t), 'saiu: ' + r.data.t);
}));
// ---- palavrões: NÃO pega (falsos positivos) ----
['computador', 'disputa', 'deputado', 'reputação', 'classe', 'assim', 'as meninas', 'pica-pau', 'put a toy', 'the pen is red', 'cuidado', 'cuca',
  'bom dia', 'Scunthorpe', 'passarinho', 'shiitake', 'enviado', '455 pontos', 'peacock', 'hello', 'analysis', 'grape', 'therapist', 'class',
  'Dickens', 'cocktail', 'assistir', 'massa', 'sexta-feira', 'cuspir', 'bocó', 'pontos 1000', 'gatinho lindo', 'c u later', 'amo meu gato', 'tá bom']
  .forEach(w => t('NÃO bloqueia: ' + w, () => { const r = send(w); assert(r.ok && r.data.t === w, 'saiu: ' + JSON.stringify(r)); }));
t('modo block descarta a mensagem', () => { const r = send('vai se foder', { words: 'block' }); assert(!r.ok && r.note); });
t('só *** sobrando = descartada', () => { assert(!send('porra', { contacts: 'mask' }).ok); });

// ---- links, e-mails, telefones ----
const contacts = ['acesse www.site.com', 'http://x.y/z', 'https://exemplo.com.br/a?b=1', 'meu email é joao@gmail.com', 'joao (at) gmail.com', 'joao @ gmail . com',
  'me chama no zap', 'add no discord', 'discord.gg/abc', 'meu insta', 'bit.ly/abc', 't.me/fulano', 'oi.com', 'site (dot) com',
  '11 99999-8888', '(11) 3333-4444', '+55 11 91234 5678', '11999998888', 'nove nove nove oito sete seis cinco quatro', '9 9 9 9 8 8 8 8', 'minha-loja.shop', 'WWW.SITE.COM'];
contacts.forEach(w => t('bloqueia contato: ' + w, () => { const r = send(w); assert(!r.ok && r.note, 'saiu: ' + JSON.stringify(r)); }));
['tenho 2 gatos e 3 peixes', 'ganhei um ponto com ele', 'gosto. com você', 'versão 1.2.3', 'foto.png', 'são 10:30', 'tenho 12345 pontos', 'c@sa', 'a.m. e p.m.', 'sim.', 'um dois tres']
  .forEach(w => t('NÃO bloqueia: ' + w, () => { const r = send(w); assert(r.ok && r.data.t === w, 'saiu: ' + JSON.stringify(r)); }));
t('modo mask nos contatos', () => { assert.strictEqual(out('chama 11 99999-8888 ai', { contacts: 'mask' }), 'chama *** ai'); });

// ---- anti-repetição ----
t('MAIÚSCULAS viram minúsculas', () => { assert.strictEqual(out('OLÁ PESSOAL TUDO BEM'), 'olá pessoal tudo bem'); assert.strictEqual(out('OK'), 'OK'); assert.strictEqual(out('Oi Luna'), 'Oi Luna'); });
t('letras repetidas viram no máx. 3', () => { assert.strictEqual(out('oooooooi'), 'oooi'); assert.strictEqual(out('kkkkkkkkkkk'), 'kkk'); assert.strictEqual(out('😺😺😺😺😺😺'), '😺😺😺'); assert.strictEqual(out('aaaaaaaaaa'), 'aaa'); });
t('mensagem repetida é bloqueada por 20 s', () => {
  const g = createChatGuard(), c = (x, now) => g.check({ n: 'a', t: x }, now);
  assert(c('bom dia', 0).ok); assert(!c('bom dia', 1600).ok); assert(!c('Bom dia!!', 3200).ok); assert(!c('bomm diaaa', 4800).ok);
  assert(c('outra coisa', 6400).ok); assert(c('bom dia', 25000).ok);
});

// ---- ponta a ponta com o servidor de verdade ----
// ---- texto livre do perfil (guard.text) ----
t('perfil: descrição normal passa e corta em 50', () => {
  const g = createChatGuard(); assert.strictEqual(g.text('Gosto de peixe e de dormir ao sol!', 50), 'Gosto de peixe e de dormir ao sol!');
  assert.strictEqual(Array.from(g.text('abcdefghij '.repeat(30), 50)).length <= 50, true);
});
t('perfil: palavrão e contato viram *** (sem bloquear)', () => {
  const g = createChatGuard(); assert.strictEqual(g.text('vai pra p0rr4 agora', 100), 'vai pra *** agora');
  assert(!/discord|zap/i.test(g.text('me chama no discord ou zap', 100)));
  assert(!/99999/.test(g.text('liga 11 99999-8888', 100)));
});
t('perfil: tipo errado ou vazio devolve vazio', () => { const g = createChatGuard(); assert.strictEqual(g.text(null, 100), ''); assert.strictEqual(g.text({ x: 1 }, 100), ''); assert.strictEqual(g.text('   ', 100), ''); });

(async () => {
  const { server } = require('./server.js');
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const open = room => new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?room=' + room); ws.got = [];
    ws.onmessage = e => { const m = JSON.parse(e.data); ws.got.push(m); if (m.t === 'hello') res(ws); }; ws.onerror = rej;
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const A = await open('teste'), B = await open('teste');
  const chatOf = w => w.got.filter(m => m.t === 'emit' && m.topic === 'chat').map(m => m.data);
  const noteOf = w => w.got.filter(m => m.t === 'notice').map(m => m.msg);
  const say = (w, n, x) => w.send(JSON.stringify({ t: 'emit', topic: 'chat', data: { n, t: x } }));
  t('e2e: mensagem normal chega ao outro jogador', () => {});
  say(A, 'Luna', 'oi gente 😺'); await sleep(100);
  t('e2e: chegou limpa', () => assert.deepStrictEqual(chatOf(B), [{ n: 'Luna', t: 'oi gente 😺' }]));
  say(A, 'Notice', 'ola p0rr4 www.golpe.com'); await sleep(50);
  t('e2e: contato bloqueado e aviso ao remetente', () => { assert.strictEqual(chatOf(B).length, 1); assert(noteOf(A).some(n => /links/.test(n))); });
  t('e2e: ack ok:false para a barrada', () => assert.strictEqual(A.got.filter(m => m.t === 'chatack').map(m => m.ok).join(), 'true,false'));
  say(A, 'Notice', 'vai pra p0rr4 agora'); await sleep(50);
  t('e2e: palavrão mascarado e nome reservado trocado', () => { const l = chatOf(B).pop(); assert.strictEqual(l.t, 'vai pra *** agora'); assert.strictEqual(l.n, 'Kitten'); });
  for (let i = 0; i < 12; i++) say(A, 'Luna', 'flood ' + 'abcdefghijkl'[i]); await sleep(150);
  t('e2e: flood é cortado (rajada de 3 já tinha gasto 3)', () => assert(chatOf(B).length <= 4, 'chegaram ' + chatOf(B).length));
  say(A, 'Luna', { x: 1 }); A.send(JSON.stringify({ t: 'emit', topic: 'chat', data: 'lixo' })); await sleep(50);
  t('e2e: outros tópicos continuam passando', () => {});
  const before = B.got.filter(m => m.topic === 'props').length;
  A.send(JSON.stringify({ t: 'emit', topic: 'props', data: [1] })); await sleep(50);
  t('e2e: props passa', () => assert.strictEqual(B.got.filter(m => m.topic === 'props').length, before + 1));
  A.send(JSON.stringify({ t: 'pres', patch: { n: 'AbCd'.repeat(6), c: 3 } })); A.send(JSON.stringify({ t: 'pres', patch: { n: 'puta' } })); await sleep(50);
  t('e2e: nome na presença é limpo (16 / Kitten)', () => { const ns = B.got.filter(m => m.t === 'pres' && m.patch && m.patch.n).map(m => m.patch.n); assert.strictEqual(ns[0].length, 16); assert.strictEqual(ns[1], 'Kitten'); });
  // ---- comandos sincronizados ----
  const cmd = (w, c, a) => w.send(JSON.stringify({ t: 'cmd', c, a }));
  const hourOf = now => (now % 600000) / 600000 * 24;
  await sleep(2100);
  cmd(A, 'night'); await sleep(80);
  t('cmd: /night manda o relógio de TODOS para 21h e avisa todos', () => {
    [A, B].forEach(w => { const c = w.got.filter(m => m.t === 'clock').pop(); assert(c && Math.abs(hourOf(c.now) - 21) < 0.1, 'hora ' + (c && hourOf(c.now))); assert(chatOf(w).some(d => d.n === 'Notice' && /changed the time to night/.test(d.t)), 'sem aviso em ' + JSON.stringify(chatOf(w))); });
  });
  cmd(A, 'rain'); await sleep(50);
  t('cmd: cooldown de 2 s', () => assert(noteOf(A).some(n => /Slow down! Wait/.test(n))));
  await sleep(2100); cmd(B, 'rain'); await sleep(80);
  t('cmd: /rain vale para todos (env)', () => [A, B].forEach(w => assert.strictEqual(w.got.filter(m => m.t === 'env').pop().rain, 1)));
  const C = await open('teste');
  t('cmd: quem entra depois já recebe a chuva no hello', () => assert.strictEqual(C.got.find(m => m.t === 'hello').env.rain, 1));
  await sleep(2100); cmd(A, 'redmoon'); await sleep(80);
  t('cmd: /redmoon vale para todos', () => [A, B, C].forEach(w => assert(w.got.filter(m => m.t === 'env').pop().red > 0)));
  await sleep(2100); cmd(A, 'dia'); await sleep(50);
  t('cmd: comando em português não existe mais', () => assert(noteOf(A).some(n => /Unknown command/.test(n))));
  C.close();
  await sleep(2000); say(A, 'Fake', 'oi de novo'); await sleep(80);
  t('chat usa sempre o nome da presença (não dá para falar como outro nome)', () => assert.strictEqual(chatOf(B).pop().n, 'Kitten'));
  // ---- perfil (menu Profile) ----
  const D = await open('perfil'), E = await open('perfil');
  const profOf = w => w.got.filter(m => m.t === 'emit' && m.topic === 'profile');
  const sendProf = (w, d) => w.send(JSON.stringify({ t: 'emit', topic: 'profile', data: d }));
  sendProf(D, { p: { ph: 'data:image/jpeg;base64,/9j/4AAQ', t: 4, d: 'Oi! vai pra p0rr4', e: '\u{1F63B}', bg: '#AA5500' } }); await sleep(100);
  t('perfil: chega limpo ao outro jogador (cor em minúsculas, palavrão mascarado)', () => {
    const m = profOf(E).pop(); assert(m && m.peer === D.got.find(x => x.t === 'hello').peer);
    assert.deepStrictEqual(m.data.p, { ph: 'data:image/jpeg;base64,/9j/4AAQ', t: 4, d: 'Oi! vai pra ***', e: '\u{1F63B}', bg: '#aa5500' });
  });
  sendProf(D, { p: { ph: 'javascript:alert(1)', t: 99, d: 5, e: '<b>', bg: 'red' } }); await sleep(100);
  t('perfil: dados inválidos viram o padrão', () => assert.deepStrictEqual(profOf(E).pop().data.p, { ph: '', t: 0, d: '', e: '\u{1F431}', bg: '#d9ccf2' }));
  sendProf(D, { p: { ph: 'data:image/jpeg;base64,' + 'A'.repeat(20100), t: 1, d: '', e: '\u{1F431}', bg: '#112233' } }); await sleep(100);
  t('perfil: foto grande demais é descartada', () => assert.strictEqual(profOf(E).pop().data.p.ph, ''));
  const F = await open('perfil'); sendProf(F, { req: 1 }); await sleep(100);
  t('perfil: quem entra depois pede e recebe o perfil de cada jogador (o pedido não é repassado)', () => { assert.strictEqual(profOf(F).length, 1); assert.strictEqual(profOf(F)[0].data.p.bg, '#112233'); assert.strictEqual(profOf(E).filter(m => m.data.req).length, 0); });
  D.close(); E.close(); F.close();
  A.close(); B.close(); server.close();
  console.log('\n' + pass + ' ok, ' + fail + ' falhas'); process.exit(fail ? 1 : 0);
})();
