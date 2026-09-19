import { expect, it } from 'vitest'
import { selectMagicNotePages } from './magic-note-pages.mjs'

it('selects the current prefix, defaulting to one, without changing the saved page list', () => {
  const pages = Array.from({ length: 50 }, (_, index) => ({ id: `page-${50 - index}` }))
  expect(selectMagicNotePages(pages)).toEqual([pages[0]])
  expect(selectMagicNotePages(pages, 8)).toEqual(pages.slice(0, 8))
  expect(selectMagicNotePages(pages.slice(0, 2), 8)).toEqual(pages.slice(0, 2))
  expect(selectMagicNotePages([])).toEqual([])
  expect(pages).toHaveLength(50)
  expect(selectMagicNotePages(pages)[0]).toBe(pages[0])
})

it.each([0, 9, -1, 1.5, NaN, Infinity])('rejects invalid analysis page limits: %s', limit => {
  expect(() => selectMagicNotePages([], limit)).toThrow(RangeError)
})
