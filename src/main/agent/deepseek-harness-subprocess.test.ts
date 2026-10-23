// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import GoodBuddyHarnessSubprocess from './deepseek-harness-subprocess'

it.skipIf(process.platform !== 'win32')('bounds output draining after direct exit without claiming an inherited-pipe descendant exited', async () => {
  const parent = resolve('temp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'dsh-output-drain-'))
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, root)
  const ctx = new Context()
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  let descendantPid: number | undefined
  try {
    const descendantPath = join(root, 'descendant.cjs')
    const directPath = join(root, 'direct.cjs')
    const pidPath = join(root, 'descendant.pid')
    await writeFile(descendantPath, `process.stdout.write('inherited stdout\\n');process.stderr.write('inherited stderr\\n');process.send('ready');setTimeout(()=>{},30000);`)
    await writeFile(directPath, `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendantPath)}],{detached:true,stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>{fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({direct:process.pid,descendant:child.pid}));process.exit(7)});`)
    await ctx.plugin(GoodBuddyHarnessSubprocess)
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, directPath], cwd: root, graceMs: 200,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }
    })
    let result: Awaited<typeof handle.done> | undefined
    void handle.done.then(value => { result = value })
    let directPid = 0
    await vi.waitFor(async () => {
      const pids = JSON.parse(await readFile(pidPath, 'utf8')) as { direct: number; descendant: number }
      directPid = pids.direct
      descendantPid = pids.descendant
      expect(alive(directPid)).toBe(false)
    }, { timeout: 5000 })
    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => expect(result).toEqual({ exitCode: 7, signal: null }), { timeout: 2000 })
    expect(handle.collected.stdout?.readFrom(0).text).toContain('inherited stdout')
    expect(handle.collected.stderr?.readFrom(0).text).toContain('inherited stderr')
    expect(alive(descendantPid!)).toBe(true)
    await vi.waitFor(() => expect(disposed).toBe(true), { timeout: 1000 })
    await disposal
    expect(alive(descendantPid!)).toBe(true)
  } finally {
    // This fixture intentionally outlives the direct process; drain settlement
    // does not prove tree quiescence. Reap the known fixture PID explicitly.
    if (descendantPid && alive(descendantPid)) {
      process.kill(descendantPid, 'SIGKILL')
      await vi.waitFor(() => expect(alive(descendantPid!)).toBe(false), { timeout: 5000 })
    }
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}, 15_000)
