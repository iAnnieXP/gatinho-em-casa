const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path'), os = require('os'), fs = require('fs');
const updater = require('./updater.js');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
let win = null, hosting = false;
const MIN_W = 960, MIN_H = 600;   /* tamanho mínimo da janela (16:10, igual à janela padrão de 1280x800) */
const BUNDLED = path.join(__dirname, 'public');   /* o jogo que veio dentro do .exe */
let active = null, pending = null, checking = false, checksStarted = false;   /* active = pasta que o jogo está usando; pending = versão já baixada esperando o jogador aplicar */

function ips() {
  const out = [];
  Object.values(os.networkInterfaces()).forEach(l => l.forEach(i => { if (i.family === 'IPv4' && !i.internal) out.push(i.address + ':3000'); }));
  return out;
}
/* "Host on this PC" agora é um botão dentro do jogo (tela Multiplayer): o jogo chama este handler pelo preload.js */
ipcMain.handle('gatinho:host', () => new Promise(resolve => {
  if (hosting) return resolve({ ok: true, ips: ips() });
  const { server } = require('./server.js');
  const onError = e => resolve({ ok: false, error: String(e.message) });
  server.once('error', onError);
  server.listen(3000, () => { server.removeListener('error', onError); hosting = true; resolve({ ok: true, ips: ips() }); });
}));

/* ---------- atualização automática (veja updater.js) ---------- */
function openGame() { win.loadFile(path.join(active.dir, 'index.html')); }
/* clicou em "Update now": recarrega a janela já com a versão baixada (não precisa fechar o programa) */
ipcMain.handle('gatinho:update-apply', () => {
  if (!pending || !win) return false;
  active = updater.resolveActive(BUNDLED); pending = null; openGame(); return true;
});
/* Barra de status embaixo da tela (injetada pelo programa, então funciona mesmo se o index.html mudar).
   kind: 'checking' | 'downloading' (com bolinha girando) | 'ok' | 'error' | 'ready' (com os botões Update now / Later). hideAfter: some sozinha depois de N ms. */
