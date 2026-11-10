import { expect, it } from 'vitest'
import { compactNoteMedia, restoreNoteMedia } from './magic-note-media'
import type { MagicNoteRichContent } from './magic-notes-contracts'

it('reuses reordered media slots without replacing identical-looking ordinary text', () => {
  const first = 'data:image/png;base64,YWJjZA=='
  const second = 'data:image/png;base64,ZWZnaA=='
  const previous: MagicNoteRichContent = { version: 1, ops: [{ insert: { image: first } }, { insert: { image: second } }] }
  const next: MagicNoteRichContent = { version: 1, ops: [{ insert: second }, { insert: { image: second } }, { insert: { image: first } }] }
  const before = JSON.stringify({ previous, next })
  const compact = compactNoteMedia(next, previous)
  expect(compact.reusedMedia).toEqual([{ slot: 0, previousSlot: 1 }, { slot: 1, previousSlot: 0 }])
  expect(compact.content.version === 1 && compact.content.ops[0]!.insert).toBe(second)
  expect(restoreNoteMedia(compact.content, previous, compact.reusedMedia!)).toEqual(next)
  expect(JSON.stringify({ previous, next })).toBe(before)
})
