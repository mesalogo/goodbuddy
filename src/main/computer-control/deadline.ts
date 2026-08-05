import { cancellationFailure, ComputerControlFailure } from './errors'

export const runWithDeadline = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  deadlineMs: number,
  timeoutCode: 'driver_timeout' | 'approval_timeout'
): Promise<T> => {
  if (parentSignal.aborted) {
    throw cancellationFailure()
  }

  const controller = new AbortController()
  let timedOut = false
  const cancel = (): void => {
    controller.abort(parentSignal.reason)
  }
  parentSignal.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('Computer control deadline exceeded'))
  }, deadlineMs)

  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            reject(
              timedOut
                ? new ComputerControlFailure(
                    timeoutCode,
                    'Computer control request timed out',
                    true
                  )
                : cancellationFailure()
            )
          },
          { once: true }
        )
      })
    ])
  } finally {
    clearTimeout(timeout)
    parentSignal.removeEventListener('abort', cancel)
  }
}