let statusTimer = null;
function showStatus(kind, text, hideAfter) {
  if (!win || win.isDestroyed()) return;
  clearTimeout(statusTimer);
  win.webContents.executeJavaScript('(' + function (kind, text) {
    if (!document.getElementById('gatinhoUpdCss')) { var st = document.createElement('style'); st.id = 'gatinhoUpdCss'; st.textContent = '@keyframes gatinhoSpin{to{transform:rotate(360deg)}}'; document.head.appendChild(st); }
    var o = document.getElementById('gatinhoUpd'); if (o) o.remove();
    var d = document.createElement('div'); d.id = 'gatinhoUpd';
    d.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:10px;align-items:center;padding:8px 14px;border-radius:12px;background:rgba(26,31,43,.94);color:#fff;font:600 14px Nunito,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4);pointer-events:none';
    if (kind === 'checking' || kind === 'downloading') { var sp = document.createElement('span'); sp.style.cssText = 'width:14px;height:14px;box-sizing:border-box;border:2px solid rgba(255,255,255,.3);border-top-color:#ffb347;border-radius:50%;animation:gatinhoSpin .8s linear infinite'; d.appendChild(sp); }
    var t = document.createElement('span'); t.textContent = (kind === 'ok' ? '\u2713 ' : kind === 'error' ? '\u26A0 ' : '') + text; d.appendChild(t);
    if (kind === 'ready') {
      d.style.pointerEvents = 'auto';
      function btn(txt, main, fn) { var b = document.createElement('button'); b.textContent = txt; b.style.cssText = 'cursor:pointer;border:0;border-radius:8px;padding:6px 12px;font:inherit;' + (main ? 'background:#ffb347;color:#1a1f2b' : 'background:#3a4153;color:#fff'); b.onclick = fn; return b; }
      d.appendChild(btn('Update now', true, function () { if (window.gatinhoUpdate) window.gatinhoUpdate.apply(); }));
      d.appendChild(btn('Later', false, function () { d.remove(); }));
    }
    document.body.appendChild(d);
  } + ')(' + JSON.stringify(kind) + ',' + JSON.stringify(text) + ')').catch(() => {});
  if (hideAfter) statusTimer = setTimeout(hideStatus, hideAfter);
}
function hideStatus() {
  clearTimeout(statusTimer);
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript("var o=document.getElementById('gatinhoUpd');if(o)o.remove()").catch(() => {});
}
/* showUi = true só na checagem ao abrir o jogo (mostra "Checking..." e "up to date"); nas checagens de 30 em 30 min o jogador só vê algo se houver novidade */
async function runCheck(showUi) {
  if (checking) return; checking = true;
  let found = false, slow = null;
  if (showUi && updater.enabled(cfg)) {
    showStatus('checking', 'Checking for updates\u2026');
    slow = setTimeout(() => { if (!found) hideStatus(); }, 8000);   /* servidor dormindo (Render gratis) pode demorar: some a barra e continua em segundo plano */
  }
  try {
    const r = await updater.check(cfg, pending || active.version, ev => {
      if (ev.type === 'found') { found = true; showStatus('downloading', 'Update ' + ev.version + ' found \u2014 downloading\u2026'); }
      else if (ev.type === 'progress' && ev.total > 1) showStatus('downloading', 'Downloading update ' + ev.version + ' (' + ev.done + '/' + ev.total + ')\u2026');
    });
    if (r && r.version) { pending = r.version; showStatus('ready', 'Update ' + r.version + ' is ready'); }
    else if (r && r.upToDate && showUi) showStatus('ok', "You're up to date", 2500);
    else if (showUi) hideStatus();
  } catch (e) {
    console.log('[update]', e.message);   /* sem internet / servidor fora do ar: tenta de novo em 30 min */
    if (found) showStatus('error', 'Update failed \u2014 will try again later', 4000); else if (showUi) showStatus('error', "Couldn't check for updates", 4000);
  }
  clearTimeout(slow); checking = false;
}
function startChecks() {
  if (checksStarted) return; checksStarted = true;
  setTimeout(() => runCheck(true), 4000);                 /* confere logo depois de abrir... */
  setInterval(() => runCheck(false), 30 * 60 * 1000);      /* ...e a cada 30 min enquanto o jogo estiver aberto */
}

function create() {
  Menu.setApplicationMenu(null);   /* sem a barra "Game": Host, Full screen e Quit agora ficam na interface do jogo */
  active = updater.resolveActive(BUNDLED);
  win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, minWidth: MIN_W, minHeight: MIN_H, backgroundColor: '#1a1f2b', title: "Luna's Life", icon: path.join(__dirname, 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.js'), autoplayPolicy: 'no-user-gesture-required' } });
  /* F11 continua alternando a tela cheia (antes vinha do atalho do menu) */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
  /* modo janela: proporção 16:10 fixa e tamanho mínimo (a barra de título/menu entra como espaço extra, fora da proporção) */
  const sz = win.getSize(), cs = win.getContentSize();
  win.setAspectRatio(MIN_W / MIN_H, { width: sz[0] - cs[0], height: sz[1] - cs[1] });
  win.setMinimumSize(MIN_W, MIN_H);
  /* se a versão baixada não abrir, volta para a que veio no .exe */
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && active.updated) { updater.reset(); active = { dir: BUNDLED, version: app.getVersion(), updated: false }; pending = null; openGame(); }
  });
  openGame();
  win.webContents.on('did-finish-load', () => {
    const def = String(cfg.servidor || '');
    win.webContents.executeJavaScript("window.GATINHO_APP=true;window.GATINHO_VERSION=" + JSON.stringify(active.version) + ";document.getElementById('srvRow').hidden=" + (def ? 'true' : 'false') + ";" +
      "document.getElementById('srv').value=" + JSON.stringify(def) + "||(function(){try{return localStorage.getItem('gatinho_srv')}catch(e){return ''}})()||'';");
    if (pending) showStatus('ready', 'Update ' + pending + ' is ready');   /* recarregou sem aplicar? lembra de novo */
    startChecks();
  });
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
