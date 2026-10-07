/// <reference types="node" />

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Quill from 'quill'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MagicNoteRichContent } from '../../shared/magic-notes-contracts'
import { MagicNoteEditor } from './MagicNoteEditor'

const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
)

describe('MagicNoteEditor', () => {
  afterEach(cleanup)

  it('establishes the baseline from real Quill normalization and reports later edits separately', () => {
    const onReady = vi.fn()
    const onChange = vi.fn()
    const { container, unmount } = render(<MagicNoteEditor ariaLabel="笔记正文" initialContent={{ version: 1, ops: [{ insert: 'Saved' }] }} onReady={onReady} onChange={onChange} onError={vi.fn()} />)
    expect(onReady).toHaveBeenCalledWith({ version: 1, ops: [{ insert: 'Saved\n' }] })
    const quill = Quill.find(container.querySelector('.ql-container')!) as Quill
    quill.setText('Changed', 'user')
    expect(onReady).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith({ version: 1, ops: [{ insert: 'Changed\n' }] })
    unmount()
  })

  it('emits the initial document when no readiness callback is supplied', () => {
    const onChange = vi.fn()
    const { unmount } = render(<MagicNoteEditor ariaLabel="笔记正文" onChange={onChange} onError={vi.fn()} />)
    expect(onChange).toHaveBeenCalledWith({ version: 1, ops: [{ insert: '\n' }] })
    unmount()
  })

  it('normalizes persisted formatted Delta field order without reporting a new edit', () => {
    const stored: MagicNoteRichContent = { version: 1, ops: [{ insert: 'Saved', attributes: { bold: true } }, { insert: '\n' }] }
    const onReady = vi.fn()
    const onChange = vi.fn()
    const { unmount } = render(<MagicNoteEditor ariaLabel="笔记正文" initialContent={stored} onReady={onReady} onChange={onChange} onError={vi.fn()} />)
    const normalized = onReady.mock.calls[0]![0]
    expect(normalized).toEqual(stored)
    expect(JSON.stringify(normalized)).not.toBe(JSON.stringify(stored))
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(normalized)
    unmount()
  })

  it('round-trips non-empty table content through the editor baseline', () => {
    const initialContent: MagicNoteRichContent = {
      version: 1,
      ops: [
        { insert: 'Name' },
        { insert: '\n', attributes: { table: 'table-1' } },
        { insert: 'Value' },
        { insert: '\n', attributes: { table: 'table-1' } }
      ]
    }
    const onReady = vi.fn()
    const { container } = render(
      <MagicNoteEditor
        ariaLabel="笔记正文"
        initialContent={initialContent}
        onChange={vi.fn()}
        onReady={onReady}
        onError={vi.fn()}
      />
    )

    expect(onReady.mock.calls[0]![0].ops).toEqual(initialContent.ops)
    expect(container.querySelectorAll('.ql-editor table td')).toHaveLength(2)
    expect(container.querySelector('.ql-editor')).toHaveTextContent('NameValue')
  })
  it('uses the themed muted text color for its placeholder', () => {
    expect(stylesheet).toMatch(
      /\.magic-note-editor__content\s+\.ql-editor\.ql-blank::before\s*\{\s*color:\s*var\(--text-muted\);\s*\}/
    )
  })

  it('exposes numeric font sizes, text color, and attachment controls', () => {
    const { container } = render(
      <MagicNoteEditor
        ariaLabel="笔记正文"
        onChange={vi.fn()}
        onError={vi.fn()}
      />
    )

    expect(
      screen.getByRole('toolbar', { name: '笔记格式工具栏' })
    ).toBeInTheDocument()
    expect(container.querySelectorAll('.ql-formats')).toHaveLength(5)
    expect(screen.getByLabelText('字体大小')).toBeInTheDocument()
    expect(
      Array.from(
        container.querySelectorAll('.ql-size .ql-picker-item'),
        (item) => item.getAttribute('data-label')
      )
    ).toEqual(['12', '14', '18', '24'])
    expect(screen.getByLabelText('字体颜色')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '上传视频或附件' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '插入表格' })
    ).toBeInTheDocument()
  })

  it('opens a validated table dialog, supports cancellation, and restores focus', async () => {
    const onChange = vi.fn<(content: MagicNoteRichContent) => void>()
    const { container } = render(
      <MagicNoteEditor
        ariaLabel="笔记正文"
        onChange={onChange}
        onError={vi.fn()}
      />
    )

    const tableButton = container.querySelector<HTMLButtonElement>('.ql-table')!
    expect(tableButton).toBeEnabled()
    expect(container.querySelector('.magic-note-editor__table-toolbar')).toBeNull()
    const prompt = vi.spyOn(window, 'prompt')
    fireEvent.click(tableButton)

    const dialog = await screen.findByRole('dialog', { name: '插入表格' })
    expect(prompt).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByLabelText('行数（1-20）'), {
      target: { value: '21' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '插入表格' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('行数必须为 1-20')
    expect(onChange).toHaveBeenCalledOnce()

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(document.activeElement).toBe(tableButton)
    expect(container.querySelector('.ql-editor table')).toBeNull()
  })

  it('inserts and mutates a native Quill table through separate table actions', async () => {
    const onChange = vi.fn<(content: MagicNoteRichContent) => void>()
    const { container } = render(
      <MagicNoteEditor
        ariaLabel="笔记正文"
        onChange={onChange}
        onError={vi.fn()}
      />
    )

    fireEvent.click(container.querySelector<HTMLButtonElement>('.ql-table')!)
    const dialog = await screen.findByRole('dialog', { name: '插入表格' })
    fireEvent.click(within(dialog).getByRole('button', { name: '插入表格' }))

    await waitFor(() => {
      const content = onChange.mock.calls.at(-1)?.[0]
      const tableCells =
        content?.ops.filter((operation) => operation.attributes?.table)
      expect(tableCells).toHaveLength(3)
      expect(container.querySelectorAll('.ql-editor table td')).toHaveLength(9)
    })

    expect(container.querySelector('.magic-note-editor__table-toolbar')).toBeInTheDocument()

    fireEvent.click(
      container.querySelector<HTMLButtonElement>('.magic-note-editor__table-action--row-below')!
    )
    await waitFor(() => {
      expect(container.querySelectorAll('.ql-editor table tr')).toHaveLength(4)
    })
    const quill = Quill.find(container.querySelector('.ql-container')!) as Quill
    quill.history.undo()
    await waitFor(() => {
      expect(container.querySelectorAll('.ql-editor table tr')).toHaveLength(3)
    })

    fireEvent.click(
      container.querySelector<HTMLButtonElement>('.magic-note-editor__table-action--row-below')!
    )
    await waitFor(() => {
      expect(container.querySelectorAll('.ql-editor table tr')).toHaveLength(4)
    })

    fireEvent.click(
      container.querySelector<HTMLButtonElement>('.magic-note-editor__table-action--column-right')!
    )
    await waitFor(() => {
      expect(container.querySelectorAll('.ql-editor table td')).toHaveLength(16)
    })

    fireEvent.click(
      container.querySelector<HTMLButtonElement>('.magic-note-editor__table-action--delete-row')!
    )
    await waitFor(() => {
      expect(container.querySelectorAll('.ql-editor table tr')).toHaveLength(3)
      expect(container.querySelectorAll('.ql-editor table td')).toHaveLength(12)
    })

    fireEvent.click(
      container.querySelector<HTMLButtonElement>('.magic-note-editor__table-action--delete-column')!
    )
    await waitFor(() => {
      expect(container.querySelectorAll('.ql-editor table td')).toHaveLength(9)
    })

    fireEvent.click(
      container.querySelector<HTMLButtonElement>('.magic-note-editor__table-action--delete-table')!
    )
    await waitFor(() => {
      expect(container.querySelector('.ql-editor table')).toBeNull()
    })
  })

  it('allows deleting the last row and column without corrupting the document', async () => {
    const onChange = vi.fn<(content: MagicNoteRichContent) => void>()
    const { container } = render(
      <MagicNoteEditor
        ariaLabel="笔记正文"
        onChange={onChange}
        onError={vi.fn()}
      />
    )
    fireEvent.click(container.querySelector<HTMLButtonElement>('.ql-table')!)
    const dialog = await screen.findByRole('dialog', { name: '插入表格' })
    fireEvent.change(within(dialog).getByLabelText('行数（1-20）'), { target: { value: '1' } })
    fireEvent.change(within(dialog).getByLabelText('列数（1-12）'), { target: { value: '1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '插入表格' }))

    await waitFor(() => expect(container.querySelectorAll('.ql-editor table td')).toHaveLength(1))
    fireEvent.click(container.querySelector<HTMLButtonElement>('.magic-note-editor__table-action--delete-row')!)
    await waitFor(() => expect(container.querySelectorAll('.ql-editor table td')).toHaveLength(0))
    expect(container.querySelector('.magic-note-editor__table-toolbar')).toBeNull()
  })

  it.each([
    ['-', 'bullet'],
    ['*', 'bullet'],
    ['1.', 'ordered'],
    ['[ ]', 'unchecked'],
    ['[x]', 'checked']
  ])(
    'keeps the native Quill %s list shortcut enabled',
    async (marker, expectedList) => {
      const onChange = vi.fn<(content: MagicNoteRichContent) => void>()
      const { container } = render(
        <MagicNoteEditor
          ariaLabel="笔记正文"
          onChange={onChange}
          onError={vi.fn()}
        />
      )
      const editor = container.querySelector<HTMLElement>('.ql-editor')
      const quillContainer = container.querySelector<HTMLElement>(
        '.magic-note-editor__content'
      )
      expect(editor).not.toBeNull()
      expect(quillContainer).not.toBeNull()

      const quill = Quill.find(quillContainer!) as Quill
      quill.setText(marker, 'user')
      quill.setSelection(marker.length, 0, 'silent')
      fireEvent.keyDown(editor!, { key: ' ' })

      await waitFor(() => {
        const content = onChange.mock.calls.at(-1)?.[0]
        expect(
          content?.ops.some(
            (operation) => operation.attributes?.list === expectedList
          )
        ).toBe(true)
      })
    }
  )

  it('intercepts a pasted image before Quill and inserts it once', async () => {
    const onChange = vi.fn<(content: MagicNoteRichContent) => void>()
    const { container } = render(
      <MagicNoteEditor
        ariaLabel="笔记正文"
        onChange={onChange}
        onError={vi.fn()}
      />
    )
    const editor = container.querySelector('.ql-editor')
    expect(editor).not.toBeNull()
    const image = new File(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
        ])
      ],
      'pasted.png',
      { type: 'image/png' }
    )

    fireEvent.paste(editor!, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => image
          }
        ]
      }
    })

    await waitFor(() => {
      const latestContent = onChange.mock.calls.at(-1)?.[0]
      const images =
        latestContent?.ops.filter(
          (operation) =>
            typeof operation.insert === 'object' &&
            'image' in operation.insert
        ) ?? []
      expect(images).toHaveLength(1)
    })
  })

  it('accepts uploaded attachments and pasted local videos', async () => {
    const onChange = vi.fn<(content: MagicNoteRichContent) => void>()
    const { container } = render(
      <MagicNoteEditor
        ariaLabel="笔记正文"
        onChange={onChange}
        onError={vi.fn()}
      />
    )
    const fileInputs = container.querySelectorAll<HTMLInputElement>(
      'input[type="file"]'
    )
    const attachment = new File(['notes'], 'notes.txt', {
      type: 'text/plain'
    })
    fireEvent.change(fileInputs[1]!, {
      target: { files: [attachment] }
    })

    await waitFor(() => {
      const content = onChange.mock.calls.at(-1)?.[0]
      expect(
        content?.ops.some(
          (operation) =>
            typeof operation.insert === 'object' &&
            'attachment' in operation.insert
        )
      ).toBe(true)
    })

    const video = new File(
      [
        new Uint8Array([
          0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
          0x69, 0x73, 0x6f, 0x6d
        ])
      ],
      'demo.mp4',
      { type: 'video/mp4' }
    )
    fireEvent.paste(container.querySelector('.ql-editor')!, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => video
          }
        ]
      }
    })

    await waitFor(() => {
      const content = onChange.mock.calls.at(-1)?.[0]
      const videos =
        content?.ops.filter(
          (operation) =>
            typeof operation.insert === 'object' &&
            'localVideo' in operation.insert
        ) ?? []
      expect(videos).toHaveLength(1)
    })
  })
})
