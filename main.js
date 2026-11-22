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
  dialog.showMessageBox(win, { type: 'info', title: 'Hosting', message: 'Server running on this PC.',
    detail: 'Friends on the SAME Wi-Fi network type this in the "Server" field:\n\n' + (l.join('\n') || '(IP not found)') +
      '\n\nFor friends over the internet, use a tunnel (e.g. ngrok http 3000) and share the generated address.\nIf Windows asks, allow access through the firewall.' });
}
function host() {
  if (hosting) return showHost();
  const { server } = require('./server.js');
  server.once('error', e => dialog.showErrorBox('Could not host the server', String(e.message)));
  server.listen(3000, () => { hosting = true; setServer('localhost:3000'); showHost(); });
}
function create() {
  win = new BrowserWindow({ width: 1280, height: 800, backgroundColor: '#1a1f2b', title: "Luna's Life", icon: path.join(__dirname, 'icon.png'), webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Game', submenu: [
    { label: 'Host on this PC', click: host }, { label: 'Full screen', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
    { type: 'separator' }, { label: 'Quit', role: 'quit' } ] }]));
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    const def = String(cfg.servidor || '');
    win.webContents.executeJavaScript("window.GATINHO_APP=true;document.getElementById('srvRow').hidden=" + (def ? 'true' : 'false') + ";" +
      "document.getElementById('srv').value=" + JSON.stringify(def) + "||(function(){try{return localStorage.getItem('gatinho_srv')}catch(e){return ''}})()||'';");
  });
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
