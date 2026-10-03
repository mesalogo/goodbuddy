import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_LIMITS } from '../../shared/terminal-contracts'
import {
  TERMINAL_OUTPUT_FLUSH_INTERVAL_MS,
  TerminalOutputCoalescer,
  splitUtf8Bounded
} from './terminal-output-coalescer'

describe('TerminalOutputCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the first chunk immediately and merges a burst into one flush', () => {
    const emitted: string[] = []
    const coalescer = new TerminalOutputCoalescer({
      emit: (data) => emitted.push(data)
    })

    coalescer.push('$ ')
    expect(emitted).toEqual(['$ '])
    for (let index = 0; index < 100; index += 1) {
      coalescer.push(`${index},`)
    }
    expect(emitted).toHaveLength(1)
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_INTERVAL_MS)
    expect(emitted).toHaveLength(2)
    expect(emitted.join('')).toBe(
      '$ ' + Array.from({ length: 100 }, (_, index) => `${index},`).join('')
    )
    coalescer.dispose()
  })

  it('preserves exact order across timer, size-cap and explicit flushes', () => {
    const emitted: string[] = []
    const coalescer = new TerminalOutputCoalescer({
      emit: (data) => emitted.push(data),
      maximumBatchBytes: 16
    })
    const expected: string[] = []
    for (let index = 0; index < 500; index += 1) {
      const chunk = index % 7 === 0 ? `你好${index}` : `#${index};`
      expected.push(chunk)
      coalescer.push(chunk)
      if (index % 13 === 0) {
        vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_INTERVAL_MS)
      }
      if (index % 97 === 0) {
        coalescer.flush()
      }
    }
    coalescer.flush()

    expect(emitted.join('')).toBe(expected.join(''))
    expect(emitted.every((chunk) => Buffer.byteLength(chunk) <= 16)).toBe(true)
    expect(coalescer.bufferedBytes).toBe(0)
    coalescer.dispose()
  })

  it('emits full batches at the size cap without waiting for the timer', () => {
    const emitted: string[] = []
    const coalescer = new TerminalOutputCoalescer({
      emit: (data) => emitted.push(data)
    })
    const cap = TERMINAL_LIMITS.maximumEventBytes
    coalescer.push('x')
    const block = 'y'.repeat(4096)
    for (let index = 0; index < 40; index += 1) {
      coalescer.push(block)
    }

    // 160 KiB buffered inside one window: two full 64 KiB batches go out
    // immediately; the remainder waits for the timer.
    expect(emitted.slice(1).map((chunk) => Buffer.byteLength(chunk))).toEqual([
      cap,
      cap
    ])
    expect(coalescer.bufferedBytes).toBe(40 * 4096 - 2 * cap)
    expect(coalescer.bufferedBytes).toBeLessThan(cap)
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_INTERVAL_MS)
    expect(coalescer.bufferedBytes).toBe(0)
    expect(emitted.join('')).toBe('x' + block.repeat(40))
    coalescer.dispose()
  })

  it('never splits a multi-byte UTF-8 character across batches', () => {
    const emitted: string[] = []
    const coalescer = new TerminalOutputCoalescer({
      emit: (data) => emitted.push(data),
      maximumBatchBytes: 5
    })
    coalescer.push('a')
    coalescer.push('你好世界🙂')
    coalescer.flush()
    expect(emitted.join('')).toBe('a你好世界🙂')
    for (const chunk of emitted) {
      expect(Buffer.from(chunk).toString('utf8')).toBe(chunk)
      expect(chunk).not.toContain('\uFFFD')
    }
    coalescer.dispose()
  })

  it('dispose cancels the timer and drops later input', () => {
    const emit = vi.fn()
    const coalescer = new TerminalOutputCoalescer({ emit })
    coalescer.push('a')
    coalescer.push('b')
    coalescer.dispose()
    expect(vi.getTimerCount()).toBe(0)
    coalescer.push('c')
    coalescer.flush()
    vi.advanceTimersByTime(100)
    expect(emit.mock.calls).toEqual([['a']])
  })

  it('stops scheduling once idle', () => {
    const coalescer = new TerminalOutputCoalescer({ emit: vi.fn() })
    coalescer.push('a')
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_INTERVAL_MS)
    expect(vi.getTimerCount()).toBe(0)
    coalescer.dispose()
  })

  it('reduces IPC events by orders of magnitude for a 20 MB flood', () => {
    // Model node-pty delivering ~4 KiB reads; compare the number of output
    // events (one IPC send each) before and after coalescing.
    const totalBytes = 20 * 1024 * 1024
    const readBytes = 4096
    const read = 'z'.repeat(readBytes)
    let coalescedEvents = 0
    let coalescedBytes = 0
    const coalescer = new TerminalOutputCoalescer({
      emit: (data) => {
        coalescedEvents += 1
        coalescedBytes += data.length
      }
    })
    const reads = totalBytes / readBytes
    for (let index = 0; index < reads; index += 1) {
      coalescer.push(read)
      if (index % 64 === 0) {
        vi.advanceTimersByTime(1)
      }
    }
    coalescer.flush()
    coalescer.dispose()

    expect(coalescedBytes).toBe(totalBytes)
    // Uncoalesced: one event per read (5120). Coalesced: ~64 KiB per event.
    expect(coalescedEvents).toBeLessThanOrEqual(
      Math.ceil(totalBytes / TERMINAL_LIMITS.maximumEventBytes) + 100
    )
    expect(coalescedEvents).toBeLessThan(reads / 10)
  })
})

describe('splitUtf8Bounded', () => {
  it('returns no chunks for empty input and a single chunk when small', () => {
    expect(splitUtf8Bounded('', 4)).toEqual([])
    expect(splitUtf8Bounded('abc', 4)).toEqual(['abc'])
  })
})
