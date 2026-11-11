import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { DeviceSharingService } from '../../src/main/device-sharing-service'
import { registerDeviceSharingIpc } from '../../src/main/device-sharing-ipc'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'
import { publishSharingModels, prepareAccountRegistration } from './sharing-model-fixture'

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
  const wait = async (code: string, attempts = 300): Promise<void> => {
    for (let count = 0; count < attempts; count++) { if (await js(code)) return; await setTimeout(25) }
    throw new Error(`Timed out: ${code}; ${errors.join('\n')}`)
  }
  const click = async (text: string): Promise<void> => {
    await wait(`[...document.querySelectorAll('button')].some(e => e.textContent === ${JSON.stringify(text)} && !e.disabled)`)
    const rect = await js(`(() => { const e = [...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 })
  }
  const field = async (label: string, value: string, tag = 'input'): Promise<void> => {
    await js(`(() => { const e = [...document.querySelectorAll('label')].find(e => e.querySelector('span')?.textContent === ${JSON.stringify(label)}).querySelector(${JSON.stringify(tag)}); Object.getOwnPropertyDescriptor(${tag === 'select' ? 'HTMLSelectElement' : tag === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('${tag === 'select' ? 'change' : 'input'}',{bubbles:true})); })()`)
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
    const account = await prepareAccountRegistration(process.env.GB_SHARING_URL!)
    await click('Register this device')
    await wait(`document.documentElement.dataset.notification.includes('Sharing HTTP 403')`)
    await click('Username and password')
    await field('Member username', account.username)
    await field('Member password', 'wrong-registration-password')
    await click('Register this device')
    await wait(`document.documentElement.dataset.notification.includes('Sharing HTTP 401') && !document.querySelector('input[type=password]').value`)
    await field('Member password', account.password)
    await click('Register this device')
    await wait(`document.body.textContent.includes('Device linked to member: Registration member') && document.querySelector('.device-sharing').getAttribute('aria-busy') === 'false'`)
    assert.equal(await js(`document.querySelector('input[type=password]').value`), '')
    assert.deepEqual(await account.ownedDeviceIds(), [(await service.getSettings()).deviceId])
    assert.equal((await new DeviceSharingService(file, 'restart').getCatalog()).authenticationMode, 'account')
    assert.equal((await readFile(file, 'utf8')).includes(account.password), false)
    assert.equal((await readFile(file + '.credentials', 'utf8')).includes(account.password), false)
    console.log('SHARING_ACCOUNT_REGISTRATION_OK: anonymous policy denial -> invalid password -> account binding -> password cleared -> persisted device proof and owner')
    if (process.env.GOODBUDDY_SHARING_MODEL_ENV) {
      win.setContentSize(1100, 850)
      await click('数字分身')
      await click('创建共享分身')
      await field('分身名称', 'Hosted GB persona')
      await field('角色与回答规则', 'You are a clearly labeled AI assistant. Reply with OK only.', 'textarea')
      const models = (await service.getPersonas()).models
      assert.ok(models.length)
      await field('服务器执行模型', models[0]!.id, 'select')
      await field('发布状态', 'published', 'select')
      await click('保存分身配置')
      await wait(`document.documentElement.dataset.notification === '分身配置已保存到服务器'`)
      await click('与分身对话')
      await field('向分身提问', 'Reply with OK only.', 'textarea')
      await click('发送问题')
      await wait(`document.querySelector('[aria-label="分身对话"]').textContent.includes('AI 回答')`, 2400)
      const personas = (await new DeviceSharingService(file, 'restart').getPersonas()).personas
      assert.equal(personas.length, 1)
      assert.equal(personas[0]!.origin, 'device')
      assert.equal(personas[0]!.execution, 'server')
      assert.equal(personas[0]!.sourceDeviceId, (await service.getSettings()).deviceId)
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.dataset.theme='${theme}'`)
        win.setContentSize(480, 700)
        await wait('window.innerWidth === 480')
        assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true, 'persona narrow overflow')
      }
      await click('撤回共享'); await click('确认撤回分身')
      await wait(`document.documentElement.dataset.notification === '分身已撤回'`)
      assert.equal((await service.getPersonas()).personas[0]!.status, 'revoked')
      await assert.rejects(service.chatPersona({ id: personas[0]!.id, message: 'Hello', requestId: crypto.randomUUID() }), /409/)
      console.log('SHARING_PERSONAS_OK: real UI -> preload -> Main -> server-hosted publication -> real model answer -> restarted client reads provenance -> withdrawal rejects chat; light/dark 480px; real text calls=1')
    }
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('SHARING_ELECTRON_OK: application center -> register -> knowledge/server metadata (search=true, read=false, download=true) -> revoke -> refresh; persisted identity; light/dark 480px; real ShareServer')
  } finally { dispose(); win.destroy() }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1) })
