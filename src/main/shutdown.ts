export async function waitForCleanup(
  cleanup: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs)
  })
  const settled = Promise.resolve(cleanup).then(
    () => true as const,
    () => true as const
  )
  const completed = await Promise.race([settled, timedOut])
  if (timeout) {
    clearTimeout(timeout)
  }
  return completed
}

export type CleanupOperation = () => unknown | Promise<unknown>

export async function settleCleanupPhases(
  phases: readonly (readonly CleanupOperation[])[]
): Promise<void> {
  for (const phase of phases) {
    await Promise.allSettled(
      phase.map((operation) => Promise.resolve().then(operation))
    )
  }
}

export async function runCleanupBeforeDeadline(
  cleanup: Promise<unknown>,
  timeoutMs: number,
  finalize: () => unknown | Promise<unknown>
): Promise<boolean> {
  const completed = await waitForCleanup(cleanup, timeoutMs)
  if (completed) {
    await finalize()
  }
  return completed
}
