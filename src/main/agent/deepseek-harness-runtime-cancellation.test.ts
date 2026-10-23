// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import electron from 'electron'
import { build } from 'esbuild'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekHarnessRuntime } from './deepseek-harness-runtime'
import { createBoundedNdJsonStream, startControlledDeepSeekHarnessHost } from '../deepseek-harness-host'

it('cancels the owned shell and descendant while a sibling completes on the same Host', async () => {
  const parent = resolve('temp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'dsh-cancellation-'))
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, root)
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  let hosts = 0
  const runtime = new DeepSeekHarnessRuntime({
    defaultWorkspace: root, baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture',
    credentialRefs: { GOODBUDDY_HARNESS_MODEL_API_KEY: 'unused' },
    initializationTimeoutMs: 20_000, shutdownTimeoutMs: 5_000,
    async launch(options) {
      hosts++
      const input = new TransformStream<Uint8Array, Uint8Array>()
      const output = new TransformStream<Uint8Array, Uint8Array>()
      let resolveExit!: (result: { exitCode: number }) => void
      const exited = new Promise<{ exitCode: number }>(resolve => { resolveExit = resolve })
      const host = await startControlledDeepSeekHarnessHost({
        workspace: root, dshHome: root, baseUrl: options.baseUrl,
        api: 'openai-completions', provider: 'goodbuddy', model: options.model,
        harnessVersion: '0.2.1-rc.2', credentialRefs: options.credentialRefs,
        skillPackages: [], stream: createBoundedNdJsonStream(output.writable, input.readable, 8 * 1024 * 1024)
      })
      host.context.on('llm/stream', async function* (body): AsyncIterable<StreamChunk> {
        const key = JSON.stringify(body.messages).includes('cancel-parent') ? 'parent' : 'sibling'
        if (body.messages.some(message => message.role === 'tool')) {
          yield { type: 'text-delta', index: 0, text: 'DONE' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const script = join(root, `${key}.cjs`)
        const shellPid = join(root, `${key}.shell`)
        const command = process.platform === 'win32'
          ? `[System.IO.File]::WriteAllText('${shellPid}', [string]$PID); & '${process.execPath}' '${script}'`
          : `printf '%s' "$$" > '${shellPid}'; '${process.execPath}' '${script}'`
        const block = { type: 'tool-call' as const, id: ToolCallId(key), name: process.platform === 'win32' ? 'pwsh' : 'bash', arguments: JSON.stringify({ command, description: 'Lifecycle fixture' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }, { global: true, prepend: true })
      return {
        stdin: input.writable, stdout: output.readable, exited,
        async terminate() { await host.dispose(); resolveExit({ exitCode: 0 }) }
      }
    }
  })
  const collect = async (key: string, signal: AbortSignal) => {
    const events = []
    try {
      for await (const event of runtime.run({ requestId: key, conversationId: key, prompt: `cancel-${key}` }, signal)) events.push(event)
      return { events, error: undefined }
    } catch (error) { return { events, error } }
  }
  try {
    for (const [key, duration] of [['parent', 15_000], ['sibling', 3_000]] as const) {
      await writeFile(join(root, `${key}.cjs`), `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(root, `${key}.pid`))},String(process.pid));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(root, `${key}.finished`))},'done')},${duration});`)
    }
    const controller = new AbortController()
    const stopped = collect('parent', controller.signal)
    const sibling = collect('sibling', AbortSignal.timeout(30_000))
    const pids = { parent: 0, parentShell: 0, sibling: 0, siblingShell: 0 }
    await vi.waitFor(async () => {
      for (const key of ['parent', 'sibling'] as const) {
        pids[key] = Number(await readFile(join(root, `${key}.pid`), 'utf8'))
        pids[`${key}Shell`] = Number(await readFile(join(root, `${key}.shell`), 'utf8'))
      }
    }, { timeout: 20_000 })
    const start = Date.now()
    controller.abort(new Error('fixture stop'))
    expect((await stopped).error).toBeDefined()
    console.log('DSH cancellation', { ms: Date.now() - start, pids })
    expect(alive(pids.sibling)).toBe(true)
    await vi.waitFor(() => {
      expect(alive(pids.parent)).toBe(false)
      expect(alive(pids.parentShell)).toBe(false)
    }, { timeout: 5_000 })
    const siblingResult = await sibling
    expect(siblingResult.error).toBeUndefined()
    expect(siblingResult.events.at(-1)?.type).toBe('done')
    expect(await readFile(join(root, 'sibling.finished'), 'utf8')).toBe('done')
    await expect(readFile(join(root, 'parent.finished'))).rejects.toMatchObject({ code: 'ENOENT' })
    const resumed = await collect('parent', AbortSignal.timeout(10_000))
    expect(resumed.error).toBeUndefined()
    expect(resumed.events.at(-1)?.type).toBe('done')
    expect(hosts).toBe(1)
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    vi.unstubAllEnvs()
  }
}, 40_000)

it.skipIf(process.platform !== 'win32')('preserves selected PowerShell 7 syntax, UTF-8 redirection and native streams', async () => {
  const parent = resolve('temp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'dsh-powershell-encoding-'))
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, root)
  let host: Awaited<ReturnType<typeof startControlledDeepSeekHarnessHost>> | undefined
  try {
    host = await startControlledDeepSeekHarnessHost({
      workspace: root, dshHome: root, baseUrl: 'http://127.0.0.1:1/v1',
      api: 'openai-completions', provider: 'goodbuddy', model: 'fixture',
      harnessVersion: '0.2.1-rc.2', credentialRefs: ['GOODBUDDY_HARNESS_MODEL_API_KEY'],
      skillPackages: [],
      stream: { readable: new TransformStream().readable, writable: new WritableStream() }
    })
    const text = '\u4e2d\u6587\u00e9\ud83d\ude42'
    const nativeScript = join(root, 'unicode.cjs')
    const redirected = join(root, 'redirected.txt')
    await writeFile(nativeScript, `process.stdin.setEncoding('utf8');process.stdin.on('data',s=>process.stdout.write('stdin:'+s));process.stdout.write(${JSON.stringify(`native:${text}\n`)});process.stderr.write(${JSON.stringify(`native-error:${text}\n`)});`)
    const command = [
      'Write-Output ("version:" + $PSVersionTable.PSVersion.ToString())',
      "Write-Output 'left' && Write-Output 'right'",
      `Write-Output 'shell:${text}'`,
      `[Console]::Error.WriteLine('shell-error:${text}')`,
      `'${text}' > '${redirected.replaceAll("'", "''")}'`,
      `'${text}' | & '${process.execPath.replaceAll("'", "''")}' '${nativeScript.replaceAll("'", "''")}'`
    ].join('; ')
    const result = await (await host.context.shell.execute(host.context.shell.resolve({ command }))).result()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toContain('version:7.')
    expect(result.stdout.text).toContain('right')
    expect(result.stdout.text).toContain(`shell:${text}`)
    expect(result.stdout.text).toContain(`native:${text}`)
    expect(result.stdout.text).toContain(`stdin:${text}`)
    expect(result.stderr.text).toContain(`shell-error:${text}`)
    expect(result.stderr.text).toContain(`native-error:${text}`)
    const fileOutput = await readFile(redirected)
    expect(fileOutput.toString('utf8').trim()).toBe(text)
  } finally {
    await host?.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 20_000)

it('cancels native commands through the production Electron utility bootstrap', async () => {
  const parent = resolve('temp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'dsh-utility-cancellation-'))
  try {
    await mkdir(join(root, 'work'))
    for (const [entry, output] of [
      ['src/main/deepseek-harness-host-bootstrap.ts', 'host.mjs'],
      ['tests/support/deepseek-harness-cancellation.electron.ts', 'app.mjs']
    ] as const) {
      await build({ entryPoints: [resolve(entry)], outfile: join(root, output), bundle: true, platform: 'node', format: 'esm', packages: 'external' })
    }
    const env: NodeJS.ProcessEnv = { ...process.env, GB_DSH_FIXTURE_NODE: process.execPath, GB_DSH_FIXTURE_ROOT: root, TEMP: root, TMP: root, TMPDIR: root }
    delete env.ELECTRON_RUN_AS_NODE
    const { stdout } = await promisify(execFile)(electron as unknown as string, [join(root, 'app.mjs'), '--no-sandbox', `--user-data-dir=${join(root, 'profile')}`], {
      env, timeout: 40_000, windowsHide: true, maxBuffer: 1024 * 1024
    })
    expect(stdout).toContain('DSH_UTILITY_RESULT')
    expect(stdout).toContain('"markerAbsent":true')
    expect(stdout).toContain('"siblingCompleted":true')
    expect(stdout).toContain('"resumed":true')
    expect(stdout).toContain('"hosts":1')
    console.log(stdout.trim())
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 50_000)
