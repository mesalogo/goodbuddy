import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChatTimeline,
  type Message
} from './ChatTimeline'

const markdownRenderProbe = vi.hoisted(() => vi.fn())
const htmlRenderProbe = vi.hoisted(() => vi.fn())
const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
).replaceAll('\r\n', '\n')

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({
    children,
    renderHtml
  }: {
    children: string
    renderHtml?: boolean
  }) => {
    markdownRenderProbe(children)
    if (renderHtml) {
      htmlRenderProbe(children)
    }
    return <span>{children}</span>
  }
}))

const callbacks = {
  onArticleRef: vi.fn(),
  onCopyMessage: vi.fn(async () => undefined),
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

  it('shows only known waiting and tool states in a static message footer', () => {
    const props = {
      artifactById: new Map(), conversationId: 'status-conversation',
      hiddenMessageCount: 0, isUnusedConversation: false, locale: 'zh-CN' as const,
      messageStartIndex: 0, ...callbacks, retryContent: '', totalMessageCount: 1
    }
    const message: Message = {
      id: 'status-message', role: 'assistant', content: '已有内容',
      createdAt: Date.now(), state: 'streaming'
    }
    const { rerender } = render(<ChatTimeline {...props} messages={[message]} />)
    expect(screen.getByRole('status', { name: '等待后续进展' })).toBeVisible()
    expect(document.querySelector('.message__status-dot--active')).toBeNull()
    const tool = { callId: 'read-1', name: 'read', summary: 'Read file' }
    rerender(<ChatTimeline {...props} messages={[{
      ...message, tools: [{ ...tool, state: 'pending' }]
    }]} />)
    expect(screen.getByRole('status', { name: '工具待执行：read' })).toBeVisible()
    rerender(<ChatTimeline {...props} messages={[{
      ...message, tools: [{ ...tool, state: 'running' }]
    }]} />)
    expect(screen.getByRole('status', { name: '工具执行中：read' })).toBeVisible()
    rerender(<ChatTimeline {...props} messages={[{
      ...message, tools: [{ ...tool, state: 'completed' }]
    }]} />)
    expect(screen.getByRole('status', { name: '等待后续进展' })).toBeVisible()
    rerender(<ChatTimeline {...props} messages={[{
      ...message, status: 'OpenCode 正在处理请求',
      question: {
        requestId: 'question-request', type: 'question', questionId: 'q-1',
        questions: [{ header: '确认', question: '继续吗？', options: [], custom: true, multiple: false }]
      }
    }]} />)
    expect(screen.getByRole('status', { name: '等待你的回答' })).toBeVisible()
    expect(screen.queryByText('OpenCode 正在处理请求')).not.toBeInTheDocument()
    rerender(<ChatTimeline {...props} messages={[{
      ...message, state: 'error', status: '模型请求失败'
    }]} />)
    expect(screen.getByRole('alert', { name: '模型请求失败' })).toBeVisible()
    expect(screen.queryByText('等待后续进展')).not.toBeInTheDocument()
  })

  it('uses actual message heights for the conversation scroll range', () => {
    const rule = stylesheet.match(/\.message\s*\{([^}]*)\}/u)?.[1]

    expect(rule).toBeDefined()
    expect(rule).not.toContain('content-visibility')
    expect(rule).not.toContain('contain-intrinsic')
  })

  it('places message identity above the message body', () => {
    const messages: Message[] = [
      {
        id: 'assistant-message',
        role: 'assistant',
        content: 'Answer',
        createdAt: 1_775_000_000_000,
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

    const message = container.querySelector('.message')
    const header = message?.querySelector('.message__header')
    const body = message?.querySelector('.message__body')

    expect(header).toContainElement(message?.querySelector('.message__avatar') ?? null)
    expect(header).toContainElement(message?.querySelector('.message__meta') ?? null)
    expect(Array.from(message?.children ?? [])).toEqual([header, body])
  })

  it('enables HTML rendering only for completed Agent output', () => {
    const messages: Message[] = [
      {
        id: 'user-message',
        role: 'user',
        content: '<div>User HTML</div>',
        createdAt: 1_775_000_000_000,
        state: 'complete'
      },
      {
        id: 'streaming-message',
        role: 'assistant',
        content: '<div>Streaming HTML</div>',
        createdAt: 1_775_000_001_000,
        state: 'streaming'
      },
      {
        id: 'complete-message',
        role: 'assistant',
        content: '<div>Complete HTML</div>',
        reasoning: '<div>Reasoning HTML</div>',
        createdAt: 1_775_000_002_000,
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
        renderAssistantHtml
        retryContent=""
        totalMessageCount={messages.length}
      />
    )

    expect(htmlRenderProbe).toHaveBeenCalledTimes(1)
    expect(htmlRenderProbe).toHaveBeenCalledWith(
      '<div>Complete HTML</div>'
    )
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

    const mapMessages = vi.spyOn(messages, 'map')
    rerender(<ChatTimeline {...props} messages={messages} />)
    expect(mapMessages).not.toHaveBeenCalled()
    expect(markdownRenderProbe).not.toHaveBeenCalled()
    mapMessages.mockRestore()

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

  it('copies a completed assistant reply from its bottom action', () => {
    const messages: Message[] = [
      {
        id: 'assistant-message',
        role: 'assistant',
        content: '## Answer\n\nKeep the Markdown source.',
        reasoning: 'private reasoning',
        createdAt: 1_775_000_000_000,
        state: 'complete'
      },
      {
        id: 'streaming-message',
        role: 'assistant',
        content: 'Partial answer',
        createdAt: 1_775_000_001_000,
        state: 'streaming'
      },
      {
        id: 'user-message',
        role: 'user',
        content: 'User content',
        createdAt: 1_775_000_002_000,
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

    const copyButton = screen.getByRole('button', {
      name: '复制此回复'
    })
    expect(copyButton).toHaveAttribute('title', '复制此回复')
    expect(
      screen.getAllByRole('button', { name: '复制此回复' })
    ).toHaveLength(1)

    fireEvent.click(copyButton)

    expect(callbacks.onCopyMessage).toHaveBeenCalledOnce()
    expect(callbacks.onCopyMessage).toHaveBeenCalledWith(
      '## Answer\n\nKeep the Markdown source.'
    )
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

  it('renders live child progress in order and keeps the final result separate', () => {
    const child = {
      childTaskId: '00000000-0000-4000-8000-000000000111',
      expertId: '00000000-0000-4000-8000-000000000211',
      expertName: 'general', routingMode: 'native' as const,
      state: 'running' as const,
      progress: [
        { id: 'text', type: 'text' as const, content: 'Inspecting seed' },
        { id: 'tool', type: 'tool' as const, tool: {
          callId: 'read', name: 'read', state: 'completed' as const,
          summary: 'Read seed', output: 'seed contents'
        } },
        { id: 'reasoning', type: 'reasoning' as const, content: 'Check the result' }
      ]
    }
    const props = {
      artifactById: new Map(), conversationId: 'conversation-1',
      hiddenMessageCount: 0, isUnusedConversation: false, locale: 'zh-CN' as const,
      messageStartIndex: 0, ...callbacks, retryContent: '', totalMessageCount: 1
    }
    const message: Message = {
      id: 'assistant', role: 'assistant', content: '', createdAt: 0,
      state: 'streaming', subagents: [child]
    }
    const view = render(<ChatTimeline {...props} messages={[message]} />)
    expect(screen.queryByText('Inspecting seed')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('general', { selector: 'strong' }))
    fireEvent(screen.getByText('general', { selector: 'strong' }).closest('details')!, new Event('toggle'))
    const progress = screen.getByRole('region', { name: '执行过程' })
    expect(within(progress).getByText('Inspecting seed')).toBeInTheDocument()
    expect(within(progress).getByText('Check the result').closest('details')).not.toHaveAttribute('open')
    expect(screen.queryByRole('region', { name: '最终结果' })).not.toBeInTheDocument()
    view.rerender(<ChatTimeline {...props} messages={[{
      ...message, state: 'complete',
      subagents: [{ ...child, state: 'completed', output: 'Final seed' }]
    }]} />)
    expect(screen.getByRole('region', { name: '最终结果' })).toHaveTextContent('Final seed')
    expect(screen.getByRole('region', { name: '执行过程' })).not.toHaveTextContent('Final seed')
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

  it('labels direct-model subagents with their inherited work mode', () => {
    const messages: Message[] = [
      {
        id: 'assistant-message',
        role: 'assistant',
        content: '',
        createdAt: 1_775_000_000_000,
        state: 'streaming',
        subagents: [
          {
            childTaskId: '00000000-0000-4000-8000-000000000131',
            actor: {
              kind: 'direct-model',
              label: '编程 Subagent'
            },
            routingMode: 'native',
            workMode: 'execute',
            state: 'running',
            reason: '修复并验证聚焦变更'
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
    expect(
      within(region).getByText('编程 Subagent', {
        selector: 'strong'
      })
    ).toBeInTheDocument()
    expect(within(region).getByText('直连模型 · Execute'))
      .toBeInTheDocument()
    expect(
      within(region).getByText('修复并验证聚焦变更')
    ).toBeInTheDocument()
  })

  it('uses one live source per event without announcing historical tool rows', () => {
    const messages: Message[] = [
      {
        id: 'working',
        role: 'assistant',
        content: 'streamed reply body',
        createdAt: 1_775_000_000_000,
        state: 'streaming',
        status: 'Preparing tools'
      },
      {
        id: 'approval',
        role: 'assistant',
        content: '',
        createdAt: 1_775_000_000_001,
        state: 'complete',
        approval: {
          id: 'approval-1',
          title: 'Write workspace file',
          description: 'Update release.md',
          toolName: 'write_file'
        }
      },
      {
        id: 'failed',
        role: 'assistant',
        content: 'bounded failure context',
        createdAt: 1_775_000_000_002,
        state: 'error',
        status: 'Runtime connection failed'
      },
      {
        id: 'tool-history',
        role: 'assistant',
        content: '',
        createdAt: 1_775_000_000_003,
        state: 'complete',
        tools: [
          {
            callId: 'tool-1',
            name: 'read_file',
            summary: 'Read the file',
            state: 'completed'
          }
        ],
        subagents: [
          {
            childTaskId: 'subagent-1',
            expertId: 'expert-1',
            expertName: 'reviewer',
            routingMode: 'manual',
            state: 'completed'
          }
        ]
      },
      {
        id: 'retrieval',
        role: 'assistant',
        content: '',
        createdAt: 1_775_000_000_004,
        state: 'complete',
        status: 'Knowledge search complete',
        knowledgeRetrieval: {
          mode: 'always',
          state: 'succeeded',
          libraryCount: 1,
          resultCount: 2,
          durationMs: 20,
          usedChannels: ['fts'],
          warnings: []
        }
      },
      {
        id: 'compression',
        role: 'assistant',
        content: '',
        createdAt: 1_775_000_000_005,
        state: 'complete',
        status: 'Context compression complete',
        contextCompression: {
          state: 'completed',
          estimatedBeforeTokens: 20_000,
          estimatedAfterTokens: 8_000
        }
      }
    ]

    const { container } = render(
      <ChatTimeline
        artifactById={new Map()}
        conversationId="conversation-1"
        hiddenMessageCount={0}
        isUnusedConversation={false}
        locale="en-US"
        messageStartIndex={0}
        messages={messages}
        {...callbacks}
        retryContent=""
        totalMessageCount={messages.length}
      />
    )

    expect(
      screen.getByRole('status', { name: 'Preparing tools' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('status', {
        name: '等待审批：write_file'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('alert', {
        name: 'Runtime connection failed'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText('streamed reply body')
    ).not.toHaveAttribute('aria-live')
    expect(screen.getByLabelText('已完成', { selector: 'small' }))
      .not.toHaveAttribute('aria-live')
    expect(
      screen.getByLabelText('已完成', {
        selector: '.subagent-status-card__status'
      })
    ).not.toHaveAttribute('aria-live')
    expect(
      screen.getByLabelText('Knowledge search complete')
    ).not.toHaveAttribute('aria-live')
    expect(
      screen.getByLabelText('Context compression complete')
    ).not.toHaveAttribute('aria-live')
    expect(
      container.querySelectorAll('.approval-card [aria-live="polite"]')
    ).toHaveLength(1)
    expect(
      container.querySelectorAll('.message-retrieval-status[aria-live]')
    ).toHaveLength(1)
  })
})
