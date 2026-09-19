import { act, render } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MagicCanvasEditor, type MagicCanvasEditorHandle, createEmptyCanvasContent } from './MagicCanvasEditor'
import { toCoreContent } from './magic-canvas/model'

const mock = vi.hoisted(() => ({ mount: vi.fn() }))
vi.mock('./magic-canvas/canvas-note.mjs', () => ({ mountCanvasNote: mock.mount }))

describe('MagicCanvasEditor lifecycle', () => {
  beforeEach(() => mock.mount.mockReset())

  it('aborts old asynchronous callbacks and destroys every StrictMode instance', async () => {
    const content = createEmptyCanvasContent()
    const controllers: { destroy: ReturnType<typeof vi.fn>; options: { signal: AbortSignal; onChange: (value: unknown) => void } }[] = []
    mock.mount.mockImplementation((_host, core, options) => {
      const controller = { options, destroy: vi.fn(async () => {}), content: () => core, flush: async () => core, setDisabled: vi.fn(), focus: vi.fn(), capturePages: async () => [] }
      controllers.push(controller)
      return controller
    })
    const onChange = vi.fn()
    const view = render(<StrictMode><MagicCanvasEditor initialContent={content} onChange={onChange} onError={vi.fn()} /></StrictMode>)
    await act(async () => {})
    expect(controllers).toHaveLength(2)
    expect(controllers[0]!.options.signal.aborted).toBe(true)
    controllers[0]!.options.onChange(toCoreContent(content))
    expect(onChange).not.toHaveBeenCalled()
    view.unmount()
    for (const controller of controllers) {
      expect(controller.destroy).toHaveBeenCalledOnce()
      expect(controller.options.signal.aborted).toBe(true)
    }
  })

  it('flush waits for the core queue and current callbacks do not remount the editor', async () => {
    const content = createEmptyCanvasContent()
    const core = toCoreContent(content)
    let finish!: (value: typeof core) => void
    const pending = new Promise<typeof core>((resolve) => { finish = resolve })
    const capturePages = vi.fn(async () => [{ pageId: core.pages[0]!.id, dataUrl: 'data:image/png;base64,AAAA' }])
    const controller = { destroy: vi.fn(async () => {}), content: () => core, flush: vi.fn(() => pending), setDisabled: vi.fn(), focus: vi.fn(), capturePages }
    mock.mount.mockReturnValue(controller)
    const ref = createRef<MagicCanvasEditorHandle>()
    const first = vi.fn()
    const second = vi.fn()
    const view = render(<MagicCanvasEditor ref={ref} initialContent={content} onChange={first} onError={vi.fn()} />)
    const flushed = ref.current!.flush()
    let settled = false
    void flushed.then(() => { settled = true })
    await act(async () => {})
    expect(settled).toBe(false)
    view.rerender(<MagicCanvasEditor ref={ref} initialContent={content} onChange={second} onError={vi.fn()} disabled />)
    expect(mock.mount).toHaveBeenCalledOnce()
    expect(mock.mount.mock.calls[0]![2].disabled).toBe(true)
    await act(async () => { finish(core) })
    expect(controller.setDisabled).toHaveBeenLastCalledWith(true)
    expect(await flushed).toEqual(content)
    const options = mock.mount.mock.calls[0]![2]
    expect(options.signal.aborted).toBe(false)
    act(() => options.onChange(core))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
    expect(await ref.current!.capturePages()).toHaveLength(1)
    ref.current!.focus()
    expect(controller.focus).toHaveBeenCalledOnce()
    view.unmount()
  })

  it('reports the initialized flush as the baseline before enabling edits and ignores stale initialization', async () => {
    const content = createEmptyCanvasContent()
    const normalized = { ...toCoreContent(content), flow: { version: 1 as const, ops: [{ insert: 'Normalized\n' }] } }
    const complete: (() => void)[] = []
    const controllers: { setDisabled: ReturnType<typeof vi.fn> }[] = []
    mock.mount.mockImplementation((_host, core) => {
      const pending = new Promise<typeof normalized>((resolve) => complete.push(() => resolve(normalized)))
      const controller = { destroy: vi.fn(async () => {}), content: () => core, flush: vi.fn(() => pending), setDisabled: vi.fn(), focus: vi.fn() }
      controllers.push(controller)
      return controller
    })
    const onReady = vi.fn()
    const onChange = vi.fn()
    const ref = createRef<MagicCanvasEditorHandle>()
    const view = render(<StrictMode><MagicCanvasEditor ref={ref} initialContent={content} onReady={onReady} onChange={onChange} onError={vi.fn()} /></StrictMode>)
    const flushed = ref.current!.flush()
    await act(async () => complete[0]!())
    expect(onReady).not.toHaveBeenCalled()
    expect(controllers[0]!.setDisabled).not.toHaveBeenCalled()
    await act(async () => complete[1]!())
    expect(onReady).toHaveBeenCalledOnce()
    expect(onReady).toHaveBeenCalledWith(await flushed)
    expect(onChange).not.toHaveBeenCalled()
    expect(controllers[1]!.setDisabled).toHaveBeenLastCalledWith(false)
    view.unmount()
  })
})
