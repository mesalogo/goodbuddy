// Uses the same pinned SSH/stdio probe transport as story-graph-host-probe.ts.
// Desktop owns reopened SQLite; current-source Agent MCP writes the Linux file.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AgentImageToolMcp } from '../src/agent-daemon/image-tool-mcp'
import type { RuntimeProtocolBinaryChannel, RuntimeProtocolBinaryFrame } from '../src/main/remote-agent/protocol-remote-runtime-channel'
import { remoteImageToolSchema } from '../src/shared/remote-image-tool-contracts'

const emit = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function hostProbe(): Promise<void> {
  assert.equal(process.platform, 'linux')
  assert.equal(process.arch, 'x64')
  const root = await mkdtemp('/root/tmp/goodbuddy-image-save-')
  const lines = createInterface({ input: process.stdin })
  let adapter: AgentImageToolMcp | undefined
  let ready!: (value: { descriptor: unknown; sha256: string }) => void
  const initialized = new Promise<{ descriptor: unknown; sha256: string }>(resolve => { ready = resolve })
  lines.on('line', line => {
    const value = JSON.parse(line)
    if (value.descriptor) ready(value)
    else if (value.frame) adapter!.onReply(Buffer.from(value.frame, 'base64'))
  })
  const client = new Client({ name: 'image-save-host-probe', version: '1' })
  try {
    const initial = await initialized
    const descriptor = remoteImageToolSchema.parse(initial.descriptor)
    assert.equal(descriptor.description, undefined)
    adapter = new AgentImageToolMcp(descriptor, async payload => { emit({ frame: Buffer.from(payload).toString('base64') }) })
    await adapter.start()
    await client.connect(new StreamableHTTPClientTransport(new URL(adapter.url!)))
    const tools = (await client.listTools()).tools
    assert.deepEqual(tools.map(tool => tool.name), ['save_image'])
    assert.match(JSON.stringify(tools[0]!.inputSchema.properties), /conversation image\/upload references or generate_image results/)
    const images = JSON.parse(tools[0]!.description!.split('Conversation images (oldest first): ')[1]!)
    assert.equal(images.length, 1)
    const path = join(root, 'nested', 'saved.png')
    const result = await client.callTool({ name: 'save_image', arguments: { artifactId: images[0].artifactId, path } })
    assert.notEqual(result.isError, true)
    const bytes = await readFile(path)
    assert.equal(hash(bytes), initial.sha256)
    emit({ passed: true, platform: process.platform, arch: process.arch, bytes: bytes.length, sha256: hash(bytes), saveOnly: true, modelCalls: 0 })
  } finally {
    await client.close()
    adapter?.close()
    lines.close()
    process.stdin.pause()
    await rm(root, { recursive: true, force: true })
  }
}

async function desktopProbe(): Promise<void> {
  const { AssistantDatabase } = await import('../src/main/assistant/assistant-database')
  const { ImageGenerationService } = await import('../src/main/agent/image-generation-service')
  const { MainImageToolSession } = await import('../src/main/remote-agent/main-image-tool-session')
  const host = process.argv[2], remoteBundle = process.argv[3]
  assert(host && remoteBundle && /^\/root\/tmp\/[\w./-]+$/.test(remoteBundle), 'Expected SSH host and bundle in /root/tmp')
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-image-save-desktop-'))
  let database = new AssistantDatabase(join(root, 'assistant.sqlite'))
  database.initialize(root)
  const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(300 * 1024, 17)])
  const image = database.createImageArtifact({ title: 'Direct conversation image', mimeType: 'image/png', base64: bytes.toString('base64') })
  const context = { conversationId: randomUUID(), messageId: randomUUID(), requestId: randomUUID() }
  database.saveLocalConversations([{ header: { id: context.conversationId, title: 'Save probe', updatedAt: 1 }, messages: [
    { id: context.messageId, role: 'assistant', content: 'Direct image reply', createdAt: 1, state: 'complete', artifactIds: [image.id] }
  ] }])
  database.close()
  database = new AssistantDatabase(join(root, 'assistant.sqlite'))
  database.initialize(root)
  const service = new ImageGenerationService({ database, getSettings: async () => ({ modelProfiles: [] }) })
  const binding = service.bind(context)
  assert.equal(await binding.describe(), undefined)
  const descriptor = remoteImageToolSchema.parse({ channelId: 'image-save-probe', channelEpoch: '1', saveDescription: await binding.describeSave!() })
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', host,
    `TMPDIR=/root/tmp ELECTRON_RUN_AS_NODE=1 /opt/GoodBuddy/goodbuddy ${remoteBundle} --host`],
  { stdio: ['pipe', 'pipe', 'inherit'], signal: AbortSignal.timeout(60_000) })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  const queue: RuntimeProtocolBinaryFrame[] = []
  let receive: ((frame: RuntimeProtocolBinaryFrame) => void) | undefined
  let reject: ((error: Error) => void) | undefined
  const channel: RuntimeProtocolBinaryChannel = { channelId: descriptor.channelId, channelEpoch: descriptor.channelEpoch,
    send: async payload => { child.stdin.write(`${JSON.stringify({ frame: Buffer.from(payload).toString('base64') })}\n`) },
    receive: async () => queue.shift() ?? await new Promise((resolve, fail) => { receive = resolve; reject = fail }),
    close: () => reject?.(new Error('closed')), onClose: () => () => {} }
  const main = new MainImageToolSession(channel, binding)
  const lines = createInterface({ input: child.stdout })
  let passed = false, chunks = 0
  lines.on('line', line => {
    const value = JSON.parse(line)
    if (value.frame) {
      chunks++
      const frame = { payload: Buffer.from(value.frame, 'base64'), sequence: String(chunks), consume: async () => {} }
      if (receive) { const resolve = receive; receive = undefined; resolve(frame) } else queue.push(frame)
    } else if (value.passed) { passed = true; emit({ ...value, chunks, reopenedDesktopDatabase: true }) }
  })
  child.stdin.write(`${JSON.stringify({ descriptor, sha256: hash(bytes) })}\n`)
  try { assert.equal(await exited, 0); assert(passed); assert(chunks > 1) }
  finally {
    lines.close(); main.close(); child.kill()
    await service.dispose(); database.close()
    await rm(root, { recursive: true, force: true })
  }
}

void (process.argv[2] === '--host' ? hostProbe() : desktopProbe()).catch(error => { console.error(error); process.exitCode = 1 })
