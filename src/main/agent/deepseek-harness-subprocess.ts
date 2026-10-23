import { spawn, type StdioOptions } from 'node:child_process'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { OutputCollector, prepareManagedProcessBinding } from '@deepseek-ai/dsh-subprocess-local/output'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { terminateProcessTreeAndWait, type WaitableProcessTreeChild } from './child-process-termination'

export default class GoodBuddyHarnessSubprocess extends LocalSubprocess {
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (process.platform !== 'win32') {
      // Only the private runner may inherit Electron's Node-mode switch.
      const previous = process.env.ELECTRON_RUN_AS_NODE
      try {
        if (process.versions.electron) process.env.ELECTRON_RUN_AS_NODE = '1'
        return super.spawn({ ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: undefined } })
      } finally {
        if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE
        else process.env.ELECTRON_RUN_AS_NODE = previous
      }
    }
    spec.signal?.throwIfAborted()
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) throw new Error('Invalid subprocess grace period')
    const env = scrubbedParentEnv()
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === key.toUpperCase()) delete env[existing]
      }
      if (value !== undefined) env[key] = value
    }
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
    }
    const stdio: StdioOptions = [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
      spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe', spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe']
    if (spec.stdio.control === 'pipe') {
      while (stdio.length < SUBPROCESS_CONTROL_FD) stdio.push('ignore')
      stdio.push('pipe')
      env[SUBPROCESS_CONTROL_ENV] = 'pipe'
    }
    const binding = prepareManagedProcessBinding()
    const collected: SubprocessHandle['collected'] = Object.fromEntries(
      (['stdout', 'stderr'] as const).flatMap(name => {
        const mode = spec.stdio[name]
        return typeof mode === 'object' ? [[name, new OutputCollector(mode.maxBytes, name,
          mode.spill ? { ...mode.spill, dir: binding.spillDir, onFailure: binding.onSpillFailure } : undefined)]] : []
      })
    )
    const [command, ...args] = spec.argv
    if (!command) throw new Error('Subprocess argv is empty')
    // Store PS7 children escape the pinned Job runner. Keep the actual shell
    // alive until taskkill has enumerated and stopped this command's tree.
    const child = spawn(command, args, { cwd: spec.cwd, env, stdio, windowsHide: true })
    let settled = false
    let termination: Promise<void> | undefined
    const terminate = (): void => {
      if (!settled) termination ??= terminateProcessTreeAndWait(child as WaitableProcessTreeChild, { waitMs: spec.graceMs })
    }
    const done = new Promise<SubprocessOutcome>((resolve, reject) => {
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        settled = true
        clearTimeout(drainTimer)
        spec.signal?.removeEventListener('abort', terminate)
        for (const name of ['stdout', 'stderr'] as const) {
          const collector = collected[name] as OutputCollector | undefined
          if (collector) {
            child[name]?.destroy()
            collector.seal()
          }
        }
      }
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return
        cleanup()
        resolve({ exitCode, signal })
      }
      child.once('error', error => {
        if (settled) return
        cleanup()
        reject(error)
      })
      // A descendant may retain output handles after direct exit. Bound draining
      // without treating output settlement as proof that descendants are gone.
      child.once('exit', (exitCode, signal) => {
        if (!settled) drainTimer = setTimeout(() => finish(exitCode, signal), spec.graceMs)
      })
      child.once('close', finish)
    })
    for (const name of ['stdout', 'stderr'] as const) {
      const collector = collected[name] as OutputCollector | undefined
      if (collector) child[name]?.on('data', (chunk: Buffer) => collector.push(chunk))
    }
    if (typeof spec.stdio.stdin === 'object') {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(spec.stdio.stdin.data)
    }
    spec.signal?.addEventListener('abort', terminate, { once: true })
    if (spec.signal?.aborted) terminate()
    const dispose = this.ctx.effect(() => async () => {
      terminate()
      await termination
      await done.catch(() => undefined)
    }, 'GoodBuddy DSH command process')
    void done.then(() => dispose(), () => dispose())
    return {
      stdin: spec.stdio.stdin === 'pipe' ? child.stdin ?? undefined : undefined,
      stdout: spec.stdio.stdout === 'pipe' ? child.stdout ?? undefined : undefined,
      stderr: spec.stdio.stderr === 'pipe' ? child.stderr ?? undefined : undefined,
      control: spec.stdio.control === 'pipe' ? child.stdio.at(SUBPROCESS_CONTROL_FD) as SubprocessHandle['control'] : undefined,
      collected, done, terminate,
      async waitForExit(signal) {
        if (signal?.aborted) return false
        if (!signal) { await done; await termination; return true }
        let abort!: () => void
        try {
          return await Promise.race([
            done.then(async () => { await termination; return true }),
            new Promise<boolean>(resolve => { abort = () => resolve(false); signal.addEventListener('abort', abort, { once: true }) })
          ])
        } finally { signal.removeEventListener('abort', abort) }
      }
    }
  }
}
