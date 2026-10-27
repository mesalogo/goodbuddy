const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('goodbuddy', { quitProbe: () => ipcRenderer.send('office-probe:quit'), probeEditorKey: key => ipcRenderer.invoke('office-probe:editor-key', key), probeDiagnostics: () => ipcRenderer.invoke('office-probe:diagnostics'), probeSaveKey: saveAs => ipcRenderer.invoke('office-probe:save-key', saveAs), probeError: () => ipcRenderer.invoke('office-probe:error'), sharing: { getSettings: () => ipcRenderer.invoke('office-probe:connection') }, office: Object.fromEntries(
  ['context', 'capabilities', 'open', 'save', 'close', 'viewport'].map(action => [action, input => ipcRenderer.invoke(`office:${action}`, input)])
) })
