// Bundle with esbuild (Node/CJS, ACP SDK ESM entry). Run on Linux:
// node probe.cjs <dedicated /root/tmp/goodbuddy-* root> <Continue cn.js> [helper bundle]
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { runContinueAcpHelper } from './continue-acp-helper'
import { ModelBridgeBrokerServer } from './model-bridge-broker'

const root = resolve(process.argv[2]!)
const binary = resolve(process.argv[3]!)
const answer = 'CONTINUE_WRITE_PROBE_OK'
async function size(path: string): Promise<number> {
  const entry = await stat(path)
  if (!entry.isDirectory()) return entry.size
  return (await Promise.all((await readdir(path)).map(name => size(join(path, name))))).reduce((a, b) => a + b, 0)
}
async function io(pid: number): Promise<Record<string, number>> {
  return Object.fromEntries((await readFile(`/proc/${pid}/io`, 'utf8')).trim().split('\n').map(line => {
    const [key, value] = line.split(':')
    return [key, Number(value)]
  }))
}
async function main(): Promise<void> {
  assert(root.startsWith('/root/tmp/goodbuddy-'))
  if (process.argv[4] === '--helper') {
    process.exitCode = await runContinueAcpHelper({ socketPath: join(root, 'model-bridge.sock'),
      protocol: 'openai-chat-completions', model: 'probe', supportsImageInput: false, entrypoint: binary })
    return
  }
  await mkdir(root, { recursive: false, mode: 0o700 })
  const lifecycle = process.env.PROBE_LIFECYCLE
  let requested!: () => void
  const modelRequested = new Promise<void>(resolve => { requested = resolve })
  let calls = 0
  const broker = new ModelBridgeBrokerServer({ scratchDirectory: root, dispatch: async (_request, context) => {
    calls++
    requested()
    if (lifecycle) await new Promise<void>(resolve => {
      if (context.signal.aborted) resolve()
      else context.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    const content = [{ content: answer }, {}].map((delta, index) => `data: ${JSON.stringify({
      id: 'probe', object: 'chat.completion.chunk', model: 'probe',
      choices: [{ index: 0, delta, finish_reason: index ? 'stop' : null }]
    })}\n\n`).join('') + 'data: [DONE]\n\n'
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bodyBase64: Buffer.from(content).toString('base64') }
  } })
  try {
    await broker.listen()
    for (let iteration = 0; iteration < (lifecycle ? 1 : 2); iteration++) {
      const beforeBytes = await size(root)
      const child = spawn(process.execPath, [process.argv[4] ?? process.argv[1]!, root, binary, '--helper'], {
        stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: root, HOME: root,
          XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data') }
      })
      const exited = new Promise<number | null>(resolve => child.once('close', resolve))
      let text = ''
      const connection = new ClientSideConnection(() => ({
        sessionUpdate: async ({ update }) => {
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') text += update.content.text
        }, requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } })
      }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
      let counters: Record<string, number> = {}
      let activeBytes = 0
      const start = performance.now()
      try {
        await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        const session = await connection.newSession({ cwd: root, mcpServers: [] })
        const pending = connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply CONTINUE_WRITE_PROBE_OK. Do not use tools.' }] })
        if (lifecycle) {
          await modelRequested
          const descendants = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
          assert(descendants.length > 0)
          if (lifecycle === 'SIGTERM') child.kill('SIGTERM')
          else await connection.cancel({ sessionId: session.sessionId })
          assert.equal((await pending).stopReason, 'cancelled')
          for (const pid of descendants) await assert.rejects(stat(`/proc/${pid}`), { code: 'ENOENT' })
          const cache = join(root, 'cache', 'goodbuddy', 'continue-host')
          const entries = await readdir(cache)
          assert(entries.some(name => name.startsWith('host-v')))
          assert(!entries.some(name => name.startsWith('goodbuddy-continue-') || name.includes('.staging-')))
          console.log(JSON.stringify({ lifecycle, descendantsStopped: true, promptFilesRemoved: true, sharedCacheRetained: true }))
          continue
        }
        const result = await pending
        assert.equal(result.stopReason, 'end_turn')
        assert.equal(text, answer)
        counters = await io(child.pid!)
        activeBytes = await size(root)
      } finally {
        child.stdin.end()
        assert.equal(await exited, 0)
      }
      console.log(JSON.stringify({ iteration, elapsedMs: performance.now() - start, beforeBytes, activeBytes,
        retainedBytes: await size(root), io: counters, exactAnswer: text === answer }))
    }
    assert.equal(calls, lifecycle ? 1 : 2)
  } finally {
    await broker.close()
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
