// Testes das contas. Rode com:  node test-accounts.js   (sem dependências; Node 22+ para o WebSocket de teste)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-acc-'));
const { server } = require('./server.js');
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; } catch (e) { fail++; console.log('FALHOU: ' + name + '\n   ' + e.message); } }
server.listen(0, async () => {
  const port = server.address().port, base = 'http://127.0.0.1:' + port;
  const post = (r, body) => fetch(base + '/api/' + r, { method: 'POST', body: JSON.stringify(body) }).then(x => x.json());
  const ws = (qs) => new Promise(res => {
    const w = new WebSocket('ws://127.0.0.1:' + port + '/ws?room=sala-1' + qs); const got = [];
    w.onmessage = ev => { const m = JSON.parse(ev.data); got.push(m); if (m.t === 'hello' || m.t === 'denied') res({ w, m, got }); };
    w.onerror = () => res({ w, m: { t: 'error' }, got });
  });
  let tok;
  await t('cria conta e devolve sessão', async () => { const r = await post('register', { name: 'Ana', pass: 'segredo1' }); assert(r.ok && r.name === 'Ana' && r.token); tok = r.token; });
  await t('nome repetido (sem diferenciar maiúsculas) é recusado', async () => { const r = await post('register', { name: 'ANA', pass: 'outra123' }); assert(!r.ok && r.error === 'taken'); });
  await t('senha de 16 caracteres é recusada, 15 é aceita, curta é recusada', async () => {
    assert(!(await post('register', { name: 'Bia', pass: 'a'.repeat(16) })).ok);
    assert(!(await post('register', { name: 'Bia', pass: 'abc' })).ok);
    assert((await post('register', { name: 'Bia', pass: 'a'.repeat(15) })).ok);
  });
  await t('nome inválido é recusado', async () => { assert(!(await post('register', { name: 'a b', pass: 'segredo1' })).ok); assert(!(await post('register', { name: 'x'.repeat(11), pass: 'segredo1' })).ok); assert(!(await post('register', { name: '', pass: 'segredo1' })).ok); });
  await t('login certo e errado', async () => {
    assert((await post('login', { name: 'ana', pass: 'segredo1' })).name === 'Ana');
    assert((await post('login', { name: 'Ana', pass: 'errada' })).error === 'bad');
    assert((await post('login', { name: 'Zed', pass: 'segredo1' })).error === 'none');
  });
  await t('o arquivo não guarda a senha em texto', () => { const f = fs.readFileSync(path.join(process.env.DATA_DIR, 'accounts.json'), 'utf8'); assert(!f.includes('segredo1') && f.includes('"hash"')); });
  await t('/api/name diz se o nome tem conta', async () => {
    assert((await fetch(base + '/api/name?n=ana').then(r => r.json())).registered === true);
    assert((await fetch(base + '/api/name?n=Livre').then(r => r.json())).registered === false);
  });
  await t('visitante com nome livre entra', async () => { const r = await ws('&name=Livre'); assert.equal(r.m.t, 'hello'); r.w.close(); });
  await t('nome de conta sem sessão é barrado', async () => { const r = await ws('&name=Ana'); assert.equal(r.m.t, 'denied'); });
  await t('nome de conta com sessão errada é barrado', async () => { const r = await ws('&name=Ana&token=abc'); assert.equal(r.m.t, 'denied'); });
  await t('nome de conta com a sessão certa entra e o nome vem da conta', async () => {
    const r = await ws('&name=ana&token=' + tok); assert.equal(r.m.t, 'hello'); const me = r.m.peer;
    const o = await ws('&name=Livre'); const seen = o.m.peers[me]; assert.equal(seen && seen.n, 'Ana');
    r.w.send(JSON.stringify({ t: 'pres', patch: { n: 'Outro' } })); await new Promise(x => setTimeout(x, 150));
    assert(!o.got.some(m => m.t === 'pres' && m.patch && m.patch.n && m.patch.n !== 'Ana'));
    r.w.close(); o.w.close();
  });
  await t('sessão de uma conta não vale para outra', async () => { const r = await ws('&name=Bia&token=' + tok); assert.equal(r.m.t, 'denied'); });
  await t('visitante não pode trocar para nome de conta', async () => {
    const a = await ws('&name=Livre2'), b = await ws('&name=Livre3'); a.w.send(JSON.stringify({ t: 'pres', patch: { n: 'Ana' } })); await new Promise(x => setTimeout(x, 150));
    assert(!b.got.some(m => m.t === 'pres' && m.patch && m.patch.n === 'Ana')); a.w.close(); b.w.close();
  });
  console.log(fail ? fail + ' falharam, ' + pass + ' passaram' : 'Todos os ' + pass + ' testes passaram');
  server.close(); process.exit(fail ? 1 : 0);
});
