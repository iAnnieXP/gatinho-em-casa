const { contextBridge, ipcRenderer } = require('electron');
/* ponte segura entre o jogo (index.html) e o programa: só expõe "ligar o servidor neste PC" e "aplicar atualização baixada" */
contextBridge.exposeInMainWorld('gatinhoHost', { start: () => ipcRenderer.invoke('gatinho:host') });
contextBridge.exposeInMainWorld('gatinhoUpdate', { apply: () => ipcRenderer.invoke('gatinho:update-apply') });
