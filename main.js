const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path'), os = require('os'), fs = require('fs');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
let win = null, hosting = false;
const MIN_W = 960, MIN_H = 600;   /* tamanho mínimo da janela (16:10, igual à janela padrão de 1280x800) */

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
function create() {
  Menu.setApplicationMenu(null);   /* sem a barra "Game": Host, Full screen e Quit agora ficam na interface do jogo */
  win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, minWidth: MIN_W, minHeight: MIN_H, backgroundColor: '#1a1f2b', title: "Luna's Life", icon: path.join(__dirname, 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.js'), autoplayPolicy: 'no-user-gesture-required' } });
  /* F11 continua alternando a tela cheia (antes vinha do atalho do menu) */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
  /* modo janela: proporção 16:10 fixa e tamanho mínimo (a barra de título/menu entra como espaço extra, fora da proporção) */
  const sz = win.getSize(), cs = win.getContentSize();
  win.setAspectRatio(MIN_W / MIN_H, { width: sz[0] - cs[0], height: sz[1] - cs[1] });
  win.setMinimumSize(MIN_W, MIN_H);
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    const def = String(cfg.servidor || '');
    win.webContents.executeJavaScript("window.GATINHO_APP=true;document.getElementById('srvRow').hidden=" + (def ? 'true' : 'false') + ";" +
      "document.getElementById('srv').value=" + JSON.stringify(def) + "||(function(){try{return localStorage.getItem('gatinho_srv')}catch(e){return ''}})()||'';");
  });
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
