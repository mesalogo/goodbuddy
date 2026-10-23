// Bundle as CJS and run on Linux with: <bundle> <owned-temp-root> <Continue cn.js>.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { runContinueAcpHelper } from './continue-acp-helper'
import { ModelBridgeBrokerServer } from './model-bridge-broker'

const entry = process.argv[1]!
const root = process.argv[2]!
const binary = process.argv[3]!
const helper = process.argv[4]
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function running(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch { return false }
}
async function until(check: () => Promise<boolean>, timeout = 20_000): Promise<void> {
  const start = Date.now()
  while (!await check()) { assert(Date.now() - start < timeout, 'Timed out'); await sleep(25) }
}

async function main() {
  if (helper) {
    process.exitCode = await runContinueAcpHelper({ socketPath: join(root, 'model-bridge.sock'),
      protocol: 'openai-chat-completions', model: 'probe', supportsImageInput: false, entrypoint: binary })
    return
  }
  await mkdir(root, { recursive: false, mode: 0o700 })
  let modelCalls = 0
  const broker = new ModelBridgeBrokerServer({ scratchDirectory: root, dispatch: async request => {
    modelCalls++
    const body = JSON.parse(Buffer.from(request.bodyBase64, 'base64').toString())
    const key = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === 'user')).includes('parent') ? 'parent' : 'sibling'
    const completed = body.messages.some((message: { role: string }) => message.role === 'tool')
    const delta = completed ? { content: 'COMPLETE' } : { tool_calls: [{ index: 0, id: key, type: 'function', function: {
      name: 'Bash', arguments: JSON.stringify({ command: `"${process.execPath}" "${join(root, key + '.cjs')}"` })
    } }] }
    const content = [ { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: completed ? 'stop' : 'tool_calls' }] } ]
      .map(value => `data: ${JSON.stringify({ id: key, object: 'chat.completion.chunk', model: 'probe', ...value })}\n\n`).join('') + 'data: [DONE]\n\n'
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bodyBase64: Buffer.from(content).toString('base64') }
  } })
  for (const [key, duration] of [['parent', 15000], ['sibling', 3000]] as const) {
    await writeFile(join(root, key + '.cjs'), `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(root, key + '.pid'))},String(process.pid));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(root, key + '.done'))},'done');console.log('FINISHED_${key}')},${duration})`)
  }
  await broker.listen()
  const child = spawn(process.execPath, [entry, root, binary, '--helper'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = new Promise(resolve => child.once('close', resolve))
  const connection = new ClientSideConnection(() => ({ sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }) }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
  const pids: number[] = []
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const parentSession = await connection.newSession({ cwd: root, mcpServers: [] })
    const siblingSession = await connection.newSession({ cwd: root, mcpServers: [] })
    const parent = connection.prompt({ sessionId: parentSession.sessionId, prompt: [{ type: 'text', text: 'parent' }] })
    const sibling = connection.prompt({ sessionId: siblingSession.sessionId, prompt: [{ type: 'text', text: 'sibling' }] })
    await until(async () => {
      try { pids[0] = Number(await readFile(join(root, 'parent.pid'), 'utf8')); pids[1] = Number(await readFile(join(root, 'sibling.pid'), 'utf8')); return true } catch { return false }
    })
    const start = Date.now()
    await connection.cancel({ sessionId: parentSession.sessionId })
    assert.equal((await parent).stopReason, 'cancelled')
    const cancelMs = Date.now() - start
    await until(async () => !await running(pids[0]!), 2000)
    assert(await running(pids[1]!), 'Sibling was terminated')
    assert.equal((await sibling).stopReason, 'end_turn')
    assert.equal(await readFile(join(root, 'sibling.done'), 'utf8'), 'done')
    await assert.rejects(readFile(join(root, 'parent.done')), { code: 'ENOENT' })
    assert(cancelMs < 5000, 'Cancellation waited for natural completion')
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, path: 'ACP -> ContinueHostAdapter -> Bash -> Node',
      cancelMs, descendantStopped: true, finishedNaturally: false, siblingCompleted: true, modelCalls, paidCalls: 0 }))
  } finally {
    child.stdin.end()
    await exited
    await broker.close()
    for (const pid of pids) assert(!await running(pid), `Fixture still running: ${pid}`)
    await rm(root, { recursive: true, force: true })
    console.log('CONTINUE_REMOTE_CLEANUP_OK')
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
