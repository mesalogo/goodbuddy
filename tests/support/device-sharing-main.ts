import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { DeviceSharingService } from '../../src/main/device-sharing-service'
import { registerDeviceSharingIpc } from '../../src/main/device-sharing-ipc'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { publishSharingModels } from './sharing-model-fixture'

const directory = process.env.GB_SHARING_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
void app.whenReady().then(async () => {
  const file = join(directory, 'sharing-settings.json')
  const modelSettings = new RuntimeSettingsStore(join(directory, 'models.json'), {
    isAvailable: () => false, encrypt: () => { throw new Error('No credential writes in this fixture') }, decrypt: () => { throw new Error('No stored credentials') }
  }, {})
  const service = new DeviceSharingService(file, 'electron-smoke', 10000, modelSettings)
  await service.saveSettings({ name: 'Sharing smoke device', serverUrl: process.env.GB_SHARING_URL! })
  const win = new BrowserWindow({ show: true, width: 1100, height: 850, webPreferences: {
    preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false
  } })
  const dispose = registerDeviceSharingIpc(win, service)
  const errors: string[] = []
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const wait = async (code: string): Promise<void> => {
    for (let count = 0; count < 300; count++) { if (await js(code)) return; await setTimeout(25) }
    throw new Error(`Timed out: ${code}; ${errors.join('\n')}`)
  }
  const click = async (text: string): Promise<void> => {
    await wait(`[...document.querySelectorAll('button')].some(e => e.textContent === ${JSON.stringify(text)} && !e.disabled)`)
    const rect = await js(`(() => { const e = [...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 })
  }
  const field = async (label: string, value: string, tag = 'input'): Promise<void> => {
    await js(`(() => { const e = [...document.querySelectorAll('label')].find(e => e.querySelector('span')?.textContent === ${JSON.stringify(label)}).querySelector(${JSON.stringify(tag)}); Object.getOwnPropertyDescriptor(${tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('${tag === 'select' ? 'change' : 'input'}',{bubbles:true})); })()`)
  }
  try {
    await win.loadURL(process.env.GB_SHARING_RENDERER!)
    await wait(`!![...document.querySelectorAll('article')].find(e => e.textContent.includes('Device Sharing'))`)
    assert.equal(await js(`[...document.querySelectorAll('article')].find(e=>e.textContent.includes('Device Sharing')).querySelector('button').disabled`), true)
    await js(`document.querySelector('[aria-label="Device Sharing (Technical Preview) Application settings"]').click()`)
    await wait(`!!document.querySelector('input[role="switch"]')`)
    assert.equal(await js(`document.querySelector('input[role="switch"]').checked`), false)
    await js(`document.querySelector('input[role="switch"]').click()`)
    await wait(`document.querySelector('input[role="switch"]').checked`)
    await js(`document.querySelector('[aria-label="Back to application center"]').click()`)
    await wait(`!![...document.querySelectorAll('article')].find(e => e.textContent.includes('Device Sharing'))`)
    await js(`[...document.querySelectorAll('article')].find(e=>e.textContent.includes('Device Sharing')).querySelector('button').click()`)
    await click('Register this device')
    await wait(`!!document.querySelector('#sharing-devices + article') || document.querySelector('[aria-labelledby="sharing-devices"]').textContent.includes('Sharing smoke device')`)
    await field('Entry name', 'Smoke knowledge')
    await field('Kind', 'knowledge', 'select')
    await field('Source mode', 'server', 'select')
    await wait(`document.querySelectorAll('input[type=checkbox]').length === 3`)
    await js(`document.querySelectorAll('input[type=checkbox]')[0].click(); document.querySelectorAll('input[type=checkbox]')[2].click()`)
    await click('Publish metadata')
    await wait(`document.querySelector('[aria-labelledby="sharing-publications"]').textContent.includes('Smoke knowledge')`)
    let catalog = await service.getCatalog()
    assert.equal(catalog.devices.length, 1)
    assert.equal(catalog.publications.length, 1)
    assert.deepEqual(catalog.publications[0]!.permissions, { search: true, read: false, download: true })
    assert.equal(catalog.publications[0]!.sourceMode, 'server')
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.theme='${theme}'`)
      win.setContentSize(480, 700)
      await wait('window.innerWidth === 480')
      assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true, 'narrow layout overflow')
    }
    await click('Revoke publication')
    await click('Confirm revocation')
    await wait(`document.querySelector('[aria-labelledby="sharing-publications"]').textContent.includes('Revoked')`)
    await click('Refresh lists')
    await wait(`!document.querySelector('.device-sharing').getAttribute('aria-busy') || document.querySelector('.device-sharing').getAttribute('aria-busy') === 'false'`)
    catalog = await service.getCatalog()
    assert.equal(catalog.publications[0]!.status, 'revoked')
    assert.deepEqual(await new DeviceSharingService(file, 'restart').getSettings(), await service.getSettings())
    const keys = await publishSharingModels(directory, process.env.GB_SHARING_URL!, (await service.getSettings()).deviceId)
    const before = await modelSettings.getPublicSettings()
    await click('Get model configurations')
    await wait(`document.querySelector('[aria-labelledby="sharing-models"]').querySelectorAll('article').length === 2`)
    for (let index = 0; index < 2; index++) {
      await js(`document.querySelector('[aria-labelledby="sharing-models"]').querySelectorAll('article')[${index}].querySelector('button').click()`)
      await wait(`document.documentElement.dataset.notification === 'Model imported. Enter an API key and test the connection in model settings.' && document.querySelector('[aria-labelledby="sharing-models"]').getAttribute('aria-busy') === 'false'`)
    }
    await click('Import model')
    await wait(`document.documentElement.dataset.notification === 'This model is already imported. Local settings were preserved.'`)
    const after = await modelSettings.getPublicSettings()
    assert.equal(after.defaultModelProfileId, before.defaultModelProfileId)
    assert.equal(after.modelProfiles.length, before.modelProfiles.length + 2)
    const imported = after.modelProfiles.filter(item => !before.modelProfiles.some(old => old.id === item.id))
    let calls = 0
    for (const profile of imported) {
      const key = [...keys].find(([name]) => profile.name.startsWith(name))?.[1]
      if (!key) continue
      calls++
      const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: profile.modelName, messages: [{ role: 'user', content: 'Reply with OK only.' }], max_tokens: 16, stream: false }),
        signal: AbortSignal.timeout(60000) })
      assert.equal(response.ok, true, `Imported model HTTP ${response.status}`)
      const result = await response.json() as { choices?: { message?: { content?: string } }[] }
      assert.ok(result.choices?.[0]?.message?.content)
    }
    console.log(`SHARING_MODEL_IMPORT_OK: real UI -> preload -> Main -> authenticated Server -> persistent model settings; duplicate preserved; real text calls=${calls}`)
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('SHARING_ELECTRON_OK: application center -> register -> knowledge/server metadata (search=true, read=false, download=true) -> revoke -> refresh; persisted identity; light/dark 480px; real ShareServer')
  } finally { dispose(); win.destroy() }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1) })
