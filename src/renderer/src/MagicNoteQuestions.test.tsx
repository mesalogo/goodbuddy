import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MagicNoteQuestions } from './MagicNoteQuestions'
import type { MagicNoteDetail, MagicNoteQuestionInput } from '../../shared/magic-notes-contracts'
import i18n from './i18n'

const noteId = '00000000-0000-4000-8000-000000000601'
const entryId = '00000000-0000-4000-8000-000000000602'
const png = 'data:image/png;base64,YQ=='
const capturePages = vi.fn(async (_count: number, images: boolean, page: number) => [{ pageId: `page-${page}`, text: `Text ${page}`, dataUrl: images ? png : '' }])
const activePage = vi.fn(async () => 2)
let finishRegion: (region: { x: number; y: number; width: number; height: number } | null) => void = () => {}
const selectRegion = vi.fn(() => new Promise<{ x: number; y: number; width: number; height: number } | null>(resolve => { finishRegion = resolve }))
const cancelRegion = vi.fn(() => finishRegion(null))
const getCanvas = () => ({ capturePages, activePage, selectRegion, cancelRegion })
const onError = vi.fn()
const ask = vi.fn<(input: MagicNoteQuestionInput) => Promise<{ requestId: string; answer: string; inputMode: 'vision' | 'text' }>>()
const getRuntime = vi.fn(async () => ({ supportsImageInput: true, modelProfiles: [], defaultModelProfileId: '' }))
const note = (count = 10): MagicNoteDetail => ({ id: noteId, title: 'Note', preview: '', pinned: false, tags: [], entryCount: 1, revision: 1, createdAt: '', updatedAt: '', entries: [{
  id: entryId, noteId, plainText: 'whole record', revision: 2, comments: [], createdAt: '', updatedAt: '',
  content: { version: 2, kind: 'paged-canvas', assets: [], pages: Array.from({ length: count }, (_, i) => ({ id: `page-${i + 1}`, width: 100, height: 100, background: { type: 'template', template: 'blank' }, objects: [] })) }
}] })
const send = (text = '问题'): void => { fireEvent.change(screen.getByLabelText('自由问答'), { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: '提问' })) }
afterEach(cleanup)
beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('zh-CN')
  ask.mockResolvedValue({ requestId: 'request', answer: '答案', inputMode: 'vision' })
  getRuntime.mockResolvedValue({ supportsImageInput: true, modelProfiles: [], defaultModelProfileId: '' })
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { magicNotes: { ask }, settings: { getRuntime } } })
})

it('uses the actual active page and passes all follow-up turns', async () => {
  render(<MagicNoteQuestions note={note()} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  send()
  await screen.findByText('答案')
  expect(capturePages).toHaveBeenCalledWith(1, true, 2)
  expect(ask.mock.calls[0]![0]).toMatchObject({ scope: 'page', pageStart: 2, pageEnd: 2, contexts: [{ entryId, revision: 2, pages: [{ pageId: 'page-2' }] }] })
  send('展开刚才的建议')
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(2))
  expect(ask.mock.calls[1]![0].history).toEqual([{ question: '问题', answer: '答案', context: '记录 1 / 2-2' }])
})

it('clears history from a borderless icon and shows request limits only when exceeded', async () => {
  const view = render(<MagicNoteQuestions note={note()} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  expect(view.container).not.toHaveTextContent('50 张')
  expect(screen.queryByRole('button', { name: '清空问答历史' })).not.toBeInTheDocument()
  send()
  await screen.findByText('答案')
  const clear = screen.getByRole('button', { name: '清空问答历史' })
  expect(clear).toHaveClass('icon-button')
  expect(clear).not.toHaveClass('secondary-button')
  expect(clear).toHaveAttribute('title', '清空问答历史')
  fireEvent.click(clear)
  expect(screen.queryByText('答案')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '清空问答历史' })).not.toBeInTheDocument()
  view.unmount()
  render(<MagicNoteQuestions note={note(51)} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  fireEvent.change(screen.getByLabelText('上下文'), { target: { value: 'document' } })
  send()
  await waitFor(() => expect(onError).toHaveBeenCalledOnce())
  expect(String(onError.mock.calls[0]![0])).toContain('50 张')
})

it('captures every page of every canvas record in document scope, including pages after eight', async () => {
  const detail = note()
  detail.entries.push({ ...detail.entries[0]!, id: '00000000-0000-4000-8000-000000000603' })
  render(<MagicNoteQuestions note={detail} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  fireEvent.change(screen.getByLabelText('上下文'), { target: { value: 'document' } })
  send()
  await screen.findByText('答案')
  expect(capturePages).toHaveBeenCalledTimes(20)
  expect(ask.mock.calls[0]![0].contexts.map(context => context.pages.length)).toEqual([10, 10])
})

it('does not silently truncate over-budget documents or invalid page ranges', async () => {
  render(<MagicNoteQuestions note={note(51)} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  fireEvent.change(screen.getByLabelText('上下文'), { target: { value: 'document' } })
  send()
  await waitFor(() => expect(onError).toHaveBeenCalledOnce())
  expect(capturePages).not.toHaveBeenCalled()
  expect(ask).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('上下文'), { target: { value: 'pages' } })
  fireEvent.change(screen.getByLabelText('起始页'), { target: { value: '52' } })
  send()
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(2))
  expect(ask).not.toHaveBeenCalled()
})

