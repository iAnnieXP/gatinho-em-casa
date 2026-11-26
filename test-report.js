'use strict';
// Teste de ponta a ponta: sobe o servidor de verdade, conecta jogadores por WebSocket e um "Discord" falso (http local).
//   node test-report.js
// Verifica: (1) mensagem privada passa pelo MESMO filtro do chat público; (2) denúncia (chat e privada) chega ao webhook;
// (3) denúncia forjada/adulterada/de mensagem alheia é recusada; (4) duplicada não repete; (5) limite de denúncias.
const http = require('http');
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }, e => { fail++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); });
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const got = [], reps = () => got.filter(x => x.embeds);   // got = tudo que chegou no "Discord" (inclui avisos de entrada); reps() = só denúncias
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { got.push(JSON.parse(b)); } catch (e) {} res.writeHead(204); res.end(); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  process.env.DISCORD_WEBHOOK = 'http://127.0.0.1:' + fake.address().port + '/api/webhooks/1/abc';
  process.env.DM_FILE = require('path').join(require('os').tmpdir(), 'dm-test-' + process.pid + '.json');
  const { server } = require('./server.js');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  function player(room, nick) {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?room=' + room + '&dev=' + (nick + 'x'.repeat(10)));
    const p = { ws, inbox: [], nick };
    ws.onmessage = ev => { const m = JSON.parse(ev.data); p.inbox.push(m); };
    p.send = o => ws.send(JSON.stringify(o));
    p.next = async (pred, ms = 1500) => { const t0 = Date.now(); for (;;) { const i = p.inbox.findIndex(pred); if (i >= 0) return p.inbox.splice(i, 1)[0]; if (Date.now() - t0 > ms) return null; await wait(15); } };
    return new Promise(res => { ws.onopen = async () => { await p.next(m => m.t === 'hello'); p.send({ t: 'pres', patch: { n: nick } }); await wait(60); res(p); }; });
  }
  let q = 100;
  const dm = async (from, to, text) => { const id = ++q; from.send({ t: 'dm', to, text, q: id }); return from.next(m => m.t === 'dmack' && m.q === id); };
  const report = async (who, o) => { const id = ++q; who.send(Object.assign({ t: 'report', q: id }, o)); return who.next(m => m.t === 'reportack' && m.q === id); };

  const room = 'testroom';
  const ana = await player(room, 'Ana'), bia = await player(room, 'Bia'), caio = await player(room, 'Caio');

  console.log('Filtro: privada = chat público');
  await ok('palavrão na privada vira *** (igual ao chat)', async () => {
    const a = await dm(ana, 'Bia', 'voce e uma merda');
    assert(a.ok && /\*\*\*/.test(a.tx), JSON.stringify(a));
    const d = await bia.next(m => m.t === 'dm'); assert(d && /\*\*\*/.test(d.text) && !/merda/.test(d.text));
  });
  await ok('link na privada é bloqueado (igual ao chat)', async () => { const a = await dm(ana, 'Bia', 'entra em meusite.com'); assert.strictEqual(a.ok, false); });
  await ok('telefone na privada é bloqueado', async () => { const a = await dm(ana, 'Bia', 'me liga 11 99999 8888'); assert.strictEqual(a.ok, false); });
  await ok('repetir a mesma privada é bloqueado', async () => { await dm(ana, 'Bia', 'oi bia'); const b = await dm(ana, 'Bia', 'oi bia'); assert.strictEqual(b.ok, false); });
  await ok('privada passa pelo limite de velocidade do chat', async () => {
    const r = []; for (let i = 0; i < 8; i++) r.push((await dm(caio, 'Ana', 'msg numero ' + 'abcdefgh'[i])).ok);
    assert(r.includes(false), 'nenhuma barrada: ' + r);
  });
  await wait(4500);   // deixa o balde encher

  console.log('Denúncia: mensagem pública');
  let pubMsg;
  await ok('chat público sai assinado (ts + sg)', async () => {
    ana.send({ t: 'emit', topic: 'chat', data: { n: 'Ana', t: 'mensagem ruim' } });
    const e = await bia.next(m => m.t === 'emit' && m.topic === 'chat'); pubMsg = e.data;
    assert(pubMsg.sg && /^[0-9a-f]{64}$/.test(pubMsg.sg) && typeof pubMsg.ts === 'number' && pubMsg.n === 'Ana');
  });
  const pubRep = () => ({ k: 'chat', from: pubMsg.n, text: pubMsg.t, ts: pubMsg.ts, sg: pubMsg.sg, room, why: 'xingou outro jogador' });
  await ok('denúncia válida chega ao Discord', async () => {
    const r = await report(bia, pubRep()); assert(r.ok, JSON.stringify(r));
    await wait(400); assert.strictEqual(reps().length, 1, 'webhook recebeu ' + reps().length);
    const e = reps()[0].embeds[0], f = Object.fromEntries(e.fields.map(x => [x.name, x.value]));
    assert(/chat público/.test(e.title) && f['Denunciado'] === 'Ana' && f['Quem denunciou'] === 'Bia' && /mensagem ruim/.test(f['Mensagem']) && f['Sala'].includes(room) && /xingou outro jogador/.test(f['Motivo da denúncia']));
    assert.deepStrictEqual(reps()[0].allowed_mentions, { parse: [] });
  });
  await ok('denúncia duplicada não vai de novo ao Discord', async () => { const r = await report(bia, pubRep()); assert(r.ok); await wait(300); assert.strictEqual(reps().length, 1); });
  await ok('texto adulterado é recusado', async () => { const r = await report(caio, Object.assign(pubRep(), { text: 'Ana disse algo horrível' })); assert.strictEqual(r.ok, false); assert.strictEqual(r.why, 'invalid'); });
  await ok('remetente trocado é recusado', async () => { const r = await report(caio, Object.assign(pubRep(), { from: 'Bia' })); assert.strictEqual(r.ok, false); });
  await ok('assinatura inventada é recusada', async () => { const r = await report(caio, Object.assign(pubRep(), { sg: 'a'.repeat(64) })); assert.strictEqual(r.ok, false); });
  await ok('sem assinatura é recusado', async () => { const r = await report(caio, { k: 'chat', from: 'Ana', text: 'oi', ts: Date.now(), room }); assert.strictEqual(r.ok, false); });
  await ok('não dá para denunciar a própria mensagem', async () => { const r = await report(ana, pubRep()); assert.strictEqual(r.ok, false); });
  await ok('mensagem de outra sala não vale', async () => { const r = await report(caio, Object.assign(pubRep(), { room: 'outra' })); assert.strictEqual(r.ok, false); });
  await ok('nada sobra no Discord das recusadas', async () => { await wait(300); assert.strictEqual(reps().length, 1); });

  console.log('Denúncia: mensagem privada');
  await wait(1500);
  let dmMsg;
  await ok('privada sai assinada para o destinatário', async () => {
    const a = await dm(ana, 'Bia', 'oi bia tudo bem'); assert(a.ok);
    dmMsg = await bia.next(m => m.t === 'dm' && /tudo bem/.test(m.text)); assert(dmMsg && /^[0-9a-f]{64}$/.test(dmMsg.sg));
  });
  const dmRep = () => ({ k: 'dm', from: dmMsg.from, text: dmMsg.text, ts: dmMsg.ts, sg: dmMsg.sg });
  await ok('destinatário denuncia a privada e chega ao Discord', async () => {
    const r = await report(bia, dmRep()); assert(r.ok, JSON.stringify(r)); await wait(400);
    assert.strictEqual(reps().length, 2); const e = reps()[1].embeds[0], f = Object.fromEntries(e.fields.map(x => [x.name, x.value]));
    assert(/privada/.test(e.title) && f['Denunciado'] === 'Ana' && f['Quem denunciou'] === 'Bia' && /tudo bem/.test(f['Mensagem']));
  });
  await ok('terceiro NÃO consegue denunciar a privada dos outros', async () => { const edu = await player(room, 'Edu'); const r = await report(edu, dmRep()); edu.ws.close(); assert.strictEqual(r.ok, false); assert.strictEqual(r.why, 'invalid'); });

  console.log('Denúncia: privada enfileirada (destinatário offline)');
  await wait(1500);
  await ok('privada guardada chega assinada e pode ser denunciada', async () => {
    const a = await dm(ana, 'Dani', 'oi dani quando voltar'); assert(a.ok && a.queued);
    const dani = await player('outrasala', 'Dani'); const late = await dani.next(m => m.t === 'dm' && m.late);
    assert(late && late.sg, 'sem assinatura na entrega tardia');
    const r = await report(dani, { k: 'dm', from: late.from, text: late.text, ts: late.ts, sg: late.sg }); assert(r.ok, JSON.stringify(r)); dani.ws.close();
  });

  console.log('Limite');
  await ok('inundar denúncias é limitado (rajada de 3)', async () => {
    const lim = await player(room, 'Lia'); let slow = 0, sent = 0;
    for (let i = 0; i < 6; i++) { const r = await report(lim, { k: 'chat', from: 'X', text: 't' + i, ts: Date.now(), sg: 'b'.repeat(64), room }); if (r && r.why === 'slow') slow++; sent++; }
    assert(slow >= 3, 'slow=' + slow); lim.ws.close();
  });

  console.log('\n' + pass + ' ok, ' + fail + ' falhas'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
