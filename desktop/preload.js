const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cc', {
  onState: (cb) => ipcRenderer.on('state', (_e, data) => cb(data))
});
