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