it('captures text without images for a text-only model and discloses the omission', async () => {
  getRuntime.mockResolvedValue({ supportsImageInput: false, modelProfiles: [], defaultModelProfileId: '' })
  ask.mockResolvedValue({ requestId: 'request', answer: '答案', inputMode: 'text' })
  render(<MagicNoteQuestions note={note()} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  send()
  await screen.findByText('答案')
  expect(capturePages).toHaveBeenCalledWith(1, false, 2)
  expect(ask.mock.calls[0]![0].contexts[0]!.pages[0]).toEqual({ pageId: 'page-2', text: 'Text 2' })
  expect(screen.getByRole('status')).toHaveTextContent('未查看图片')
})

it('isolates drafts, history, busy state and late responses when switching notes', async () => {
  let finish!: (result: Awaited<ReturnType<typeof ask>>) => void
  ask.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const first = note()
  const second = { ...note(), id: '00000000-0000-4000-8000-000000000609' }
  const view = render(<MagicNoteQuestions key={first.id} note={first} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  send('A 的问题')
  await waitFor(() => expect(ask).toHaveBeenCalledOnce())
  view.rerender(<MagicNoteQuestions key={second.id} note={second} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  fireEvent.change(screen.getByLabelText('自由问答'), { target: { value: 'B 的草稿' } })
  await act(async () => finish({ requestId: 'a', answer: 'A 的回答', inputMode: 'vision' }))
  expect(screen.queryByText('A 的回答')).not.toBeInTheDocument()
  expect(screen.getByLabelText('自由问答')).toHaveValue('B 的草稿')
  fireEvent.click(screen.getByRole('button', { name: '提问' }))
  await screen.findByText('答案')
  expect(ask.mock.calls[1]![0].history).toEqual([])
  view.rerender(<MagicNoteQuestions key={first.id} note={first} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  expect(screen.queryByText('答案')).not.toBeInTheDocument()
  expect(screen.getByLabelText('自由问答')).toHaveValue('')
})

it('rejects questions while the selected record is being edited', async () => {
  render(<MagicNoteQuestions note={note()} selectedEntryId={entryId} editingEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  send()
  await waitFor(() => expect(onError).toHaveBeenCalledOnce())
  expect(ask).not.toHaveBeenCalled()
  expect(screen.getByLabelText('自由问答')).toHaveValue('问题')
})

it('selects on the canvas, shows a thumbnail immediately and sends only that region', async () => {
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: async () => {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,Q1JPUA==')
  render(<MagicNoteQuestions note={note()} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  const trigger = screen.getByRole('button', { name: '框选当前页' })
  expect(trigger).toHaveClass('icon-button')
  expect(trigger).not.toHaveClass('secondary-button')
  fireEvent.click(trigger)
  await waitFor(() => expect(selectRegion).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: '取消框选' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '提问' })).toBeDisabled()
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  await act(async () => finishRegion({ x: 10, y: 20, width: 30, height: 40 }))
  const thumbnail = await screen.findByRole('img', { name: '所选区域' })
  expect(thumbnail).toHaveAttribute('src', 'data:image/png;base64,Q1JPUA==')
  expect(capturePages).toHaveBeenCalledWith(1, true, 2)
  expect(screen.getByLabelText('上下文')).toHaveValue('region')
  send('这块是什么')
  await screen.findByText('答案')
  expect(ask.mock.calls[0]![0]).toMatchObject({ scope: 'region', pageStart: 2, pageEnd: 2, contexts: [{ pages: [{ pageId: 'page-2', text: '', dataUrl: 'data:image/png;base64,Q1JPUA==' }] }] })
  fireEvent.click(screen.getByRole('button', { name: '移除截图' }))
  expect(screen.queryByRole('img', { name: '所选区域' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('上下文')).toHaveValue('page')
  Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
  vi.restoreAllMocks()
})

it('cancels canvas selection from the toggle without capturing or sending, and restores focus', async () => {
  render(<MagicNoteQuestions note={note()} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  fireEvent.click(screen.getByRole('button', { name: '框选当前页' }))
  await waitFor(() => expect(selectRegion).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '取消框选' }))
  expect(cancelRegion).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.getByRole('button', { name: '框选当前页' })).toHaveFocus())
  expect(capturePages).not.toHaveBeenCalled()
  expect(screen.queryByRole('img', { name: '所选区域' })).not.toBeInTheDocument()
  expect(ask).not.toHaveBeenCalled()
})

it('rejects a region when the page changed during selection and cancels the overlay on unmount', async () => {
  const view = render(<MagicNoteQuestions note={note()} selectedEntryId={entryId} getCanvas={getCanvas} onError={onError} />)
  fireEvent.click(screen.getByRole('button', { name: '框选当前页' }))
  await waitFor(() => expect(selectRegion).toHaveBeenCalledOnce())
  activePage.mockResolvedValueOnce(3)
  await act(async () => finishRegion({ x: 0, y: 0, width: 50, height: 50 }))
  await waitFor(() => expect(onError).toHaveBeenCalledOnce())
  expect(capturePages).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '框选当前页' }))
  await waitFor(() => expect(selectRegion).toHaveBeenCalledTimes(2))
  view.unmount()
  expect(cancelRegion).toHaveBeenCalledOnce()
})
