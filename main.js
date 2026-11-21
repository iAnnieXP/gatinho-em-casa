const { app, BrowserWindow, Menu, dialog } = require('electron');
const path = require('path'), os = require('os'), fs = require('fs');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
let win = null, hosting = false;

function ips() {
  const out = [];
  Object.values(os.networkInterfaces()).forEach(l => l.forEach(i => { if (i.family === 'IPv4' && !i.internal) out.push(i.address + ':3000'); }));
  return out;
}
function setServer(v) { if (win) win.webContents.executeJavaScript("document.getElementById('srv').value=" + JSON.stringify(v)); }
function showHost() {
  const l = ips();
  dialog.showMessageBox(win, { type: 'info', title: 'Hospedando', message: 'Servidor ligado neste PC.',
    detail: 'Amigos na MESMA rede Wi-Fi digitam no campo "Servidor":\n\n' + (l.join('\n') || '(IP não encontrado)') +
      '\n\nPara amigos pela internet, use um túnel (ex.: ngrok http 3000) e passe o endereço gerado.\nSe o Windows pedir, permita o acesso no firewall.' });
}
function host() {
  if (hosting) return showHost();
  const { server } = require('./server.js');
  server.once('error', e => dialog.showErrorBox('Não foi possível hospedar', String(e.message)));
  server.listen(3000, () => { hosting = true; setServer('localhost:3000'); showHost(); });
}
function create() {
  win = new BrowserWindow({ width: 1280, height: 800, backgroundColor: '#1a1f2b', title: 'Gatinho em Casa', webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Jogo', submenu: [
    { label: 'Hospedar neste PC', click: host }, { label: 'Tela cheia', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
    { type: 'separator' }, { label: 'Sair', role: 'quit' } ] }]));
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    const def = String(cfg.servidor || '');
    win.webContents.executeJavaScript("window.GATINHO_APP=true;document.getElementById('srvRow').hidden=" + (def ? 'true' : 'false') + ";" +
      "document.getElementById('srv').value=" + JSON.stringify(def) + "||(function(){try{return localStorage.getItem('gatinho_srv')}catch(e){return ''}})()||'';");
  });
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
