import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChatTimeline,
  type Message
} from './ChatTimeline'

const markdownRenderProbe = vi.hoisted(() => vi.fn())

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ children }: { children: string }) => {
    markdownRenderProbe(children)
    return <span>{children}</span>
  }
}))

const callbacks = {
  onArticleRef: vi.fn(),
  onDownloadImage: vi.fn(),
  onOpenCitationContext: vi.fn(async () => undefined),
  onOpenCitationSource: vi.fn(async () => undefined),
  onOpenImage: vi.fn(),
  onRespondApproval: vi.fn(async () => undefined),
  onRespondQuestion: vi.fn(async () => undefined),
  onRetry: vi.fn(),
  onRevealEarlier: vi.fn()
}

function createMessages(): Message[] {
  return Array.from({ length: 80 }, (_, index) => ({
    id: `message-${index}`,
    role: 'assistant',
    content: `content-${index}`,
    reasoning: index === 0 ? 'preserved reasoning' : undefined,
    createdAt: 1_775_000_000_000 + index,
    state: index === 79 ? 'streaming' : 'complete'
  }))
}

describe('ChatTimeline', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders only the immutably changed streaming row and retains unchanged DOM state', () => {
    const messages = createMessages()
    const props = {
      artifactById: new Map(),
      conversationId: 'conversation-1',
      hiddenMessageCount: 0,
      isUnusedConversation: false,
      locale: 'en-US' as const,
      messageStartIndex: 0,
      ...callbacks,
      retryContent: '',
      totalMessageCount: messages.length
    }
    const { container, rerender } = render(
      <ChatTimeline {...props} messages={messages} />
    )
    const unchangedArticle = container.querySelectorAll('article')[0]
    const unchangedDetails =
      unchangedArticle?.querySelector<HTMLDetailsElement>(
        '.message-reasoning'
      )
    expect(unchangedArticle).toBeTruthy()
    expect(unchangedDetails).toBeTruthy()
    unchangedDetails!.open = true
    markdownRenderProbe.mockClear()

    const streamedMessages = messages.map((message, index) =>
      index === messages.length - 1
        ? { ...message, content: `${message.content} delta` }
        : message
    )
    rerender(<ChatTimeline {...props} messages={streamedMessages} />)

    expect(markdownRenderProbe).toHaveBeenCalledTimes(1)
    expect(markdownRenderProbe).toHaveBeenCalledWith(
      'content-79 delta'
    )
    expect(container.querySelectorAll('article')[0]).toBe(
      unchangedArticle
    )
    expect(unchangedDetails).toHaveAttribute('open')
  })

  it('places compression progress between the user and assistant messages', () => {
    const messages: Message[] = [
      {
        id: 'user-message',
        role: 'user',
        content: 'Continue',
        createdAt: 1_775_000_000_000,
        state: 'complete'
      },
      {
        id: 'assistant-message',
        role: 'assistant',
        content: 'Answer',
        contextCompression: {
          state: 'completed',
          estimatedBeforeTokens: 22_000,
          estimatedAfterTokens: 9_000
        },
        createdAt: 1_775_000_001_000,
        state: 'complete'
      }
    ]
    const { container } = render(
      <ChatTimeline
        artifactById={new Map()}
        conversationId="conversation-1"
        hiddenMessageCount={0}
        isUnusedConversation={false}
        locale="zh-CN"
        messageStartIndex={0}
        messages={messages}
        {...callbacks}
        retryContent=""
        totalMessageCount={messages.length}
      />
    )

    const children = Array.from(
      container.querySelector('.message-list')?.children ?? []
    )
    expect(children.map((element) => element.className)).toEqual([
      'message message--user',
      'context-compression-event context-compression-event--completed',
      'message message--assistant'
    ])
    expect(
      screen.getByRole('status')
    ).toHaveTextContent('已压缩较早对话 · ≈22.0K → ≈9.0K')
  })
})
