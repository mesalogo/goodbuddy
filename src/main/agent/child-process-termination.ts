import spawn from 'cross-spawn'

export type ProcessTreeChild = {
  exitCode?: number | null
  killed?: boolean
  pid?: number
  kill: (signal?: NodeJS.Signals) => unknown
  unref?: () => unknown
}

export type WaitableProcessTreeChild = ProcessTreeChild & {
  exitCode: number | null
  once: (
    event: 'close' | 'error',
    listener: (...args: unknown[]) => void
  ) => unknown
  removeListener?: (
    event: 'close' | 'error',
    listener: (...args: unknown[]) => void
  ) => unknown
}

export type ProcessTreeSpawn = (
  command: string,
  args: string[],
  options: {
    shell: false
    stdio: 'ignore'
    windowsHide: true
  }
) => WaitableProcessTreeChild

export type ProcessGroupKill = (
  pid: number,
  signal: NodeJS.Signals
) => unknown

export type ProcessTreeTerminationOptions = {
  platform?: NodeJS.Platform
  spawn?: ProcessTreeSpawn
  killProcess?: ProcessGroupKill
  processGroup?: boolean
  signal?: NodeJS.Signals
  waitMs?: number
}

const DEFAULT_EXIT_WAIT_MS = 2_000

type ProcessExitResult = 'closed' | 'error' | 'timeout'

function monitorWindowsKiller(
  killer: WaitableProcessTreeChild,
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
  waitMs: number
): void {
  let settled = false
  const fallback = (): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    killer.removeListener?.('close', onClose)
    killer.removeListener?.('error', onError)
    if (
      !child.killed &&
      (child.exitCode === undefined || child.exitCode === null)
    ) {
      child.kill(signal)
    }
  }
  const onClose = (): void => {
    if (killer.exitCode === 0) {
      settled = true
      clearTimeout(timer)
      killer.removeListener?.('error', onError)
      return
    }
    fallback()
  }
  const onError = (): void => fallback()
  const timer = setTimeout(fallback, waitMs)
  timer.unref?.()
  killer.once('close', onClose)
  killer.once('error', onError)
}

function waitForProcessExitResult(
  child: WaitableProcessTreeChild,
  waitMs: number
): Promise<ProcessExitResult> {
  if (child.exitCode !== null) {
    return Promise.resolve('closed')
  }
  return new Promise((resolve) => {
    const finish = (result: ProcessExitResult): void => {
      clearTimeout(timer)
      child.removeListener?.('close', onClose)
      child.removeListener?.('error', onError)
      resolve(result)
    }
    const onClose = (): void => finish('closed')
    const onError = (): void => finish('error')
    const timer = setTimeout(
      () => finish('timeout'),
      waitMs
    )
    timer.unref?.()
    child.once('close', onClose)
    child.once('error', onError)
  })
}

export function waitForProcessExit(
  child: WaitableProcessTreeChild,
  waitMs = DEFAULT_EXIT_WAIT_MS
): Promise<void> {
  return waitForProcessExitResult(child, waitMs).then(() => undefined)
}

export function requestProcessTreeTermination(
  child: ProcessTreeChild,
  options: ProcessTreeTerminationOptions = {}
): WaitableProcessTreeChild | undefined {
  if (
    (child.exitCode !== undefined && child.exitCode !== null) ||
    child.killed
  ) {
    return undefined
  }
  const platform = options.platform ?? process.platform
  const signal = options.signal ?? 'SIGTERM'
  if (platform === 'win32' && child.pid) {
    try {
      const killer = (options.spawn ?? spawn)(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        {
          shell: false,
          stdio: 'ignore',
          windowsHide: true
        }
      )
      killer.unref?.()
      monitorWindowsKiller(
        killer,
        child,
        signal,
        options.waitMs ?? DEFAULT_EXIT_WAIT_MS
      )
      return killer
    } catch {
      child.kill(signal)
      return undefined
    }
  }
  if (options.processGroup && child.pid) {
    try {
      ;(options.killProcess ?? process.kill)(-child.pid, signal)
      if (child.exitCode === null) {
        child.kill(signal)
      }
      return undefined
    } catch {
      // The child may not be a process-group leader. Fall back to the
      // direct handle so cleanup is never weakened by that assumption.
    }
  }
  child.kill(signal)
  return undefined
}

export async function terminateProcessTreeAndWait(
  child: WaitableProcessTreeChild,
  options: ProcessTreeTerminationOptions = {}
): Promise<void> {
  if (child.exitCode !== null) {
    return
  }
  const exited = waitForProcessExit(
    child,
    options.waitMs ?? DEFAULT_EXIT_WAIT_MS
  )
  const killer = requestProcessTreeTermination(child, options)
  if (killer) {
    await waitForProcessExitResult(
      killer,
      options.waitMs ?? DEFAULT_EXIT_WAIT_MS
    )
  }
  await exited
}
