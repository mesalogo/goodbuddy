import { app, BrowserWindow, dialog } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { defaultRuntimeSettings } from '../../src/shared/contracts'

const directory = process.env.GB_IMPORT_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1400, height: 900, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: join(directory, 'preload.cjs')
  } })
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  const workspace = join(directory, 'workspace'); await mkdir(workspace)
  database.initialize(workspace)
  const project = database.listProjects()[0]!
  await mkdir(join(project.rootPath, 'selected'))
  const source = join(directory, 'source'); await mkdir(source)
  const bytes = Buffer.alloc(700001).map((_, index) => index % 256)
  await writeFile(join(source, 'import.bin'), bytes)
  const image = database.createImageArtifact({ projectId: project.id, title: 'Existing conversation image', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' })
  database.saveLocalConversations([{ header: { id: randomUUID(), projectId: project.id, title: 'Workspace import', updatedAt: Date.now() },
    messages: [{ id: randomUUID(), role: 'assistant', state: 'complete', content: 'Existing conversation image', createdAt: Date.now(), artifactIds: [image.id] }] }])
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ checkUpdatesOnStartup: false })
  const settings = { ...defaultRuntimeSettings, workspacePath: project.rootPath, modelProfiles: [], embeddingConnections: [] }
  const dispose = registerIpcHandlers(win, { capability: 'text', getStatus: async () => ({ available: true, name: 'Import test', capability: 'text' }) } as never,
    'CommandOrControl+Shift+Space', { getResolvedSettings: async () => settings, getPublicSettings: async () => settings } as never,
    {} as never, { clear() {}, cancelImport() {}, getDraft: () => [] } as never,
    { snapshot: () => ({ libraries: [], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }), database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as never,
    database, {} as never, async () => {}, undefined, undefined, undefined, undefined, applicationSettings,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { getPending: async () => undefined } as never)
  let picks = 0
  // Only the native chooser is deterministic; App, preload, IPC and filesystem are production.
  dialog.showOpenDialog = (async () => { picks++; return { canceled: picks === 3, filePaths: picks === 3 ? [] : [join(source, 'import.bin')] } }) as typeof dialog.showOpenDialog
  const run = async <T = unknown>(code: string): Promise<T> => {
    try { return await win.webContents.executeJavaScript(code, true) }
    catch (error) { throw new Error(`Workspace import probe failed: ${code}`, { cause: error }) }
  }
  const wait = async (code: string): Promise<void> => {
    for (let i = 0; i < 300; i++) { if (await run(code)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Timed out: ${code}`)
  }
  const button = (label: string): string => `[...document.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||e.textContent.trim())===${JSON.stringify(label)}&&e.getClientRects().length)`
  const ready = (label: string): string => `(() => { const target = ${button(label)}; return Boolean(target && !target.disabled) })()`
  const click = async (label: string): Promise<void> => { await wait(ready(label)); await run(`${button(label)}.click()`) }
  try {
    await win.loadURL(process.env.GB_IMPORT_URL!)
    await wait('Boolean(document.querySelector(".message-generated-image img"))')
    await wait('document.querySelector(".message-generated-image img").naturalWidth===1')
    assert.equal(await run('[...document.querySelectorAll("[role=tab]")].some(e=>e.textContent==="Results")'), false)
    if (await run('document.querySelector(".assistant-sidebar-toggle").getAttribute("aria-expanded")==="false"')) await click('Toggle assistant workspace')
    await click('Files')
    await click('selected')
    await wait('document.body.innerText.includes("Destination: selected")')
    await click('Import files')
    await wait('document.body.innerText.includes("Imported 1 files into selected.")')
    await wait('Boolean([...document.querySelectorAll(".workspace-files__row")].find(e=>e.title==="selected/import.bin"))')
    assert.deepEqual(await readFile(join(project.rootPath, 'selected/import.bin')), bytes)
    assert.deepEqual(await readdir(project.rootPath), ['selected'])
    assert.equal(database.listArtifacts().length, 1)
    assert.equal(database.getArtifact(image.id).content, image.content)
    await click('Import files')
    await wait('document.body.innerText.includes("EEXIST")')
    assert.deepEqual(await readFile(join(project.rootPath, 'selected/import.bin')), bytes)
    await click('Import files')
    await wait(ready('Import files'))
    await win.reload()
    await wait('Boolean(document.querySelector(".message-generated-image img")) && document.querySelector(".message-generated-image img").naturalWidth===1')
    await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, picks, bytes: bytes.length, imageAfterReload: true, artifactCount: database.listArtifacts().length, modelCalls: 0 }))
    await dispose(); database.close(); win.destroy(); app.exit(0)
  } catch (error) {
    await writeFile(join(directory, 'result.json'), JSON.stringify({ error: String(error) }))
    console.error(error); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
