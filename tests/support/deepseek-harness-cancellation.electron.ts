import { app, utilityProcess } from 'electron'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { DeepSeekHarnessRuntime } from '../../src/main/agent/deepseek-harness-runtime'
import { createDeepSeekHarnessUtilityLauncher } from '../../src/main/agent/deepseek-harness-utility-launcher'
const root = process.env.GB_DSH_FIXTURE_ROOT!
const work = join(root, 'work')
const node = process.env.GB_DSH_FIXTURE_NODE!
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (fn: () => Promise<boolean> | boolean) => {
  const end = Date.now() + 20_000
  while (!await fn()) { assert(Date.now() < end, 'wait timed out'); await new Promise(done => setTimeout(done, 25)) }
}
let calls = 0
const server = createServer(async (request, response) => {
  let text = ''; for await (const data of request) text += data
  const body = JSON.parse(text)
  calls++
  const key = JSON.stringify(body.messages).includes('cancel-parent') ? 'parent' : 'sibling'
  const done = body.messages.some((message: { role: string }) => message.role === 'tool')
  let command = process.platform === 'win32'
    ? `[System.IO.File]::WriteAllText('${join(work, `${key}.shell`)}', [string]$PID); Write-Output 'ps7' && Write-Output '\u4e2d\u6587' > '${join(work, `${key}.utf8`)}'; & '${node}' '${join(work, `${key}.cjs`)}'`
    : `printf '%s' "$$" > '${join(work, `${key}.shell`)}'; '${node}' '${join(work, `${key}.cjs`)}'`
  if (key === 'sibling') {
    const electronCommand = `'${process.execPath.replaceAll("'", "''")}' '${join(work, 'electron-user.cjs')}' --no-sandbox --user-data-dir='${join(root, 'user-electron-profile')}'`
    command = (process.platform === 'win32' ? `& ${electronCommand}; ` : `${electronCommand}; `) + command
  }
  const delta = done ? { role: 'assistant', content: 'DONE' } : { role: 'assistant', tool_calls: [{ index: 0, id: key, type: 'function', function: { name: process.platform === 'win32' ? 'pwsh' : 'bash', arguments: JSON.stringify({ command, description: 'Cancellation fixture' }) } }] }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const value of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] }]) response.write(`data: ${JSON.stringify({ id: key, object: 'chat.completion.chunk', model: 'fixture', ...value })}\n\n`)
  response.end('data: [DONE]\n\n')
})
async function main() {
  await app.whenReady()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const utilityPids: number[] = []
  const runtime = new DeepSeekHarnessRuntime({
    defaultWorkspace: work,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    model: 'fixture',
    credentialRefs: { GOODBUDDY_HARNESS_MODEL_API_KEY: 'local-fixture' },
    initializationTimeoutMs: 20_000,
    shutdownTimeoutMs: 5_000,
    launch: createDeepSeekHarnessUtilityLauncher({
      bundledHostPath: join(root, 'host.mjs'),
      dshHome: work,
      environment: process.env,
      fork(path, args, options) {
        const child = utilityProcess.fork(path, args, options)
        child.once('spawn', () => utilityPids.push(child.pid!))
        child.stderr?.on('data', data => process.stderr.write(data))
        return child
      }
    })
  })
  const collect = async (key: string, signal: AbortSignal) => {
    try {
      const events = []
      for await (const event of runtime.run({ requestId: key, conversationId: key, prompt: `cancel-${key}` }, signal)) events.push(event)
      return { events }
    } catch (error) {
      return { error: String(error) }
    }
  }
  let code = 1
  const pids = { parent: 0, parentShell: 0, sibling: 0, siblingShell: 0 }
  try {
    await writeFile(join(work, 'electron-user.cjs'), `const fs=require('node:fs');const {app}=require('electron');if(process.env.ELECTRON_RUN_AS_NODE!==undefined)throw Error('Node mode leaked');if(!app||process.type!=='browser')throw Error('Electron app mode changed');app.whenReady().then(()=>{fs.writeFileSync(${JSON.stringify(join(work, 'electron-mode.json'))},JSON.stringify({type:process.type,nodeModePresent:process.env.ELECTRON_RUN_AS_NODE!==undefined}));app.quit()});`)
    for (const [key, ms] of [['parent', 15_000], ['sibling', 3_000]] as const) {
      await writeFile(join(work, `${key}.cjs`), `const fs=require('node:fs');if(process.env.ELECTRON_RUN_AS_NODE!==undefined)throw Error('Node mode leaked');fs.writeFileSync(${JSON.stringify(join(work, `${key}.pid`))},String(process.pid));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(work, `${key}.finished`))},'done')},${ms});`)
    }
    const controller = new AbortController()
    const parent = collect('parent', controller.signal)
    const sibling = collect('sibling', AbortSignal.timeout(30_000))
    await until(async () => {
      try {
        for (const key of ['parent', 'sibling'] as const) {
          pids[key] = Number(await readFile(join(work, `${key}.pid`), 'utf8'))
          pids[`${key}Shell`] = Number(await readFile(join(work, `${key}.shell`), 'utf8'))
        }
        return true
      } catch { return false }
    })
    const start = Date.now()
    controller.abort(new Error('fixture cancellation'))
    const stopped = await parent
    assert(stopped.error)
    const callerMs = Date.now() - start
    const siblingAlive = alive(pids.sibling)
    assert(siblingAlive)
    await until(() => !alive(pids.parent) && !alive(pids.parentShell))
    const processExitMs = Date.now() - start
    const siblingResult = await sibling
    assert.equal(siblingResult.events?.at(-1)?.type, 'done')
    assert.equal(await readFile(join(work, 'sibling.finished'), 'utf8'), 'done')
    assert.deepEqual(JSON.parse(await readFile(join(work, 'electron-mode.json'), 'utf8')), { type: 'browser', nodeModePresent: false })
    if (process.platform === 'win32') assert.equal((await readFile(join(work, 'sibling.utf8'), 'utf8')).trim(), '\u4e2d\u6587')
    await assert.rejects(readFile(join(work, 'parent.finished')), { code: 'ENOENT' })
    const resumed = await collect('parent', AbortSignal.timeout(10_000))
    assert.equal(resumed.events?.at(-1)?.type, 'done')
    assert.equal(utilityPids.length, 1)
    console.log('DSH_UTILITY_RESULT', JSON.stringify({ callerMs, processExitMs, pids, siblingAlive, markerAbsent: true, siblingCompleted: true, resumed: true, hosts: utilityPids.length, modelCalls: calls, externalModelCalls: 0 }))
    code = 0
  } catch (error) {
    console.error(error)
  } finally {
    await runtime.dispose()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    await until(() => [...utilityPids, ...Object.values(pids)].every(pid => pid === 0 || !alive(pid)))
    console.log('DSH_UTILITY_CLEANUP', utilityPids.map(pid => ({ pid, alive: alive(pid) })))
    app.exit(code)
  }
}
void main().catch(error => { console.error(error); app.exit(1) })
