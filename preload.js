const { contextBridge, ipcRenderer } = require('electron');
/* ponte segura entre o jogo (index.html) e o programa: só expõe "ligar o servidor neste PC" */
contextBridge.exposeInMainWorld('gatinhoHost', { start: () => ipcRenderer.invoke('gatinho:host') });
