import { contextBridge, ipcRenderer } from 'electron'

// Dedicated sandboxed editor bridge. No desktop/filesystem/provider APIs are exposed.
contextBridge.exposeInMainWorld('goodbuddyOfficeAi', {
  request: (input: unknown): Promise<unknown> => ipcRenderer.invoke('office:editor-ai', input)
})
contextBridge.exposeInMainWorld('goodbuddyOfficeSave', {
  persisted: (revision: number): Promise<unknown> => ipcRenderer.invoke('office:editor-ai', { action: 'persisted', revision })
})
