export async function settleBoundedly(
  promises: readonly Promise<unknown>[],
  timeoutMs: number
): Promise<void> {
  if (promises.length === 0) {
    return
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(promises).then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
