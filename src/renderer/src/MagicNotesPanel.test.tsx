import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/contracts'
import type { MagicNoteDetail, MagicNoteSource } from '../../shared/magic-notes-contracts'
import { magicNoteRichContentSchema } from '../../shared/magic-notes-contracts'
import { capturedNoteContent, MagicNotesPanel } from './MagicNotesPanel'
import { useMagicNoteDraft } from './use-magic-note-draft'
import { MagicNoteSource as SourceBar } from './MagicNoteSource'
import i18n from './i18n'

const note: MagicNoteDetail = { id: '00000000-0000-4000-8000-000000000601', title: 'Release decisions', preview: 'Existing text', entryCount: 0, entries: [], pinned: true, revision: 1, createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z' }
const source: MagicNoteSource = { kind: 'message', conversationId: 'conversation-a', messageIds: ['message-a'], capturedAt: '2026-09-26T00:00:00Z', conversationTitle: 'Discussion A', projectName: 'Project A' }
const entry = { id: '00000000-0000-4000-8000-000000000602', noteId: note.id, content: capturedNoteContent('Captured text'), plainText: 'Captured text', comments: [], revision: 1, createdAt: note.createdAt, updatedAt: note.updatedAt, source }
const search = vi.fn<DesktopApi['magicNotes']['search']>()
const get = vi.fn<DesktopApi['magicNotes']['get']>()
const create = vi.fn<DesktopApi['magicNotes']['create']>()
const createEntry = vi.fn<DesktopApi['magicNotes']['createEntry']>()
const analyze = vi.fn<DesktopApi['magicNotes']['analyze']>()
const onNotify = vi.fn()
const onOpenWorkspace = vi.fn()
let onChanged: () => void

function Harness({ mode = 'immediate' }: { mode?: 'immediate' | 'after-save-auto' | 'after-save-manual' }): React.JSX.Element {
  const state = useMagicNoteDraft()
  const [visible, setVisible] = useState(true)
  return <>
    <button onClick={() => setVisible(value => !value)}>Hide panel</button>
    <button onClick={() => { void state.guard().then(allowed => { if (allowed) state.setDraft({ text: 'Captured text', initialText: 'Captured text', title: 'Discussion A', initialTitle: 'Discussion A', targetId: '', newNote: false, source }) }) }}>Capture</button>
    <button onClick={() => { void state.guard().then(allowed => { if (allowed) { state.setDraft(undefined); setVisible(false) } }) }}>Close tab</button>
    <div hidden={!visible}><MagicNotesPanel state={state} active={visible} commentMode={mode} onNotify={onNotify} onOpenWorkspace={onOpenWorkspace} onOpenSource={async () => 'opened'} onCancelCapture={vi.fn()} /></div>
    {state.confirmation}
  </>
}

beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage('en-US')
  search.mockResolvedValue([note])
  get.mockResolvedValue(note)
  const saved = { ...note, entries: [entry], entryCount: 1, createdEntryId: entry.id }
  create.mockImplementation(async () => { get.mockResolvedValue(saved); return saved })
  createEntry.mockImplementation(async () => { get.mockResolvedValue(saved); return saved })
  analyze.mockResolvedValue(note)
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { magicNotes: { search, get, create, createEntry, analyze, onChanged: (listener: () => void) => { onChanged = listener; return vi.fn() } } } })
})
afterEach(cleanup)

