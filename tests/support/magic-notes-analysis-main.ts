import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { prepareLiveNotesAnalysis } from './magic-notes-analysis-live'

const directory = process.env.GB_NOTES_PROBE_DIRECTORY!
const url = process.env.GB_NOTES_PROBE_URL!
const preload = join(directory, 'preload.cjs')
app.setPath('userData', join(directory, 'profile'))
if (process.env.GB_NOTES_LIVE === '1' && process.platform === 'win32') {
  const localState = JSON.parse(readFileSync(join(dirname(process.env.GB_NOTES_LIVE_SETTINGS!), 'Local State'), 'utf8'))
  mkdirSync(join(directory, 'profile'), { recursive: true })
  writeFileSync(join(directory, 'profile', 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }))
}
app.on('will-quit', () => {
  if (process.env.GB_NOTES_LIVE === '1') rmSync(join(directory, 'profile', 'Local State'), { force: true })
})
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload
  } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize(directory)
  const supportsImageInput = process.env.GB_NOTES_PROBE_VISION === 'true'
  const live = process.env.GB_NOTES_LIVE === '1' ? await prepareLiveNotesAnalysis(directory) : undefined
  const runtimeSettings = live?.settings ?? { workspacePath: directory, supportsImageInput,
    defaultModelProfileId: 'vision', modelProfiles: [{ id: 'vision', supportsImageInput }] }
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ magicNoteCommentMode: live ? 'after-save-manual' : 'after-save-auto', magicNoteCommentFormat: 'structured' })
  const dispose = registerIpcHandlers(win, { capability: 'text' } as never, 'CommandOrControl+Shift+Space',
    { getResolvedSettings: async () => runtimeSettings, getPublicSettings: async () => live ? {
      supportsImageInput: true, defaultModelProfileId: runtimeSettings.defaultModelProfileId,
      modelProfiles: runtimeSettings.modelProfiles.map(profile => ({ id: profile.id, supportsImageInput: profile.supportsImageInput }))
    } : runtimeSettings } as never,
    {} as never, { clear() {}, cancelImport() {} } as never, {} as never, database,
    { clear() {} } as never, {} as never, async () => {}, undefined, undefined, undefined, undefined,
    applicationSettings)
  if (!live) win.webContents.on('console-message', event => console.log(event.message))
  try {
    await win.loadURL(url)
    for (let i = 0; i < 400; i++) {
      if (await win.webContents.executeJavaScript('typeof window.notesAnalysisRegression === "function"')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const result = await win.webContents.executeJavaScript('window.notesAnalysisRegression().catch(error => ({ error: error.stack, body: document.body.innerText }))')
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ ...result, requests: (globalThis as typeof globalThis & { analysisRequests: unknown[] }).analysisRequests }))
    if (live) {
      writeFileSync(join(directory, 'ui.png'), (await win.webContents.capturePage()).toPNG())
      live.save()
    }
  } finally {
    await dispose()
    database.close()
    win.destroy()
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
