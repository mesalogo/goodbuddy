import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerInput } from './ComposerInput'
import { composerSelection, readComposerDom, setComposerSelection, type ComposerInputElement } from './composer-input-dom'
import { promptWithReferences, referenceToken, type ExternalDocumentReference } from './external-references'

const local: ExternalDocumentReference = { provider: 'local', id: 'local-1', title: '报告.txt', libraryName: '资料', path: '/资料/报告.txt' }
const wecom: ExternalDocumentReference = { provider: 'wecom', id: 'wecom-1', title: '周报' }
const refs = [local, wecom]
function setup(initial = `比较 ${referenceToken(local)} 和 ${referenceToken(wecom)}。`) {
  const changed = vi.fn(), key = vi.fn()
  function Fixture() {
    const [value, setValue] = useState(initial)
    const inputRef = useRef<ComposerInputElement>(null)
    return <ComposerInput value={value} references={refs} inputRef={inputRef} aria-label="Editor"
      onValueChange={value => { changed(value); setValue(value) }} onInputSelection={() => {}} onPaste={() => {}} onKeyDown={key} />
  }
  render(<Fixture />)
  const editor = screen.getByRole('textbox') as HTMLDivElement
  const select = (start: number, end = start) => act(() => { editor.focus(); setComposerSelection(editor, start, end) })
  return { editor, select, changed, key }
}
afterEach(cleanup)

describe('inline composer editing', () => {
  it('renders atomic source icons inside text and sends document instructions in visible order', () => {
    const { editor } = setup()
    expect(editor.querySelectorAll('[contenteditable="false"]')).toHaveLength(2)
    expect(editor.querySelectorAll('.composer-inline-reference svg')).toHaveLength(2)
    expect(editor.textContent).toBe('比较 报告.txt× 和 周报×。')
    const reversed = `先读 ${referenceToken(wecom)}，再对照 ${referenceToken(local)}。`
    const prompt = promptWithReferences(reversed, refs, '')
    expect(prompt).toMatch(/^先读 @周报 \[1\]，再对照 @报告.txt \[2\]。/u)
    expect(prompt.indexOf('docid: wecom-1')).toBeLessThan(prompt.indexOf('documentId: local-1'))
    expect(prompt).not.toContain('\uFFF9')
  })

  it('deletes whole references with Backspace and Delete and restores them with undo/redo', () => {
    const initial = `前${referenceToken(local)}后`
    const { editor, select } = setup(initial)
    select(1 + referenceToken(local).length)
    fireEvent.keyDown(editor, { key: 'Backspace' })
    expect(readComposerDom(editor)).toBe('前后')
    expect(composerSelection(editor)).toEqual({ start: 1, end: 1 })
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
    expect(readComposerDom(editor)).toBe(initial)
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(readComposerDom(editor)).toBe('前后')
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
    select(1)
    fireEvent.keyDown(editor, { key: 'Delete' })
    expect(readComposerDom(editor)).toBe('前后')
  })

  it('removes a reference in place with its button and supports undo', () => {
    const { editor } = setup()
    fireEvent.click(editor.querySelector('button')!)
    expect(readComposerDom(editor)).toBe(`比较  和 ${referenceToken(wecom)}。`)
    fireEvent.keyDown(editor, { key: 'z', metaKey: true })
    expect(editor.querySelectorAll('.composer-inline-reference')).toHaveLength(2)
  })

  it('pastes plain text over selected content, copies readable labels, and retains line breaks', () => {
    const { editor, select } = setup()
    select(0, readComposerDom(editor).length)
    const setData = vi.fn()
    fireEvent.copy(editor, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', '比较 @报告.txt 和 @周报。')
    fireEvent.paste(editor, { clipboardData: { getData: () => '替换\r\n文本', files: [] } })
    expect(readComposerDom(editor)).toBe('替换\n文本')
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    expect(readComposerDom(editor)).toBe('替换\n文本\n')
  })

  it('does not submit or pick a reference while an IME composition is being confirmed', () => {
    const { editor, key } = setup()
    fireEvent.compositionStart(editor)
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229, isComposing: true })
    expect(key).not.toHaveBeenCalled()
    fireEvent.compositionEnd(editor)
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(key).toHaveBeenCalledOnce()
  })
})
