const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('goodbuddy', { quitProbe: () => ipcRenderer.send('office-probe:quit'), office: Object.fromEntries(
  ['capabilities', 'open', 'save', 'close', 'viewport'].map(action => [action, input => ipcRenderer.invoke(`office:${action}`, input)])
) })
