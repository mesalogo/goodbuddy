const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('goodbuddy', { office: Object.fromEntries(
  ['open', 'save', 'close', 'viewport'].map(action => [action, input => ipcRenderer.invoke(`office:${action}`, input)])
) })
