import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react'
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

  it('keeps Agent and conversation compression markers below the assistant message', () => {
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
        contextCompressions: [
          {
            state: 'completed',
            scope: 'agent-run',
            estimatedBeforeTokens: 24_000,
            estimatedAfterTokens: 11_000,
            compressionCount: 2
          },
          {
            state: 'completed',
            scope: 'conversation',
            estimatedBeforeTokens: 22_000,
            estimatedAfterTokens: 9_000
          }
        ],
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
      'message message--assistant',
      'context-compression-event context-compression-event--completed',
      'context-compression-event context-compression-event--completed'
    ])
    expect(
      screen.getByText(
        'Agent 执行期间已压缩上下文 2 次（估算） · ≈24.0K → ≈11.0K'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '已压缩较早对话（估算） · ≈22.0K → ≈9.0K'
      )
    ).toBeInTheDocument()
  })

  it('labels scheduled result messages with Task provenance', () => {
    const messages: Message[] = [
      {
        id: 'scheduled-result',
        role: 'assistant',
        content: '今日状态正常',
        task: {
          id: '00000000-0000-4000-8000-000000000831',
          title: '每日状态'
        },
        createdAt: 1_775_000_000_000,
        state: 'complete'
      }
    ]

    render(
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

    expect(
      screen.getByLabelText('任务结果：每日状态')
    ).toHaveTextContent('每日状态')
  })

  it('shows every parallel expert output in its own expandable card', () => {
    const messages: Message[] = [
      {
        id: 'assistant-message',
        role: 'assistant',
        content: '综合结果',
        createdAt: 1_775_000_000_000,
        state: 'complete',
        subagents: [
          {
            childTaskId: '00000000-0000-4000-8000-000000000101',
            expertId: '00000000-0000-4000-8000-000000000201',
            expertName: '研究专家',
            routingMode: 'manual',
            state: 'completed',
            output: '研究专家的独立结论'
          },
          {
            childTaskId: '00000000-0000-4000-8000-000000000102',
            expertId: '00000000-0000-4000-8000-000000000202',
            expertName: '代码专家',
            routingMode: 'manual',
            state: 'completed',
            output: '代码专家的独立结论'
          },
          {
            childTaskId: '00000000-0000-4000-8000-000000000103',
            expertId: '00000000-0000-4000-8000-000000000203',
            expertName: '安全专家',
            routingMode: 'manual',
            state: 'completed',
            output: '安全专家的独立结论'
          }
        ]
      }
    ]
    render(
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

    const region = screen.getByLabelText('子代理状态')
    const summary = screen.getByText('综合结果').parentElement
    const messageBody = region.parentElement
    expect(summary?.parentElement).toBe(messageBody)
    expect(
      Array.from(messageBody?.children ?? []).indexOf(region)
    ).toBeGreaterThan(
      Array.from(messageBody?.children ?? []).indexOf(summary!)
    )
    const cards = within(region).getAllByRole('group')
    expect(cards).toHaveLength(3)
    const experts = ['研究专家', '代码专家', '安全专家']
    for (const [index, output] of [
      '研究专家的独立结论',
      '代码专家的独立结论',
      '安全专家的独立结论'
    ].entries()) {
      expect(
        within(cards[index]!).queryByText(output)
      ).not.toBeInTheDocument()
      expect(cards[index]).not.toHaveAttribute('open')
      fireEvent.click(
        within(cards[index]!).getByText(experts[index]!, {
          selector: 'strong'
        })
      )
      fireEvent(cards[index]!, new Event('toggle'))
      expect(cards[index]).toHaveAttribute('open')
      expect(within(cards[index]!).getByText(output)).toBeInTheDocument()
    }
  })

  it('labels native OpenCode subagents and shows their task description', () => {
    const messages: Message[] = [
      {
        id: 'assistant-message',
        role: 'assistant',
        content: '',
        createdAt: 1_775_000_000_000,
        state: 'streaming',
        blocks: [
          {
            id: '00000000-0000-4000-8000-000000000121',
            type: 'reasoning',
            content: '先分析桌面目录'
          },
          {
            id: '00000000-0000-4000-8000-000000000122',
            type: 'subagent',
            childTaskId:
              '00000000-0000-4000-8000-000000000111'
          },
          {
            id: '00000000-0000-4000-8000-000000000123',
            type: 'text',
            content: '父 Agent 最终回复'
          }
        ],
        subagents: [
          {
            childTaskId: '00000000-0000-4000-8000-000000000111',
            expertId: '00000000-0000-4000-8000-000000000211',
            expertName: 'explorer',
            routingMode: 'native',
            runtimeCallId: 'call-task-1',
            state: 'running',
            reason: 'Review application architecture'
          }
        ]
      }
    ]

    render(
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

    expect(screen.getByText('子代理')).toBeInTheDocument()
    expect(screen.getByText('OpenCode 原生')).toBeInTheDocument()
    expect(screen.getByText('任务')).toBeInTheDocument()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(
      screen.getByText('Review application architecture')
    ).toBeInTheDocument()
    const assistantArticle = screen
      .getByText('父 Agent 最终回复')
      .closest('article')
    const orderedBlocks = [
      ...assistantArticle!.querySelectorAll('.message-blocks > *')
    ].map((element) => element.textContent)
    expect(orderedBlocks).toEqual([
      expect.stringContaining('先分析桌面目录'),
      expect.stringContaining('Review application architecture'),
      expect.stringContaining('父 Agent 最终回复')
    ])
  })
})
