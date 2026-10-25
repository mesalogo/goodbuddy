const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('goodbuddy', { quitProbe: () => ipcRenderer.send('office-probe:quit'), probeDiagnostics: () => ipcRenderer.invoke('office-probe:diagnostics'), probeSaveKey: saveAs => ipcRenderer.invoke('office-probe:save-key', saveAs), probeError: () => ipcRenderer.invoke('office-probe:error'), sharing: { getSettings: () => ipcRenderer.invoke('office-probe:connection') }, office: Object.fromEntries(
  ['capabilities', 'open', 'save', 'close', 'viewport'].map(action => [action, input => ipcRenderer.invoke(`office:${action}`, input)])
) })
