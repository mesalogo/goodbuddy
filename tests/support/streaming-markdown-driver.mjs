import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout } from 'node:timers/promises'

app.setPath('userData', join(process.env.GOODBUDDY_MARKDOWN_DIRECTORY, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1100, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message)
  })
  await win.loadURL(process.env.GOODBUDDY_MARKDOWN_URL)
  for (let i = 0; i < 600; i++) {
    if (await win.webContents.executeJavaScript('typeof window.streamingMarkdown === "function"')) break
    await setTimeout(25)
  }
  const result = await win.webContents.executeJavaScript('window.streamingMarkdown()')
  assert(result.prefixesChecked > 500)
  assert.equal(result.domChecks, result.prefixesChecked * 2)
  assert.equal(result.longAnswer.bytes, 102_400)
  assert.equal(result.longAnswer.prefixLengths.length, 6)
  assert.equal(result.longAnswer.samplesPerVariant, 18)
  assert.equal(result.longAnswer.domChecks, 24)
  assert.equal(result.longAnswer.finalDomEquivalent, true)
  assert.deepEqual(errors, [])
  console.log('Markdown ' + JSON.stringify({ electron: process.versions.electron,
    chromium: process.versions.chrome, ...result }))
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
