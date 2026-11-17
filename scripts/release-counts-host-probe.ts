// Current-source Linux Host probe. SSH carries synthetic model traffic only;
// provider credentials stay in the desktop-side relay and are never logged.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseEnv } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AgentImageToolMcp } from '../src/agent-daemon/image-tool-mcp'
import { ContinueHostAdapter, inspectContinueNativeConfiguration } from '../src/main/agent/continue-host-adapter'
import { decodeRemoteImageToolMessage, encodeRemoteImageToolMessage, remoteImageToolCallSchema } from '../src/shared/remote-image-tool-contracts'

const emit = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

async function hostProbe(): Promise<void> {
  assert.equal(process.platform, 'linux')
  const entry = process.argv[3]!
  const parent = process.env.TMPDIR
  assert(parent?.startsWith('/root/tmp/'), 'Use an owned Host temporary directory')
  const root = await mkdtemp(join(parent, 'counts-'))
  const lines = createInterface({ input: process.stdin })
  const pending = new Map<number, (reply: { status: number; body: string }) => void>()
  lines.on('line', line => {
    const reply = JSON.parse(line) as { id: number; status: number; body: string }
    pending.get(reply.id)?.(reply)
    pending.delete(reply.id)
  })
  let requests = 0
  let imageReferences = 0
  let saveCalls = 0
  const artifactId = randomUUID()
  const target = join(root, 'saved.png')
  const image = new AgentImageToolMcp({
    channelId: 'release-counts', channelEpoch: '1',
    description: 'Controlled image-input validation; no image provider is connected.',
    saveDescription: `Save the fixture image ${artifactId} as ${target}.`
  }, async bytes => {
    const call = remoteImageToolCallSchema.parse(decodeRemoteImageToolMessage(bytes))
    if ('name' in call && call.name === 'save_image_read') {
      assert.equal(call.input.artifactId, artifactId)
      assert.equal(call.input.offset, 0)
      saveCalls++
      image.onReply(encodeRemoteImageToolMessage({ callId: call.callId, imageChunk: {
        mimeType: 'image/png', totalBytes: png.length, offset: 0, data: png.toString('base64')
      } }))
    } else {
      assert(!('name' in call))
      assert.equal(call.input.sourceArtifactIds.length, 9)
      imageReferences = call.input.sourceArtifactIds.length
      image.onReply(encodeRemoteImageToolMessage({ callId: call.callId, error: 'Controlled stop before image provider' }))
    }
  })
  const client = new Client({ name: 'release-counts-probe', version: '1' })
  const inference = createServer((request, response) => {
    void (async () => {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text) as Record<string, unknown>
      assert(++requests <= 4, 'Model request budget exceeded')
      const id = requests
      const reply = new Promise<{ status: number; body: string }>(resolve => pending.set(id, resolve))
      emit({ id, inference: body })
      const result = await reply
      response.writeHead(result.status, { 'content-type': 'text/event-stream' }).end(result.body)
    })().catch(() => { response.writeHead(502).end('Probe model relay failed') })
  })
  let adapter: ContinueHostAdapter | undefined
  try {
    await image.start()
    await client.connect(new StreamableHTTPClientTransport(new URL(image.url!)))
    const inputCheck = await client.callTool({ name: 'generate_image', arguments: {
      intent: 'edit', prompt: 'Synthetic reference-list check', sourceArtifactIds: Array.from({ length: 9 }, () => randomUUID())
    } })
    assert.equal(inputCheck.isError, true)
    assert.equal(imageReferences, 9)
    assert.match(JSON.stringify(inputCheck.content), /Controlled stop before image provider/)
    const configPath = join(root, 'config.yaml')
    const rules = Array.from({ length: 201 }, (_, i) => ({ name: `rule-${i}`, rule: 'Be concise.' }))
    const prompts = Array.from({ length: 201 }, (_, i) => ({ name: `probe-${i}`, prompt: 'Reply briefly.' }))
    await writeFile(configPath, JSON.stringify({ name: 'Probe', version: '1.0.0', schema: 'v1', rules, prompts,
      mcpServers: Array.from({ length: 101 }, (_, i) => ({ name: `inactive-${i}`, disabled: true }))
    }))
    const inventory = await inspectContinueNativeConfiguration({ configPath, workspace: root })
    assert.equal(inventory.rules.length, 201)
    assert.equal(inventory.mcpServers.length, 101)
    // Native prompt inventory still has its pre-existing 200-row display window.
    // Runtime execution below independently loads all 201 configured prompts.
    await writeFile(configPath, JSON.stringify({ name: 'Probe', version: '1.0.0', schema: 'v1', rules, prompts }))
    await new Promise<void>(resolve => inference.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(inference.address() as { port: number }).port}`
    adapter = new ContinueHostAdapter({
      binaryPath: entry, configPath, workspace: root, cacheRoot: join(root, 'cache'), mode: 'agent',
      modelProfile: { id: randomUUID(), name: 'Release probe', modelName: 'release-probe',
        baseUrl: `${origin}/v1`, protocol: 'openai-chat-completions', authentication: 'none' },
      launchHost: (hostEntry, args, options) => {
        const child = Object.assign(spawn(process.execPath, [hostEntry, ...args],
          { ...options, detached: true, stdio: ['ignore', 'ignore', 'pipe'] }), { processGroup: true })
        child.stderr.on('data', data => {
          if (requests === 0) process.stderr.write(data)
        })
        return child
      }
    })
    const result = await adapter.run(
      `Use only save_image to save artifact ${artifactId} at ${target}. Then reply RELEASE_COUNTS_OK. Do not use generate_image or other tools.`,
      AbortSignal.timeout(120_000), async () => 'once', {
        sessionMcpServers: [{ name: 'release-images', type: 'streamable-http', url: image.url!, requestOptions: { headers: {} } }]
      })
    assert.match(result.text, /RELEASE_COUNTS_OK/)
    assert.equal(saveCalls, 1)
    assert.deepEqual(await readFile(target), png)
    emit({ passed: true, rules: rules.length, prompts: prompts.length, staticMcpEntries: inventory.mcpServers.length,
      imageReferences, saveCalls, requests, savedBytes: png.length, imageProviderCalls: 0 })
  } finally {
    await adapter?.dispose()
    await client.close()
    image.close()
    inference.closeAllConnections()
    inference.close()
    lines.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function desktopRelay(): Promise<void> {
  const [host, node, script, entry, envPath] = process.argv.slice(2)
  assert(host && node && script && entry && envPath, 'Expected SSH Host, Node, bundle, Continue entry and provider env file')
  const config = parseEnv(await readFile(envPath, 'utf8'))
  assert(config.DEEPSEEK_BASE_URL && config.DEEPSEEK_API_KEY && config.DEEPSEEK_MODEL, 'Provider configuration is incomplete')
  const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`
  const root = dirname(script)
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', host,
    `TMPDIR=${quote(root)} ${quote(node)} ${quote(script)} --host ${quote(entry)}`],
  { stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(180_000) })
  // The Host entry emits only bounded probe diagnostics, never provider bodies.
  child.stderr.on('data', chunk => { process.stderr.write(chunk) })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const lines = createInterface({ input: child.stdout })
  let calls = 0
  let passed = false
  const statuses: number[] = []
  lines.on('line', line => {
    const value = JSON.parse(line) as { id: number; inference?: Record<string, unknown>; passed?: boolean }
    if (!value.inference) { passed = value.passed === true; emit(value); return }
    void (async () => {
      assert(++calls <= 4, 'Paid request budget exhausted')
      const base = config.DEEPSEEK_BASE_URL!.replace(/\/+$/, '')
      const response = await fetch(base.endsWith('/chat/completions') ? base : `${base}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...value.inference, model: config.DEEPSEEK_MODEL, max_tokens: 512 }),
        signal: AbortSignal.timeout(90_000)
      })
      statuses.push(response.status)
      child.stdin.write(`${JSON.stringify({ id: value.id, status: response.status, body: await response.text() })}\n`)
    })().catch(() => { child.stdin.write(`${JSON.stringify({ id: value.id, status: 502, body: 'Provider relay failed' })}\n`) })
  })
  try { assert.equal(await exited, 0); assert(passed, 'Host probe did not complete') }
  finally { lines.close(); child.kill(); emit({ providerCalls: calls, providerStatuses: statuses }) }
}

void (process.argv[2] === '--host' ? hostProbe() : desktopRelay()).catch(error => {
  // Never print raw provider response bodies or credential-bearing configuration.
  console.error(error instanceof assert.AssertionError || process.argv[2] === '--host'
    ? error instanceof Error ? `${error.name}: ${error.message}` : 'Host probe failed'
    : 'Release Host probe failed')
  process.exitCode = 1
})
