import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { SpeechSettingsStore } from '../../src/main/speech/speech-settings-store'
import { SpeechTranscriptionService } from '../../src/main/speech/speech-transcription-service'
import { registerSpeechTranscriptionIpc } from '../../src/main/speech/speech-transcription-ipc'

const directory = process.env.GB_SPEECH_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.GB_SPEECH_AUDIO!)
const live = Boolean(process.env.GB_SPEECH_LIVE_URL)
const received: boolean[] = []
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks).toString()
  assert.equal(request.url, '/v1/audio/transcriptions')
  assert.ok(body.includes('audio/wav'))
  const stream = body.includes('name="stream"\r\n\r\ntrue')
  received.push(stream)
  if (!stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text: '你好，普通识别。' })); return }
  response.setHeader('Content-Type', 'text/event-stream')
  response.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
  await delay(500)
  response.end('data: {"choices":[{"delta":{"content":"，流式识别。"}}]}\n\ndata: [DONE]\n\n')
})

void app.whenReady().then(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const cipher = { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value) }
  const store = new SpeechSettingsStore(join(directory, 'speech-settings.json'), cipher)
  const service = new SpeechTranscriptionService({ getSelectedRuntimeModel: async () => undefined }, undefined, store)
  const win = new BrowserWindow({ show: true, width: 1000, height: 900, webPreferences: {
    preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } })
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true))
  registerSpeechTranscriptionIpc(ipcMain.handle.bind(ipcMain), win, service, work => work)
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const wait = async (code: string, timeout = 15000): Promise<void> => {
    const until = Date.now() + timeout
    while (Date.now() < until) { if (await js(code)) return; await delay(50) }
    throw new Error(`Speech UI timeout: ${code}; ${await js('document.body.innerText')}`)
  }
  const clickText = (text: string) => js(`Array.from(document.querySelectorAll('button')).find(e => e.textContent.includes(${JSON.stringify(text)})).click()`)
  const fill = (selector: string, value: string) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  try {
    await win.loadURL(process.env.GB_SPEECH_URL!)
    await wait('!!document.querySelector("select")')
    await js(`(() => { const e = document.querySelector('select'); e.value='openai-compatible'; e.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await wait('!!document.querySelector("input[role=switch]")')
    assert.equal(await js('document.querySelector("input[role=switch]").checked'), false)
    await fill('input[placeholder="https://example.com/v1"]', process.env.GB_SPEECH_LIVE_URL ?? `http://127.0.0.1:${address.port}/v1`)
    await fill('input[placeholder="qwen3-asr-1.7b"]', process.env.GB_SPEECH_LIVE_MODEL ?? 'test-asr')
    if (process.env.GB_SPEECH_KEY_FILE) await fill('input[type=password]', (await readFile(process.env.GB_SPEECH_KEY_FILE, 'utf8')).trim())
    for (const streaming of [false, true]) {
      if (streaming) await js('document.querySelector("input[role=switch]").click()')
      await clickText('保存并录音测试')
      await wait('document.body.innerText.includes("结束录音并识别")')
      await delay(live ? 4000 : 400)
      await clickText('结束录音并识别')
      if (streaming && !live) await wait('document.body.innerText.includes("正在识别，完成后填入文本")')
      await wait('Array.from(document.querySelectorAll("p[role=status]")).some(e => e.textContent.includes(" s)"))', 45000)
      const result = await js('Array.from(document.querySelectorAll("p[role=status]")).map(e => e.textContent).join(" ")')
      assert.ok(result.includes('你好'), result)
      console.log(JSON.stringify({ mode: streaming ? 'stream' : 'json', result, live }))
    }
    const saved = await new SpeechSettingsStore(join(directory, 'speech-settings.json'), cipher).get()
    assert.equal(saved.settings.stream, true)
    assert.equal(saved.settings.provider, 'openai-compatible')
    if (!live) assert.deepEqual(received, [false, true])
    console.log('SPEECH_ELECTRON_OK')
    win.destroy(); service.dispose(); server.close(); app.exit(0)
  } catch (error) {
    console.error(error); win.destroy(); service.dispose(); server.close(); app.exit(1)
  }
})
