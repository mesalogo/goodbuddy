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

  it('writes idle output at once, merges the rest of the frame, and ACKs the last sequence after the write callback', async () => {
    const frames = manualScheduler()
    const writes: Array<{ data: string; done: () => void }> = []
    const acks: number[] = []
    const batcher = new TerminalOutputBatcher({
      write: (data, done) => writes.push({ data, done }),
      acknowledge: (_, sequence) => acks.push(sequence),
      schedule: frames.schedule
    })
    // Leading edge: a keystroke echo is written without waiting for a frame.
    batcher.push('s', 2, 'k')
    expect(writes.map((write) => write.data)).toEqual(['k'])
    expect(frames.pendingFrames()).toBe(1)
    writes[0]!.done()
    expect(acks).toEqual([2])

    // Output in the same frame is merged and written once when the frame runs.
    batcher.push('s', 3, 'a')
    batcher.push('s', 4, 'b')
    batcher.push('s', 5, 'c')
    expect(writes).toHaveLength(1)
    frames.runFrame()
    expect(writes.map((write) => write.data)).toEqual(['k', 'abc'])
    expect(acks).toEqual([2])
    writes[1]!.done()
    expect(acks).toEqual([2, 5])
    // A busy frame keeps the window open: the next output waits a frame.
    expect(frames.pendingFrames()).toBe(1)
    batcher.push('s', 6, 'd')
    expect(writes).toHaveLength(2)
    frames.runFrame()
    writes[2]!.done()
    writes[2]!.done()
    expect(writes.map((write) => write.data)).toEqual(['k', 'abc', 'd'])
    expect(acks).toEqual([2, 5, 6])

    // A frame without output returns to idle: the next output is immediate.
    frames.runFrame()
    expect(frames.pendingFrames()).toBe(0)
    batcher.push('s', 7, 'e')
    expect(writes.map((write) => write.data)).toEqual(['k', 'abc', 'd', 'e'])
    batcher.dispose()
  })

  it('flush writes pending output immediately and waits for the emulator', async () => {
    const frames = manualScheduler()
    let release: (() => void) | undefined
    const written: string[] = []
    const batcher = new TerminalOutputBatcher({
      write: (data, done) => {
        written.push(data)
        release = done
      },
      acknowledge: vi.fn(),
      schedule: frames.schedule
    })
    batcher.push('s', 1, 'x')
    batcher.push('s', 2, 'y')
    expect(written).toEqual(['x'])
    let flushed = false
    const flush = batcher.flush().then(() => {
      flushed = true
    })
    expect(frames.pendingFrames()).toBe(0)
    expect(written).toEqual(['x', 'y'])
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
    batcher.push('old', 8, 'shown')
    batcher.push('old', 9, 'stale')
    batcher.reset()
    frames.runFrame()
    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith('shown', expect.any(Function))
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
    batcher.push('s', 3, '!')
    expect(writes).toEqual(['hidden '])
    vi.advanceTimersByTime(TERMINAL_FRAME_FALLBACK_MS)
    expect(writes).toEqual(['hidden ', 'output!'])
    expect(acks).toEqual([1, 3])
    // The window closes after an empty fallback tick; no timers linger.
    vi.advanceTimersByTime(TERMINAL_FRAME_FALLBACK_MS)
    expect(vi.getTimerCount()).toBe(0)
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
