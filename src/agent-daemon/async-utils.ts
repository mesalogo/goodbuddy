export async function raceWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

export function closeServer(server: {
  close(callback: (error?: Error) => void): unknown
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      server.close((error) => {
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      })
    } catch (error) {
      if (
        isNodeError(error) &&
        error.code === 'ERR_SERVER_NOT_RUNNING'
      ) {
        resolve()
      } else {
        reject(error)
      }
    }
  })
}

export async function settleWithin(
  pending: Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} is invalid`)
  }
  return value
}

export function isNodeError(
  error: unknown
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
