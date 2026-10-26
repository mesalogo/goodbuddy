import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { DesktopUpdateService, runUpdateWorker } from '../../src/main/desktop-update-service'
import { registerDesktopUpdateIpc } from '../../src/main/desktop-update-ipc'
import { ipcChannels } from '../../src/shared/ipc-channels'
import { applicationSettingsSchema, defaultLocalToolEnvironmentSettings } from '../../src/shared/application-settings-contracts'

const directory = process.env.GB_UPDATE_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
void app.whenReady().then(async () => {
  const bytes = Buffer.alloc(512 * 1024, 65)
  const file = { name: 'GoodBuddy-1.0.1-windows-x64-setup.exe', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const downloadDirectory = join(directory, 'packages')
  await mkdir(downloadDirectory, { recursive: true })
  const stale = join(downloadDirectory, 'GoodBuddy-0.9.0-windows-x64-setup.exe')
  const partial = join(downloadDirectory, 'GoodBuddy-1.0.1-windows-x64-setup.exe.partial')
  await writeFile(stale, 'previously installed package')
  await writeFile(partial, 'abandoned partial')
  await writeFile(join(downloadDirectory, 'personal.txt'), 'keep this file')
  let opened = 0
  let restartRequests = 0
  let saveAttempts = 0
  const service = new DesktopUpdateService({
    directory: downloadDirectory, portable: false,
    cleanup: (mode, keepFileName) => runUpdateWorker(join(directory, 'worker.cjs'), {
      kind: 'cleanup', directory: downloadDirectory, currentVersion: '1.0.0', mode,
      protectedPaths: keepFileName ? [join(downloadDirectory, keepFileName)] : []
    }, () => undefined),
    run: (job, report) => runUpdateWorker(join(directory, 'worker.cjs'), job, report),
    openPath: async path => { assert.deepEqual(await readFile(path), bytes); opened++; return '' },
    showItemInFolder: () => { throw new Error('Unexpected archive reveal') },
    requestRestart: path => { assert.equal(path, join(downloadDirectory, file.name)); restartRequests++ }
  })
  service.setRestartPreparation(async () => {
    if (++saveAttempts === 1) throw new Error('Persistence failed in controlled fixture')
    return () => undefined
  })
  const settings = applicationSettingsSchema.parse({ checkUpdatesOnStartup: false, updateSource: 'github', modelDownloadSource: 'modelscope',
    localToolEnvironment: defaultLocalToolEnvironmentSettings, conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false })
  ipcMain.handle(ipcChannels.appInfo, () => ({ name: 'GoodBuddy', version: '1.0.0', platform: 'win32', arch: 'x64' }))
  ipcMain.handle(ipcChannels.applicationSettingsGet, () => settings)
  ipcMain.handle(ipcChannels.versionCheck, () => {
    const result = { updateAvailable: true, currentVersion: '1.0.0', latestVersion: '1.0.1', releaseUrl: 'https://github.com/mesalogo/goodbuddy/releases/tag/v1.0.1',
      target: { platform: 'windows' as const, arch: 'x64' as const, formats: ['nsis'], files: [file] } }
    service.accept(result, 'github')
    return result
  })
  const win = new BrowserWindow({ show: true, width: 1000, height: 850, webPreferences: {
    preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false
  } })
  const dispose = registerDesktopUpdateIpc(win, service)
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const errors: string[] = []
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const wait = async (code: string): Promise<void> => {
    for (let count = 0; count < 400; count++) {
      if (await js(code)) return
      await setTimeout(25)
    }
    throw new Error(`Timed out: ${code}\n${errors.join('\n')}`)
  }
  const click = async (text: string): Promise<void> => {
    const expression = `[...document.querySelectorAll('button')].find(e => e.textContent === ${JSON.stringify(text)} && !e.disabled)`
    await wait(`!!(${expression})`)
    await js(`${expression}.click()`)
  }
  try {
    win.webContents.once('did-finish-load', () => { void service.cleanupStalePackages() })
    await win.loadURL(process.env.GB_UPDATE_RENDERER!)
    await wait('window.goodbuddy.desktopUpdates.getSnapshot().then(s => !s.cacheCleaning)')
    await assert.rejects(stat(stale))
    await assert.rejects(stat(partial))
    await click('Check for updates now')
    await click('Download update')
    await wait('!!document.querySelector("progress")')
    await click('Cancel download')
    await wait(`[...document.querySelectorAll('button')].some(e => e.textContent === 'Download update' && !e.disabled)`)
    assert.equal(service.getSnapshot().status, 'available')
    await assert.rejects(stat(join(downloadDirectory, `${file.name}.partial`)))
    await click('Download update')
    await wait('!!document.querySelector("progress")')
    await js('document.querySelector("#toggle-settings").click()')
    // The component is unmounted while the actual worker continues to download.
    for (let count = 0; service.getSnapshot().status !== 'ready' && count < 400; count++) await setTimeout(25)
    assert.equal(service.getSnapshot().status, 'ready', service.getSnapshot().error ?? 'Download did not finish')
    await js('document.querySelector("#toggle-settings").click()')
    await click('Clear update cache')
    await wait('window.goodbuddy.desktopUpdates.getSnapshot().then(s => !s.cacheCleaning && s.status === "available")')
    await assert.rejects(stat(join(downloadDirectory, file.name)))
    assert.equal(await readFile(join(downloadDirectory, 'personal.txt'), 'utf8'), 'keep this file')
    await click('Download update')
    await wait('window.goodbuddy.desktopUpdates.getSnapshot().then(s => s.status === "ready")')
    assert.equal(opened, 0)
    await click('Restart and update')
    await wait(`document.body.textContent.includes('Persistence failed in controlled fixture')`)
    assert.equal(restartRequests, 0)
    assert.equal(service.getSnapshot().status, 'ready')
    await click('Restart and update')
    for (let count = 0; restartRequests === 0 && count < 200; count++) await setTimeout(25)
    assert.equal(restartRequests, 1)
    assert.equal(service.getSnapshot().status, 'restarting')
    assert.deepEqual(await readFile(join(downloadDirectory, file.name)), bytes)
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('DESKTOP_UPDATE_ELECTRON_OK: startup stale/partial cleanup -> real settings -> preload -> IPC -> worker -> HTTP stream -> cancel/retry -> remount -> clear cache preserves unknown files -> re-download -> persistence failure blocks restart -> retry requests restart; controlled release/network, persistence and installer boundaries')
  } finally { dispose(); await service.dispose(); win.destroy() }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1) })