describe('compact notes', () => {
  it('creates the note and captured entry in one explicit submit and focuses the returned entry', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Capture'))
    await screen.findByDisplayValue('Captured text')
    expect(create).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    expect(screen.getByLabelText('Note title')).toHaveValue('Discussion A')
    fireEvent.click(screen.getByRole('button', { name: 'Add to note' }))
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({ title: 'Discussion A', content: capturedNoteContent('Captured text'), source })
      expect(createEntry).not.toHaveBeenCalled()
      expect(document.activeElement).toHaveAttribute('id', `compact-note-entry-${entry.id}`)
    })
    expect(analyze).not.toHaveBeenCalled()
    expect(onNotify).toHaveBeenCalledWith({ tone: 'success', message: 'Entry saved' })
  })

  it('preserves edited content and source through hiding, refresh, failure, and retry', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Capture'))
    const text = await screen.findByLabelText('Text to add')
    fireEvent.change(text, { target: { value: 'Edited **Markdown**\n```ts\nconst a = 1\n```' } })
    fireEvent.click(await screen.findByRole('button', { name: /Release decisions/ }))
    await waitFor(() => expect(get).toHaveBeenCalledWith(note.id))
    fireEvent.click(screen.getByText('Hide panel'))
    act(() => onChanged())
    fireEvent.click(screen.getByText('Hide panel'))
    expect(await screen.findByLabelText('Text to add')).toHaveValue('Edited **Markdown**\n```ts\nconst a = 1\n```')
    createEntry.mockRejectedValueOnce(new Error('Disk full'))
    fireEvent.click(screen.getByRole('button', { name: 'Add to note' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full')
    expect(screen.getByLabelText('Text to add')).toHaveValue('Edited **Markdown**\n```ts\nconst a = 1\n```')
    fireEvent.click(screen.getByRole('button', { name: 'Add to note' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(2))
    expect(createEntry).toHaveBeenLastCalledWith({ noteId: note.id, content: capturedNoteContent('Edited **Markdown**\n```ts\nconst a = 1\n```'), source })
  })

  it('guards close, replacement, modified cancellation, and workspace navigation', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Capture'))
    await screen.findByDisplayValue('Captured text')
    for (const action of ['Close tab', 'Capture']) {
      fireEvent.click(screen.getByText(action))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Continue editing' }))
      expect(screen.getByLabelText('Text to add')).toHaveValue('Captured text')
    }
    fireEvent.change(screen.getByLabelText('Text to add'), { target: { value: 'Changed preview' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard and switch' }))
    fireEvent.click(await screen.findByRole('button', { name: /Release decisions/ }))
    fireEvent.change(await screen.findByLabelText('Text to add'), { target: { value: 'Quick draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open in full workspace' }))
    expect(onOpenWorkspace).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard and switch' }))
    await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledWith(note.id, undefined))
  })

  it.each(['immediate', 'after-save-manual', 'after-save-auto'] as const)('respects %s without analyzing the capture draft', async mode => {
    render(<Harness mode={mode} />)
    fireEvent.click(await screen.findByRole('button', { name: /Release decisions/ }))
    fireEvent.change(await screen.findByLabelText('Text to add'), { target: { value: 'Quick text' } })
    expect(analyze).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add to note' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledOnce())
    expect(createEntry).toHaveBeenCalledWith({ noteId: note.id, content: capturedNoteContent('Quick text'), source: undefined })
    await waitFor(() => expect(onNotify).toHaveBeenCalled())
    expect(analyze).toHaveBeenCalledTimes(mode === 'after-save-auto' ? 1 : 0)
  })

  it('keeps a successful save when automatic comments fail', async () => {
    analyze.mockRejectedValue(new Error('Model offline'))
    render(<Harness mode="after-save-auto" />)
    fireEvent.click(await screen.findByRole('button', { name: /Release decisions/ }))
    fireEvent.change(await screen.findByLabelText('Text to add'), { target: { value: 'Quick text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to note' }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: expect.stringContaining('Model offline') })))
    expect(createEntry).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Text to add')).toHaveValue('')
  })

  it('locks duplicate submission, cancellation, and closing until the save completes', async () => {
    let finish!: (result: Awaited<ReturnType<DesktopApi['magicNotes']['createEntry']>>) => void
    createEntry.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: /Release decisions/ }))
    fireEvent.change(await screen.findByLabelText('Text to add'), { target: { value: 'In-flight text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to note' }))
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    expect(screen.getByLabelText('Text to add')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.click(screen.getByText('Close tab'))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Text to add')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }))
    expect(createEntry).toHaveBeenCalledOnce()
    await act(async () => finish({ ...note, entries: [entry], entryCount: 1, createdEntryId: entry.id }))
    expect(screen.getByLabelText('Text to add')).toHaveValue('')
  })

  it('shows an oversized preview unchanged and allows correction before saving', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Capture'))
    const preview = await screen.findByLabelText('Text to add')
    const oversized = 'x'.repeat(512_001)
    fireEvent.change(preview, { target: { value: oversized } })
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    expect(preview).toHaveValue(oversized)
    expect(screen.getByRole('button', { name: 'Add to note' })).toBeDisabled()
    expect(screen.getByText(/Each entry supports up to 500 KB/)).toBeVisible()
    fireEvent.change(preview, { target: { value: 'Within capacity' } })
    expect(screen.getByRole('button', { name: 'Add to note' })).toBeEnabled()
    expect(create).not.toHaveBeenCalled()
  })

  it('preserves text when the target disappears and requires a new selection', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Capture'))
    fireEvent.click(await screen.findByRole('button', { name: /Release decisions/ }))
    await waitFor(() => expect(get).toHaveBeenCalled())
    get.mockRejectedValue(new Error('笔记不存在'))
    search.mockResolvedValue([])
    act(() => onChanged())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to note' })).toBeDisabled())
    expect(screen.getByLabelText('Text to add')).toHaveValue('Captured text')
    expect(createEntry).not.toHaveBeenCalled()
  })

  it('searches entry text, cancels stale requests, and does not replace the draft', async () => {
    let finishOld!: (notes: MagicNoteDetail[]) => void
    search.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    render(<Harness />)
    await waitFor(() => expect(search).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'deep entry text' } })
    await waitFor(() => expect(search).toHaveBeenLastCalledWith({ query: 'deep entry text', limit: 100 }))
    await screen.findByRole('button', { name: /Release decisions/ })
    await act(async () => finishOld([{ ...note, title: 'Stale result' }]))
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument()
  })

  it('retains large previews and validates without truncating or splitting entries', () => {
    const text = 'a'.repeat(199_999) + '😀' + 'b'.repeat(200_000)
    const content = capturedNoteContent(text)
    expect(magicNoteRichContentSchema.safeParse(content).success).toBe(true)
    expect(content.ops.map(op => op.insert).join('')).toBe(text + '\n')
    expect(magicNoteRichContentSchema.safeParse(capturedNoteContent('中'.repeat(180_000))).success).toBe(false)
  })
})

it('distinguishes deleted source from transient failure and preserves source labels', async () => {
  const open = vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue('missing')
  render(<SourceBar source={source} onOpen={open} />)
  fireEvent.click(screen.getByRole('button', { name: 'View source message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Read failed')
  expect(screen.getByRole('button', { name: 'Return to conversation' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'The original conversation no longer exists' })).toBeDisabled()
  expect(screen.getByText('From conversation: Discussion A')).toBeVisible()
  expect(open).toHaveBeenLastCalledWith(source, 'message-a')
})
