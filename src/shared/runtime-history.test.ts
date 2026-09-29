import { describe, expect, it } from 'vitest'
import {
  buildRuntimeHistory,
  cancelledResponseMarker,
  failedResponseMarker
} from './runtime-history'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('buildRuntimeHistory', () => {
  it('keeps a cancelled turn answered by its partial reply and an interruption marker', () => {
    expect(buildRuntimeHistory([
      { id: id(1), role: 'user', content: 'First question', state: 'complete' },
      { id: id(2), role: 'assistant', content: 'Partial answer', state: 'error', terminalStatus: 'cancelled' },
      { id: id(3), role: 'user', content: 'continue', state: 'complete' },
      { id: id(4), role: 'assistant', content: '', state: 'error', terminalStatus: 'cancelled' },
      { id: id(5), role: 'user', content: 'continue', state: 'complete' },
      { id: id(6), role: 'assistant', content: 'Final answer', state: 'complete' }
    ])).toEqual([
      { id: id(1), role: 'user', content: 'First question' },
      { id: id(2), role: 'assistant', content: `Partial answer\n\n${cancelledResponseMarker}` },
      { id: id(3), role: 'user', content: 'continue' },
      { id: id(4), role: 'assistant', content: cancelledResponseMarker },
      { id: id(5), role: 'user', content: 'continue' },
      { id: id(6), role: 'assistant', content: 'Final answer' }
    ])
  })

  it('marks failed replies and recognizes legacy cancelled labels', () => {
    expect(buildRuntimeHistory([
      { id: id(1), role: 'user', content: 'A', state: 'complete' },
      { id: id(2), role: 'assistant', content: '', state: 'error', status: '请求已取消' },
      { id: id(3), role: 'user', content: 'B', state: 'complete' },
      { id: id(4), role: 'assistant', content: 'half', state: 'error', terminalStatus: 'failed' }
    ]).map((message) => message.content)).toEqual([
      'A', cancelledResponseMarker, 'B', `half\n\n${failedResponseMarker}`
    ])
  })

  it('skips streaming, empty and orphaned terminal messages', () => {
    expect(buildRuntimeHistory([
      { id: id(1), role: 'assistant', content: 'orphan', state: 'error', terminalStatus: 'cancelled' },
      { id: id(2), role: 'user', content: '  ', state: 'complete' },
      { id: id(3), role: 'user', content: 'Q', state: 'complete' },
      { id: id(4), role: 'assistant', content: 'A', state: 'complete' },
      { id: id(5), role: 'assistant', content: 'late', state: 'error', terminalStatus: 'failed' },
      { id: id(6), role: 'user', content: 'Now', state: 'complete' },
      { id: id(7), role: 'assistant', content: 'typing', state: 'streaming' }
    ]).map((message) => message.id)).toEqual([id(3), id(4), id(6)])
  })
})
