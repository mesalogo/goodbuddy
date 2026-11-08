import { app, net, safeStorage } from 'electron'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { RuntimeSettingsStore } from '../../src/main/runtime-settings-store'

// Run as an Electron Main entry after bundling with electron/esbuild external.
// On Windows, prepare an isolated GB_PROBE_ELECTRON_DATA directory with a copy
// of the source profile's encrypted Local State before launching Electron.
// Remove that directory afterwards; never print settings or decrypted keys.
const exec = promisify(execFile)
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
let calls = 0
let stage = 'settings'
const secrets: string[] = []
if (process.env.GB_PROBE_ELECTRON_DATA) app.setPath('userData', process.env.GB_PROBE_ELECTRON_DATA)

void app.whenReady().then(async () => {
  const host = process.env.GB_PROBE_HOST!
  const installed = process.env.GB_PROBE_INSTALLED_AGENT!
  const runtimeRoot = process.env.GB_PROBE_RUNTIME_ROOT!
  assert(host && installed && runtimeRoot && process.env.GB_PROBE_SETTINGS)
  const parent = resolve('temp/real-task-progress')
  await mkdir(parent, { recursive: true })
  const local = await mkdtemp(join(parent, 'run-'))
  const remote = `/root/tmp/goodbuddy-recovery-validation/real-${randomUUID()}`
  let child: ReturnType<typeof spawn> | undefined
  let server: ReturnType<typeof createServer> | undefined
  let remoteCreated = false
  try {
    const snapshot = join(local, 'settings.json')
    await copyFile(process.env.GB_PROBE_SETTINGS!, snapshot)
    const store = new RuntimeSettingsStore(snapshot, {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: () => { throw new Error('Read-only model validation') },
      decrypt: value => safeStorage.decryptString(value)
    }, process.env)
    const settings = await store.getResolvedSettings().finally(() => unlink(snapshot))
    const profile = settings.modelProfiles.find(item => item.id === settings.defaultModelProfileId)
    assert(profile, 'Default model profile is required')
    secrets.push(profile.apiKey ?? '', profile.baseUrl, ...Object.values(profile.requestHeaders ?? {}))
    assert(profile.protocol === 'openai-responses' || profile.protocol === 'openai-chat-completions', 'Probe requires an OpenAI-compatible default model')
    assert(profile.authentication === 'none' || profile.apiKey, 'Model credential is missing')
    console.log(JSON.stringify({ stage, model: profile.modelName, protocol: profile.protocol, requestBudget: 2 }))
    server = createServer((request, response) => {
      void (async () => {
        assert(calls < 2, 'Real-model request budget exceeded')
        const route = request.url?.replace(/^\/v1/, '')
        assert(route === '/responses' || route === '/chat/completions', 'Unexpected model route')
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const headers = new Headers(profile.requestHeaders)
        headers.set('content-type', 'application/json')
        if (profile.authentication !== 'none' && !headers.has('authorization')) headers.set('authorization', `Bearer ${profile.apiKey}`)
        calls++
        console.log(JSON.stringify({ stage: 'provider-request', realModelCalls: calls }))
        const upstream = await net.fetch(`${profile.baseUrl.replace(/\/$/, '')}${route}`, {
          method: 'POST', headers, body: JSON.stringify({ ...body, ...profile.requestBody, model: profile.modelName }),
          signal: AbortSignal.timeout(90_000)
        })
        console.log(JSON.stringify({ stage: 'provider-response', call: calls, status: upstream.status }))
        const bytes = Buffer.from(await upstream.arrayBuffer())
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' })
        response.end(bytes)
      })().catch(error => {
        let message = error instanceof Error ? error.message : 'unknown'
        for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[redacted]')
        console.error(JSON.stringify({ stage: 'provider-error', realModelCalls: calls, message: message.slice(0, 300) }))
        response.writeHead(502); response.end('Validation provider request failed')
      })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    stage = 'build'
    await build({ entryPoints: ['scripts/remote-recovery-host-probe.ts'], outfile: join(local, 'probe.cjs'),
      bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi'] })
    await build({ stdin: { contents: "import { runAgentCli } from './src/agent-daemon/cli'; void runAgentCli(process.argv.slice(2)).then(code => { process.exitCode = code }, () => { process.exitCode = 2 })", resolveDir: process.cwd(), loader: 'ts' },
      outfile: join(local, 'agent.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi'] })
    await writeFile(join(local, 'goodbuddy-agent'), `#!/bin/sh\nexec ${quote(`${remote}/node`)} ${quote(`${remote}/lib/agent.cjs`)} "$@"\n`)
    stage = 'host-setup'
    await exec('ssh', ['-o', 'BatchMode=yes', host, `test -d /root/tmp && mkdir -p ${quote(`${remote}/lib`)}`])
    remoteCreated = true
    await exec('scp', [join(local, 'probe.cjs'), join(local, 'goodbuddy-agent'), `${host}:${remote}/`])
    await exec('scp', [join(local, 'agent.cjs'), `${host}:${remote}/lib/agent.cjs`])
    await exec('ssh', ['-o', 'BatchMode=yes', host, `cp ${quote(`${installed}/node`)} ${quote(`${remote}/node`)} && chmod 700 ${quote(`${remote}/goodbuddy-agent`)}`])
    const port = 20000 + Math.floor(Math.random() * 20000)
    const command = `NODE_PATH=${quote(`${installed}/lib/node_modules`)} GB_PROBE_RUNTIME_ROOT=${quote(runtimeRoot)} GB_PROBE_AGENT_EXECUTABLE=${quote(`${remote}/goodbuddy-agent`)} GB_PROBE_MODEL_NAME=${quote(profile.modelName)} GB_PROBE_MODEL_PROTOCOL=${quote(profile.protocol)} GB_PROBE_MODEL_URL=${quote(`http://127.0.0.1:${port}`)} ${quote(`${remote}/node`)} ${quote(`${remote}/probe.cjs`)} --real-model`
    stage = 'real-recovery-and-followup'
    console.log(JSON.stringify({ stage, realModelCalls: calls }))
    child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${port}:127.0.0.1:${address.port}`, host, command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    child.stdout!.on('data', chunk => { output += String(chunk) })
    child.stderr!.on('data', chunk => { errors += String(chunk) })
    const timer = setTimeout(() => child?.kill(), 240_000)
    const code = await new Promise<number | null>((resolve, reject) => { child!.once('close', resolve); child!.once('error', reject) }).finally(() => clearTimeout(timer))
    assert.equal(code, 0, `Host validation failed: ${errors.slice(-1500)}`)
    const result = JSON.parse(output.trim().split('\n').at(-1)!)
    assert.equal(result.passed, true)
    assert.equal(result.followupCompleted, true)
    assert.equal(calls, 2)
    console.log(JSON.stringify({ ...result, stage: 'passed', actualProviderCalls: calls, model: profile.modelName }))
  } finally {
    child?.kill()
    server?.closeAllConnections()
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
    if (remoteCreated) await exec('ssh', ['-o', 'BatchMode=yes', host, `if pgrep -f ${quote(`^${remote}/node`)}; then exit 1; else rm -rf -- ${quote(remote)}; fi`])
    await rm(local, { recursive: true, force: true })
    console.log(JSON.stringify({ stage: 'cleaned', realModelCalls: calls }))
  }
  app.exit(0)
}).catch(error => {
  let message = error instanceof Error ? error.message : 'unknown'
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[redacted]')
  console.error(JSON.stringify({ stage, realModelCalls: calls, message: message.slice(0, 1800) }))
  app.exit(1)
})
