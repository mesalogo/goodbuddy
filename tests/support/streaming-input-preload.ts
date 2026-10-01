import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('streamingInputBridge', {
  onChunk: (callback: (delta: string) => void) => {
    ipcRenderer.on('streaming-input:chunk', (_event, delta) => callback(delta))
  }
})
