import { app, safeStorage, utilityProcess } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../../src/main/agent/deepseek-harness-runtime'
import { createDeepSeekHarnessUtilityLauncher } from '../../src/main/agent/deepseek-harness-utility-launcher'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'

const root = process.env.GB_DSH_RESUME_ROOT!
const phase = process.env.GB_DSH_RESUME_PHASE!
const work = join(root, '中文 workspace')
const home = join(root, 'home')
const marker = 'DSH_RESUME_8391'
const runtimes: DeepSeekHarnessRuntime[] = []
const children: Electron.UtilityProcess[] = []
let calls = 0
let lastMessages = ''
let secret = ''
const server = createServer(async (request, response) => {
  let text = ''
  for await (const data of request) text += data
  lastMessages = JSON.stringify(JSON.parse(text).messages)
  calls++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const choice of [
    { delta: { role: 'assistant', content: marker }, finish_reason: null },
    { delta: {}, finish_reason: 'stop' }
  ]) {
    response.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})

async function main() {
  await app.whenReady()
  await mkdir(work, { recursive: true })
  await mkdir(home, { recursive: true })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const liveSettings = process.env.GB_DSH_RESUME_SETTINGS
  let model = 'fixture'
  let baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  let apiKey = 'local-fixture'
  let requestHeaders: Record<string, string> | undefined
  if (liveSettings) {
    const snapshot = join(root, 'settings-snapshot.json')
    await copyFile(liveSettings, snapshot)
    const store = new RuntimeSettingsStore(snapshot, {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: () => { throw new Error('Read-only validation') },
      decrypt: value => safeStorage.decryptString(value)
    }, {})
    const settings = await store.getResolvedSettings()
    const profile = settings.modelProfiles.find(item => item.id === settings.deepseekHarnessModelProfile?.id && item.protocol === 'openai-chat-completions' && item.apiKey)
      ?? settings.modelProfiles.find(item => item.protocol === 'openai-chat-completions' && item.apiKey)
    assert(profile, `No readable Chat Completions model profile (encryption available: ${safeStorage.isEncryptionAvailable()}, profiles: ${JSON.stringify(settings.modelProfiles.map(item => ({ protocol: item.protocol, credentialReadable: Boolean(item.apiKey) })))})`)
    model = profile.modelName
    baseUrl = profile.baseUrl
    secret = apiKey = profile.apiKey!
    requestHeaders = profile.requestHeaders
  }
  function create() {
    const runtime = new DeepSeekHarnessRuntime({
      defaultWorkspace: work, baseUrl, model, requestHeaders,
      credentialRefs: { GOODBUDDY_HARNESS_MODEL_API_KEY: apiKey },
      initializationTimeoutMs: 20_000,
      launch: createDeepSeekHarnessUtilityLauncher({
        bundledHostPath: process.env.GB_DSH_RESUME_HOST!, dshHome: home,
        environment: process.env,
        fork(path, args, options) {
          const child = utilityProcess.fork(path, args, options)
          children.push(child)
          child.stderr?.on('data', data => {
            const text = String(data)
            process.stderr.write(secret ? text.replaceAll(secret, '[redacted]') : text)
          })
          return child
        }
      })
    })
    runtimes.push(runtime)
    return runtime
  }
  type History = { role: 'user' | 'assistant'; content: string }[]
  async function turn(runtime: DeepSeekHarnessRuntime, id: string, history?: History) {
    const events = []
    if (liveSettings) calls++
    const prompt = history
      ? 'Return only the marker from the earlier user message. Do not use tools.'
      : `Remember this marker and reply with only it: ${marker}. Do not use tools.`
    for await (const event of runtime.run({ requestId: `${id}-${calls}`, conversationId: id, prompt, history }, AbortSignal.timeout(50_000))) events.push(event)
    assert.equal(events.at(-1)?.type, 'done')
    assert(events.filter(event => event.type === 'text').map(event => event.delta).join('').includes(marker))
    return [{ role: 'user', content: prompt }, { role: 'assistant', content: marker }] satisfies History
  }
  try {
    if (phase === 'create') {
      const runtime = create()
      const history = await turn(runtime, 'old')
      if (!liveSettings) await turn(runtime, 'old')
      await writeFile(join(root, 'history.json'), JSON.stringify(history))
      assert.equal(children.length, 1)
    } else {
      const history = JSON.parse(await readFile(join(root, 'history.json'), 'utf8')) as History
      const old = create()
      await turn(old, 'old', history)
      if (!liveSettings) {
        assert(lastMessages.includes('<conversation-history>'))
        await turn(old, 'old', history)
        await turn(old, 'new-same-host')
        await turn(create(), 'new-fresh-host')
        await old.dispose()
        await turn(create(), 'old', history)
        assert(lastMessages.includes('<conversation-history>'))
        assert.equal(children.length, 3)
      }
    }
    console.log('DSH_RESUME_RESULT', JSON.stringify({ phase, status: 'passed', calls, hosts: children.length, externalModelCalls: liveSettings ? calls : 0 }))
  } finally {
    for (const runtime of runtimes) await runtime.dispose()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
}
void main().then(() => app.exit(0), error => {
  const message = String(error)
  console.error(secret ? message.replaceAll(secret, '[redacted]') : message)
  for (const child of children) child.kill()
  app.exit(1)
})
