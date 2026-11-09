import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { ChannelSettingsStore } from '../../src/main/channels/channel-settings-store'
import { ChannelManager } from '../../src/main/channels/channel-manager'
import { createDingTalkRegistration } from '../../src/main/channels/dingtalk-registration'
import { registerDingTalkRegistrationIpc } from '../../src/main/channels/dingtalk-registration-ipc'
import { ipcChannels } from '../../src/shared/ipc-channels'
import { defaultRuntimeSettings } from '../../src/shared/contracts'

const directory = process.env.GB_DINGTALK_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.setPath('sessionData', join(directory, 'session'))
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: {
    preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } })
  const path = join(directory, 'channels.json')
  const store = new ChannelSettingsStore(path, { isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) }, {})
  let started = 0
  const manager = new ChannelManager(store, async () => { throw new Error('No message execution in this test') }, {
    createDriver: settings => ({ channel: settings.channel, start: async () => { started++ }, stop: async () => undefined, send: async () => undefined })
  })
  let success = false
  const controller = createDingTalkRegistration(manager, state => window.webContents.send(ipcChannels.dingtalkRegistrationChanged, state), async input => {
    assert(String(input).startsWith('https://oapi.dingtalk.com/app/registration/'))
    return new Response(JSON.stringify({ errcode: 0, ...(String(input).endsWith('/init') ? { nonce: 'test-nonce' }
      : String(input).endsWith('/begin') ? { device_code: 'test-device', verification_uri_complete: 'https://login.dingtalk.com/test', interval: 0.05, expires_in: 30 }
        : success ? { status: 'SUCCESS', client_id: 'ding-electron-fixture', client_secret: 'dingtalk-electron-fixture-secret' } : { status: 'WAITING' }) }))
  })
  registerDingTalkRegistrationIpc((channel, handler) => ipcMain.handle(channel, handler), window, controller)
  ipcMain.handle(ipcChannels.channelSettingsGet, () => manager.getSnapshot())
  ipcMain.handle(ipcChannels.runtimeSettingsGet, () => ({ ...defaultRuntimeSettings, secureStorageAvailable: true }))
  const run = <T = unknown>(script: string): Promise<T> => window.webContents.executeJavaScript(script, true)
  async function wait(check: () => Promise<unknown> | unknown): Promise<void> {
    for (let i = 0; i < 200; i++) { if (await check()) return; await delay(50) }
    throw new Error(`Timed out: ${await run('document.body.innerText')}`)
  }
  const click = async (text: string): Promise<void> => {
    await run(`[...document.querySelectorAll('button')].find(e => e.textContent.includes(${JSON.stringify(text)})).click()`)
  }
  try {
    await window.loadURL(process.env.GB_DINGTALK_RENDERER!)
    await wait(() => run(`document.body.innerText.includes('扫码创建钉钉机器人')`))
    await click('扫码创建钉钉机器人')
    await wait(() => run(`!!document.querySelector('img[alt="钉钉机器人授权二维码"]')`))
    assert.equal(controller.snapshot().state, 'waiting')
    await click('取消扫码')
    await wait(() => controller.snapshot().state === 'idle')
    await wait(() => run(`document.body.innerText.includes('扫码创建钉钉机器人')`))
    success = true
    await click('扫码创建钉钉机器人')
    await wait(() => run(`!![...document.querySelectorAll('input')].find(e => e.value === 'ding-electron-fixture')`))
    assert.equal(controller.snapshot().state, 'completed')
    assert.equal(started, 1)
    assert.equal((await store.resolve('dingtalk')).enabled, true)
    assert(!(await readFile(path, 'utf8')).includes('dingtalk-electron-fixture-secret'))
    assert(!(await run<string>('document.body.innerText')).includes('dingtalk-electron-fixture-secret'))
    await run(`[...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === '消息').click()`)
    await wait(() => run(`!!document.querySelector('textarea[aria-label="钉钉允许的发送者 ID"]')`))
    await run(`(() => { const e=document.querySelector('textarea[aria-label="钉钉允许的发送者 ID"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'draft-staff');e.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await run(`[...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === '连接').click()`)
    await wait(() => run(`document.body.innerText.includes('扫码创建钉钉机器人')`))
    await run(`[...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === '消息').click()`)
    await wait(() => run(`document.querySelector('textarea[aria-label="钉钉允许的发送者 ID"]')?.value === 'draft-staff'`))
    console.log(JSON.stringify({ dingtalkRegistrationSmoke: 'passed' }))
  } finally { await controller.dispose(); await manager.stopAll(); window.destroy() }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
