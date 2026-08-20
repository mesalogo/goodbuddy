import type { ContinueHostChild } from './continue-host-adapter'

type UtilityErrorListener = (
  type: 'FatalError',
  location: string,
  report: string
) => void

export type ContinueUtilityProcessSource = {
  readonly pid?: number
  readonly stderr?: ContinueHostChild['stderr']
  kill(): boolean
  onExit(listener: (code: number) => void): void
  onceExit(listener: (code: number) => void): void
  onceError(listener: UtilityErrorListener): void
  removeExitListener(listener: (code: number) => void): void
  removeErrorListener(listener: UtilityErrorListener): void
}

export function createContinueUtilityProcessChild(
  utility: ContinueUtilityProcessSource
): ContinueHostChild {
  let exitCode: number | null = null
  let killed = false
  const closeListeners = new Map<
    (value: Error | number | null) => void,
    (code: number) => void
  >()
  const errorListeners = new Map<
    (value: Error | number | null) => void,
    UtilityErrorListener
  >()
  utility.onExit((code) => {
    exitCode = code
  })

  const child: ContinueHostChild = {
    get exitCode() {
      return exitCode
    },
    get killed() {
      return killed
    },
    get pid() {
      return utility.pid
    },
    stderr: utility.stderr,
    once: (event, listener) => {
      if (event === 'close') {
        const wrapped = (code: number): void => {
          closeListeners.delete(listener)
          listener(code)
        }
        closeListeners.set(listener, wrapped)
        utility.onceExit(wrapped)
      } else {
        const wrapped: UtilityErrorListener = (
          _type,
          location,
          report
        ): void => {
          errorListeners.delete(listener)
          listener(
            new Error(
              `Continue 宿主进程异常（${location}）：${report.slice(0, 500)}`
            )
          )
        }
        errorListeners.set(listener, wrapped)
        utility.onceError(wrapped)
      }
      return child
    },
    removeListener: (event, listener) => {
      if (event === 'close') {
        const wrapped = closeListeners.get(listener)
        if (wrapped) {
          closeListeners.delete(listener)
          utility.removeExitListener(wrapped)
        }
      } else {
        const wrapped = errorListeners.get(listener)
        if (wrapped) {
          errorListeners.delete(listener)
          utility.removeErrorListener(wrapped)
        }
      }
      return child
    },
    kill: () => {
      killed = true
      return utility.kill()
    }
  }
  return child
}
