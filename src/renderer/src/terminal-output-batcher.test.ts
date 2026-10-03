import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_FRAME_FALLBACK_MS,
  TerminalOutputBatcher,
  scheduleTerminalFrame,
  type TerminalFrameScheduler
} from './terminal-output-batcher'

function manualScheduler(): {
  schedule: TerminalFrameScheduler
  runFrame: () => void
  pendingFrames: () => number
} {
  const callbacks = new Set<() => void>()
  return {
    schedule: (callback) => {
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
    runFrame: () => {
      const current = [...callbacks]
      callbacks.clear()
      for (const callback of current) {
        callback()
      }
    },
    pendingFrames: () => callbacks.size
  }
}

describe('TerminalOutputBatcher', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('writes once per frame in order and ACKs the last sequence after the write callback', async () => {
    const frames = manualScheduler()
    const writes: Array<{ data: string; done: () => void }> = []
    const acks: number[] = []
    const batcher = new TerminalOutputBatcher({
      write: (data, done) => writes.push({ data, done }),
      acknowledge: (_, sequence) => acks.push(sequence),
      schedule: frames.schedule
    })
    batcher.push('s', 3, 'a')
    batcher.push('s', 4, 'b')
    batcher.push('s', 5, 'c')
    expect(frames.pendingFrames()).toBe(1)
    expect(writes).toHaveLength(0)

    frames.runFrame()
    expect(writes.map((write) => write.data)).toEqual(['abc'])
    expect(acks).toEqual([])
    writes[0]!.done()
    expect(acks).toEqual([5])

    batcher.push('s', 6, 'd')
    frames.runFrame()
    writes[1]!.done()
    writes[1]!.done()
    expect(writes.map((write) => write.data)).toEqual(['abc', 'd'])
    expect(acks).toEqual([5, 6])
    batcher.dispose()
  })

  it('flush writes pending output immediately and waits for the emulator', async () => {
    const frames = manualScheduler()
    let release: (() => void) | undefined
    const batcher = new TerminalOutputBatcher({
      write: (_, done) => {
        release = done
      },
      acknowledge: vi.fn(),
      schedule: frames.schedule
    })
    batcher.push('s', 1, 'x')
    let flushed = false
    const flush = batcher.flush().then(() => {
      flushed = true
    })
    expect(frames.pendingFrames()).toBe(0)
    await Promise.resolve()
    expect(flushed).toBe(false)
    release?.()
    await flush
    expect(flushed).toBe(true)
    batcher.dispose()
  })

  it('reset drops unwritten output but ACKs it so Main is not left paused', () => {
    const frames = manualScheduler()
    const write = vi.fn()
    const acknowledge = vi.fn()
    const batcher = new TerminalOutputBatcher({
      write,
      acknowledge,
      schedule: frames.schedule
    })
    batcher.push('old', 9, 'stale')
    batcher.reset()
    frames.runFrame()
    expect(write).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledWith('old', 9)
    batcher.dispose()
  })

  it('does not ACK after dispose', () => {
    const frames = manualScheduler()
    let done: (() => void) | undefined
    const acknowledge = vi.fn()
    const batcher = new TerminalOutputBatcher({
      write: (_, callback) => {
        done = callback
      },
      acknowledge,
      schedule: frames.schedule
    })
    batcher.push('s', 1, 'x')
    frames.runFrame()
    batcher.dispose()
    done?.()
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('keeps flushing hidden terminals via the timer fallback when frames stop', () => {
    vi.useFakeTimers()
    // Hidden/minimized windows never run animation frames.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const writes: string[] = []
    const acks: number[] = []
    const batcher = new TerminalOutputBatcher({
      write: (data, done) => {
        writes.push(data)
        done()
      },
      acknowledge: (_, sequence) => acks.push(sequence)
    })
    batcher.push('s', 1, 'hidden ')
    batcher.push('s', 2, 'output')
    vi.advanceTimersByTime(TERMINAL_FRAME_FALLBACK_MS)
    expect(writes).toEqual(['hidden output'])
    expect(acks).toEqual([2])
    batcher.dispose()
  })

  it('scheduleTerminalFrame runs once whichever of frame or timer fires first', () => {
    vi.useFakeTimers()
    let frame: (() => void) | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: () => void) => {
      frame = callback
      return 7
    }))
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const callback = vi.fn()
    scheduleTerminalFrame(callback)
    frame?.()
    vi.advanceTimersByTime(TERMINAL_FRAME_FALLBACK_MS * 2)
    expect(callback).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
