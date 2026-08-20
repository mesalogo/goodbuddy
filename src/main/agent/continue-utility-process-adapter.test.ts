import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createContinueUtilityProcessChild,
  type ContinueUtilityProcessSource
} from './continue-utility-process-adapter'
import { waitForProcessExit } from './child-process-termination'

function createSource(): ContinueUtilityProcessSource & EventEmitter {
  const emitter =
    new EventEmitter() as ContinueUtilityProcessSource & EventEmitter
  Object.defineProperties(emitter, {
    pid: { value: 42 },
    stderr: { value: undefined }
  })
  emitter.kill = vi.fn(() => true)
  emitter.onExit = (listener) => {
    emitter.on('exit', listener)
  }
  emitter.onceExit = (listener) => {
    emitter.once('exit', listener)
  }
  emitter.onceError = (listener) => {
    emitter.once('utility-error', listener)
  }
  emitter.removeExitListener = (listener) => {
    emitter.removeListener('exit', listener)
  }
  emitter.removeErrorListener = (listener) => {
    emitter.removeListener('utility-error', listener)
  }
  return emitter
}

describe('Continue utility process adapter', () => {
  it('maps Electron exit to close and completes helper waits immediately', async () => {
    const source = createSource()
    const child = createContinueUtilityProcessChild(source)
    const close = vi.fn()

    child.once('close', close)
    const waiting = waitForProcessExit(child)
    source.emit('exit', 0)

    expect(close).toHaveBeenCalledWith(0)
    expect(child.exitCode).toBe(0)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('maps utility errors and removes both listener types', () => {
    const source = createSource()
    const child = createContinueUtilityProcessChild(source)
    const close = vi.fn()
    const error = vi.fn()

    child.once('close', close)
    child.once('error', error)
    child.removeListener?.('close', close)
    child.removeListener?.('error', error)
    source.emit('exit', 0)
    source.emit('utility-error', 'FatalError', 'worker.js:1', 'report')

    expect(close).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('converts utility error details to a bounded Error', () => {
    const source = createSource()
    const child = createContinueUtilityProcessChild(source)
    const error = vi.fn()

    child.once('error', error)
    source.emit(
      'utility-error',
      'FatalError',
      'worker.js:1',
      'x'.repeat(1_000)
    )

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /^Continue 宿主进程异常（worker\.js:1）：x{500}$/u
        )
      })
    )
  })
})
