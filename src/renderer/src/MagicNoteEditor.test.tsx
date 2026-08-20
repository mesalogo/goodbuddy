/// <reference types="node" />

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MagicNoteRichContent } from '../../shared/magic-notes-contracts'
import { MagicNoteEditor } from './MagicNoteEditor'

const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
)

describe('MagicNoteEditor', () => {
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
  })

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
