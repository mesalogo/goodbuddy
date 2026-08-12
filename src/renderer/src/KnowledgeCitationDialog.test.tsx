import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeSearchReference } from '../../shared/contracts'
import { KnowledgeCitationDialog } from './KnowledgeCitationDialog'
import i18n from './i18n'

const reference: KnowledgeSearchReference = {
  libraryId: '11111111-1111-4111-8111-111111111111',
  libraryName: '产品知识',
  documentId: '22222222-2222-4222-8222-222222222222',
  chunkId: '33333333-3333-4333-8333-333333333333',
  documentName: '发布手册',
  sourceName: 'release.md',
  locator: '发布流程',
  snippet: '先验证，再发布。',
  rank: -0.03,
  score: 0.82,
  retrievalChannels: ['fts', 'vector']
}

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('zh-CN')
})

describe('KnowledgeCitationDialog', () => {
  it('shows matched and surrounding context and restores close behavior', async () => {
    const onClose = vi.fn()
    const onOpenSource = vi.fn(async () => undefined)
    render(
      <KnowledgeCitationDialog
        context={{
          libraryName: '产品知识',
          documentName: '发布手册',
          sourceName: 'release.md',
          locator: '发布流程',
          matchedContent: '先验证，再发布。',
          contextContent: '准备发布。先验证，再发布。发布后观察指标。'
        }}
        onClose={onClose}
        onOpenSource={onOpenSource}
        reference={reference}
      />
    )

    expect(screen.getByRole('dialog', { name: '引用上下文' }))
      .toBeInTheDocument()
    expect(screen.getByText('先验证，再发布。')).toBeInTheDocument()
    expect(
      screen.getByText('准备发布。先验证，再发布。发布后观察指标。')
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: '关闭引用上下文' })[0]
      )
        .toHaveFocus()
    )

    fireEvent.click(screen.getByRole('button', { name: '打开来源' }))
    await waitFor(() =>
      expect(onOpenSource).toHaveBeenCalledWith(reference.documentId)
    )

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps an actionable source-opening error in the dialog', async () => {
    render(
      <KnowledgeCitationDialog
        context={{
          libraryName: '产品知识',
          documentName: '发布手册',
          sourceName: 'release.md',
          matchedContent: '证据',
          contextContent: '证据上下文'
        }}
        onClose={vi.fn()}
        onOpenSource={async () => {
          throw new Error('原文件已移动')
        }}
        reference={reference}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '打开来源' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '原文件已移动'
    )
  })
})
