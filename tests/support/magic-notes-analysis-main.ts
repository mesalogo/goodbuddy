import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'

const directory = process.env.GB_NOTES_PROBE_DIRECTORY!
const url = process.env.GB_NOTES_PROBE_URL!
const preload = join(directory, 'preload.cjs')
app.setPath('userData', join(directory, 'profile'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload
  } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  const supportsImageInput = process.env.GB_NOTES_PROBE_VISION === 'true'
  const runtimeSettings = { workspacePath: directory, supportsImageInput,
    defaultModelProfileId: 'vision', modelProfiles: [{ id: 'vision', supportsImageInput }] }
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ magicNoteCommentMode: 'after-save-auto', magicNoteCommentFormat: 'structured' })
  const dispose = registerIpcHandlers(win, { capability: 'text' } as never, 'CommandOrControl+Shift+Space',
    { getResolvedSettings: async () => runtimeSettings, getPublicSettings: async () => runtimeSettings } as never,
    {} as never, { clear() {}, cancelImport() {} } as never, {} as never, database,
    { clear() {} } as never, {} as never, async () => {}, undefined, undefined, undefined, undefined,
    applicationSettings)
  win.webContents.on('console-message', event => console.log(event.message))
  try {
    await win.loadURL(url)
    for (let i = 0; i < 400; i++) {
      if (await win.webContents.executeJavaScript('typeof window.notesAnalysisRegression === "function"')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const result = await win.webContents.executeJavaScript('window.notesAnalysisRegression().catch(error => ({ error: error.stack, body: document.body.innerText }))')
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ ...result, requests: (globalThis as typeof globalThis & { analysisRequests: unknown[] }).analysisRequests }))
  } finally {
    await dispose()
    database.close()
    win.destroy()
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
