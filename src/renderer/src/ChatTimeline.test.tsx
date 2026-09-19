import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChatTimeline,
  type Message
} from './ChatTimeline'

const markdownRenderProbe = vi.hoisted(() => vi.fn())
const htmlRenderProbe = vi.hoisted(() => vi.fn())
const toolRowRenderProbe = vi.hoisted(() => vi.fn())
const toolDetailRenderProbe = vi.hoisted(() => vi.fn())

vi.mock('lucide-react', async (importOriginal) => {
  const icons = await importOriginal<typeof import('lucide-react')>()
  return {
    ...icons,
    Check: (props: ComponentProps<typeof icons.Check>) => {
      toolRowRenderProbe()
      return <icons.Check {...props} />
    },
    Copy: (props: ComponentProps<typeof icons.Copy>) => {
      toolDetailRenderProbe()
      return <icons.Copy {...props} />
    }
  }
})
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
  onCopyMessage: vi.fn(async () => true),
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
  it('keeps a question before later tools and text when its answer arrives and history reopens', () => {
    const props = {
      artifactById: new Map(), conversationId: 'question-order',
      hiddenMessageCount: 0, isUnusedConversation: false, locale: 'zh-CN' as const,
      messageStartIndex: 0, ...callbacks, retryContent: '', totalMessageCount: 1
    }
    const question = {
      requestId: 'request', type: 'question' as const, questionId: 'question-1',
      questions: [{
        header: '休息日', question: '你想怎样安排？',
        options: [{ label: '探索美食', description: '' }], multiple: false, custom: false
      }]
    }
    const message: Message = {
      id: 'ordered-message', role: 'assistant', content: '提问前\n选择结果已收到',
      createdAt: 0, state: 'streaming', pendingQuestions: [question],
      blocks: [
        { id: 'before', type: 'text', content: '提问前' },
        { id: 'question', type: 'question', questionId: question.questionId },
        { id: 'tool', type: 'tool', tool: { callId: 'call-1', name: 'after_question', state: 'completed', summary: 'after_question' } },
        { id: 'after', type: 'text', content: '选择结果已收到' }
      ]
    }
    const view = render(<ChatTimeline {...props} messages={[message]} />)
    const assertOrder = (questionSelector: string) => {
      const blocks = view.container.querySelector('.message-blocks')!
      const card = blocks.querySelector(questionSelector)!
      expect(card).not.toBeNull()
      expect(screen.getByText('提问前').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(card.compareDocumentPosition(blocks.querySelector('.tool-execution-list')!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(card.compareDocumentPosition(screen.getByText('选择结果已收到')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    }
    assertOrder('.agent-question-card')
    const completed: Message = {
      ...message, state: 'complete', pendingQuestions: undefined,
      answeredQuestions: [{ questionId: question.questionId, questions: [{
        ...question.questions[0]!, answer: ['探索美食']
      }] }]
    }
    view.rerender(<ChatTimeline {...props} messages={[completed]} />)
    assertOrder('.agent-question-review')
    expect(screen.getAllByText('问题与回答')).toHaveLength(1)
    view.unmount()
    const reopened = render(<ChatTimeline {...props} messages={[JSON.parse(JSON.stringify(completed))]} />)
    const card = reopened.container.querySelector('.agent-question-review')!
    expect(card.closest('.message-blocks')).not.toBeNull()
    expect(card.compareDocumentPosition(screen.getByText('选择结果已收到')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('uses question marker order rather than answer-array order and retains unanchored legacy answers', () => {
    const review = (questionId: string) => ({
      questionId, skipped: true,
      questions: [{ header: questionId, question: `${questionId}?`, options: [], multiple: false, custom: true }]
    })
    const view = render(<ChatTimeline
      artifactById={new Map()} conversationId="multiple-questions"
      hiddenMessageCount={0} isUnusedConversation={false} locale="zh-CN"
      messageStartIndex={0} {...callbacks} retryContent="" totalMessageCount={1}
      messages={[{
        id: 'message', role: 'assistant', content: 'Between', state: 'complete', createdAt: 0,
        blocks: [
          { id: 'q1', type: 'question', questionId: 'first' },
          { id: 'text', type: 'text', content: 'Between' },
          { id: 'q2', type: 'question', questionId: 'second' }
        ],
        answeredQuestions: [review('second'), review('first'), review('legacy')]
      }]}
    />)
    const cards = [...view.container.querySelectorAll('.agent-question-review')]
    expect(cards).toHaveLength(3)
    expect(cards.map(card => card.querySelector('.agent-question-review__question span')!.textContent)).toEqual([
      'first', 'second', 'legacy'
    ])
    expect(cards[0]!.compareDocumentPosition(screen.getByText('Between')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.getByText('Between').compareDocumentPosition(cards[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(cards[2]!.closest('.message-blocks')).toBeNull()
  })

  it.each([
    ['read', 'OpenCode 工具：read', false],
    ['read', 'Continue 工具：read', false],
    ['read', 'DeepSeek Harness 工具：read', false],
    ['read', '远端 Runtime 工具：read', false],
    ['浏览器导航', '直连模型工具：浏览器导航', false],
    ['浏览器导航', '正在执行直连模型工具：浏览器导航', false],
    ['浏览器导航', '直连模型工具已完成：浏览器导航', false],
    ['浏览器导航', '直连模型工具执行失败：浏览器导航', false],
    ['read', ' OpenCode 工具: read ', false],
    ['read', 'OpenCode 工具：read README.md', true],
    ['浏览器导航', '直连模型工具需要刷新后重试：浏览器导航', true],
    ['浏览器导航', '用户拒绝了直连模型工具：浏览器导航', true],
    ['read', 'Custom tool: read', true]
  ])('deduplicates the tool heading for %s / %s', (name, summary, hasSummary) => {
    const view = render(<ChatTimeline
      artifactById={new Map()} conversationId="tools" hiddenMessageCount={0}
      isUnusedConversation={false} locale="zh-CN" messageStartIndex={0}
      {...callbacks} retryContent="" totalMessageCount={1}
      messages={[{
        id: 'tool-message', role: 'assistant', content: '', createdAt: 0, state: 'complete',
        tools: [{ callId: 'call-1', name, summary, state: 'completed' }]
      }]}
    />)
    const card = view.container.querySelector('.tool-execution')!
    expect(view.container.querySelector('.tool-execution-list > header')).toBeNull()
    const status = card.querySelector('.tool-execution__status')!
    expect(status).toHaveAttribute('aria-label', '已完成')
    expect(status).toHaveAttribute('title', '已完成')
    expect(status.textContent).toBe('')
    expect(card.querySelector('.tool-execution__identity strong')).toHaveTextContent(name)
    expect(Boolean(card.querySelector('.tool-execution__identity > span'))).toBe(hasSummary)
    fireEvent.click(card.querySelector('summary')!)
    expect(Boolean(card.querySelector('.tool-execution__full-summary'))).toBe(hasSummary)
  })

  it('constrains tool and subagent grid columns so long content cannot clip text or controls', () => {
    for (const selector of ['.tool-execution-list', '.tool-execution-list > ol',
      '.tool-execution__details', '.tool-execution__details section',
      '.subagent-status-list', '.subagent-status-card__details',
      '.subagent-status-card__progress', '.subagent-status-card__details section']) {
      const rule = stylesheet.slice(stylesheet.indexOf(`\n${selector} {`)).split('}')[0]
      expect(rule).toContain('grid-template-columns: minmax(0, 1fr)')
      if (selector.startsWith('.subagent-')) {
        expect(rule).toContain('min-width: 0')
      }
    }
  })

  it('keeps tool expansion under user control through streaming and completion', () => {
    const props = {
      artifactById: new Map(), conversationId: 'tools',
      hiddenMessageCount: 0, isUnusedConversation: false, locale: 'zh-CN' as const,
      messageStartIndex: 0, ...callbacks, retryContent: '', totalMessageCount: 1
    }
    const message: Message = {
      id: 'tool-message', role: 'assistant', content: '', createdAt: 0, state: 'streaming',
      tools: [{ callId: 'read-1', name: 'read', summary: 'read', state: 'running' }]
    }
    const view = render(<ChatTimeline {...props} messages={[message]} />)
    const card = view.container.querySelector('.tool-execution')!
    expect(card).not.toHaveAttribute('open')
    expect(within(card as HTMLElement).getAllByText('read')).toHaveLength(1)
    fireEvent.click(card.querySelector('summary')!)
    expect(card).toHaveAttribute('open')
    expect(screen.getByText('执行中，尚无结果。')).toBeVisible()
    view.rerender(<ChatTimeline {...props} messages={[{
      ...message, tools: [{ ...message.tools![0]!, state: 'completed' }]
    }]} />)
    expect(card).toHaveAttribute('open')
    expect(screen.getByText('执行完成，无返回内容。')).toBeVisible()
    fireEvent.click(card.querySelector('summary')!)
    view.rerender(<ChatTimeline {...props} messages={[{
      ...message, tools: [{ ...message.tools![0]!, output: 'late result' }]
    }]} />)
    expect(card).not.toHaveAttribute('open')
  })

  it('prioritizes errors and results, folds JSON inputs and copies original content', () => {
    const input = '{"path":"README.md","limit":20}'
    const props = {
      artifactById: new Map(), conversationId: 'tools',
      hiddenMessageCount: 0, isUnusedConversation: false, locale: 'zh-CN' as const,
      messageStartIndex: 0, ...callbacks, retryContent: '', totalMessageCount: 1
    }
    const message: Message = {
      id: 'tool-message', role: 'assistant', content: '', createdAt: 0, state: 'complete',
      tools: [{ callId: 'read-1', name: 'read', summary: 'Read README.md', state: 'failed',
        input, output: '<div>partial output</div>', error: 'Read failed\nMore context' }]
    }
    const view = render(<ChatTimeline {...props} messages={[message]} />)
    const card = view.container.querySelector('.tool-execution')!
    const preview = view.container.querySelector('.tool-execution__error-preview')!
    expect(preview).toHaveTextContent('Read failed')
    expect(card.querySelector('.tool-execution__status')).toHaveTextContent('失败')
    fireEvent.click(card.querySelector('summary')!)
    expect(Array.from(card.querySelectorAll('pre')).map((pre) => pre.textContent)).toEqual([
      'Read failed\nMore context', '<div>partial output</div>', JSON.stringify(JSON.parse(input), null, 2)
    ])
    const inputCard = card.querySelector('.tool-execution__input')!
    expect(inputCard).not.toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: '复制执行结果' }))
    expect(callbacks.onCopyMessage).toHaveBeenLastCalledWith('<div>partial output</div>', 'tool')
    const result = screen.getByRole('region', { name: '执行结果' })
    expect(within(result).getAllByRole('button')).toHaveLength(1)
    expect(within(result).getByRole('button', { name: '复制执行结果' })).toBeVisible()
    fireEvent.click(inputCard.querySelector('summary')!)
    fireEvent.click(screen.getByRole('button', { name: '复制调用参数' }))
    expect(callbacks.onCopyMessage).toHaveBeenLastCalledWith(input, 'tool')
    view.rerender(<ChatTimeline {...props} messages={[{
      ...message, tools: [{ ...message.tools![0]!, input: '{"incomplete":' }]
    }]} />)
    expect(inputCard.querySelector('pre')?.textContent).toBe('{"incomplete":')
  })

  it('isolates historical tool rows and unchanged details across cloned child progress snapshots', () => {
    const props = {
      artifactById: new Map(), conversationId: 'tools',
      hiddenMessageCount: 0, isUnusedConversation: false, locale: 'zh-CN' as const,
      messageStartIndex: 0, ...callbacks, totalMessageCount: 1
    }
    let message: Message = {
      id: 'child-progress', role: 'assistant', content: '', createdAt: 0, state: 'streaming',
      subagents: [{
        childTaskId: 'child', expertId: 'expert', expertName: 'general',
        routingMode: 'native', state: 'running',
        progress: Array.from({ length: 12 }, (_, index) => ({
          id: `block-${index}`, type: 'tool', tool: {
            callId: `call-${index}`, name: 'read', summary: `Read file ${index}`,
            state: 'completed', input: `{"path":"file-${index}"}`,
            output: `contents-${index}`, error: undefined
          }
        }))
      }]
    }
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const view = render(<ChatTimeline {...props} messages={[message]} />)
      const childCard = view.container.querySelector<HTMLDetailsElement>('.subagent-status-card')!
      fireEvent.click(childCard.querySelector('summary')!)
      fireEvent(childCard, new Event('toggle'))
      const cards = view.container.querySelectorAll<HTMLDetailsElement>('.tool-execution')
      expect(cards).toHaveLength(12)
      const firstCard = cards[0]!
      // Folded tool/input details stay mounted for the existing find-in-page path.
      expect(cards[1]!.querySelectorAll('pre')).toHaveLength(2)
      expect(cards[1]!.open).toBe(false)
      fireEvent.click(firstCard.querySelector('summary')!)
      const inputCard = firstCard.querySelector<HTMLDetailsElement>('.tool-execution__input')!
      fireEvent.click(inputCard.querySelector('summary')!)
      expect(toolRowRenderProbe).toHaveBeenCalledTimes(12)
      expect(toolDetailRenderProbe).toHaveBeenCalledTimes(24)
      expect(parse.mock.calls.filter(([value]) => value === '{"path":"file-0"}')).toHaveLength(1)
      toolRowRenderProbe.mockClear()
      toolDetailRenderProbe.mockClear()
      parse.mockClear()

      for (let index = 0; index < 3; index += 1) {
        message = structuredClone(message)
        message.subagents![0]!.progress!.push({ id: `text-${index}`, type: 'text', content: `Progress ${index}` })
        view.rerender(<ChatTimeline {...props} messages={[message]} />)
        expect(screen.getByText(`Progress ${index}`)).toBeVisible()
      }
      expect(toolRowRenderProbe).not.toHaveBeenCalled()
      expect(toolDetailRenderProbe).not.toHaveBeenCalled()
      expect(parse.mock.calls.filter(([value]) => String(value).includes('file-'))).toHaveLength(0)
      expect(view.container.querySelector('.tool-execution')).toBe(firstCard)
      expect(firstCard.open).toBe(true)
      expect(inputCard.open).toBe(true)

      message = structuredClone(message)
      const block = message.subagents![0]!.progress![0]!
      if (block.type !== 'tool') throw new Error('Expected tool progress')
      block.tool.output = 'updated contents'
      block.tool.name = 'read_file'
      block.tool.summary = 'Updated summary'
      view.rerender(<ChatTimeline {...props} messages={[message]} />)
      expect(toolRowRenderProbe).toHaveBeenCalledTimes(1)
      expect(toolDetailRenderProbe).toHaveBeenCalledTimes(1)
      expect(firstCard).toHaveTextContent('updated contents')
      expect(firstCard.querySelector('strong')).toHaveTextContent('read_file')
      expect(firstCard.querySelector('.tool-execution__full-summary')).toHaveTextContent('Updated summary')
      expect(parse.mock.calls.filter(([value]) => value === block.tool.input)).toHaveLength(0)

      const onCopyMessage = vi.fn(async () => true)
      view.rerender(<ChatTimeline {...props} messages={[message]} onCopyMessage={onCopyMessage} />)
      fireEvent.click(within(firstCard).getByRole('button', { name: '复制调用参数' }))
      expect(onCopyMessage).toHaveBeenLastCalledWith('{"path":"file-0"}', 'tool')
      fireEvent.click(within(firstCard).getByRole('button', { name: '复制执行结果' }))
      expect(onCopyMessage).toHaveBeenLastCalledWith('updated contents', 'tool')
      expect(callbacks.onCopyMessage).not.toHaveBeenCalled()
      expect(parse.mock.calls.filter(([value]) => value === block.tool.input)).toHaveLength(0)
    } finally {
      parse.mockRestore()
    }
  })

  it.each(['cancelled', 'failed', 'completed'] as const)(
    'updates pending child tools when the child becomes %s', (state) => {
      const props = {
        artifactById: new Map(), conversationId: 'tools',
        hiddenMessageCount: 0, isUnusedConversation: false, locale: 'zh-CN' as const,
        messageStartIndex: 0, ...callbacks, totalMessageCount: 1
      }
      const message: Message = {
        id: 'child', role: 'assistant', content: '', createdAt: 0, state: 'streaming',
        subagents: [{
          childTaskId: 'child', expertId: 'expert', expertName: 'general',
          routingMode: 'native', state: 'running',
          progress: ['pending', 'running'].map((toolState, index) => ({
            id: `tool-${index}`, type: 'tool', tool: {
              callId: `call-${index}`, name: 'read', summary: 'read',
              state: toolState as 'pending' | 'running', input: '{"path":"file"}'
            }
          }))
        }]
      }
      const view = render(<ChatTimeline {...props} messages={[message]} />)
      const childCard = view.container.querySelector<HTMLDetailsElement>('.subagent-status-card')!
      fireEvent.click(childCard.querySelector('summary')!)
      fireEvent(childCard, new Event('toggle'))
      const cards = view.container.querySelectorAll('.tool-execution')
      fireEvent.click(cards[0]!.querySelector('summary')!)
      const next = structuredClone(message)
      next.subagents![0]!.state = state
      view.rerender(<ChatTimeline {...props} messages={[next]} />)
      for (const card of cards) {
        expect(card).toHaveClass(`tool-execution--${state === 'cancelled' ? 'cancelled' : 'interrupted'}`)
      }
      expect(cards[0]).toHaveAttribute('open')
      expect(childCard).toHaveAttribute('open')
    }
  )

  it('shows an image context limitation as a quiet persistent footer, not an alert', () => {
    const message: Message = {
      id: 'image-message', role: 'assistant', content: '', createdAt: Date.now(),
      state: 'complete', imageContextNotice: 'editing-unavailable'
    }
    const props = {
      artifactById: new Map(), conversationId: 'image-conversation',
      hiddenMessageCount: 0, isUnusedConversation: false, locale: 'zh-CN' as const,
      messageStartIndex: 0, ...callbacks, retryContent: '', totalMessageCount: 1
    }
    const { rerender } = render(<ChatTimeline {...props} messages={[message]} />)
    const note = screen.getByText('上游不支持图片编辑，本次按文字要求生成，未使用参考图片。')
    expect(note).toHaveClass('message__image-context-note')
    expect(note).not.toHaveAttribute('aria-live')
    expect(note).not.toHaveAttribute('role')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('重试')).not.toBeInTheDocument()
    rerender(<ChatTimeline {...props} messages={[{ ...message, imageContextNotice: undefined }]} />)
    expect(screen.queryByText(/上游不支持图片编辑/u)).not.toBeInTheDocument()
  })

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
      pendingQuestions: [{
        requestId: 'question-request', type: 'question', questionId: 'q-1',
        questions: [{ header: '确认', question: '继续吗？', options: [], custom: true, multiple: false }]
      }]
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

  it.each(['assistant', 'user'] as const)('places the %s avatar outside the header and body', (role) => {
    const messages: Message[] = [
      {
        id: 'assistant-message',
        role,
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

    const avatar = message?.querySelector('.message__avatar')

    expect(avatar).toHaveAttribute('aria-hidden', 'true')
    expect(header).toContainElement(message?.querySelector('.message__meta') ?? null)
    expect(Array.from(message?.children ?? [])).toEqual([avatar, header, body])
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

  it('copies a completed assistant reply and resets its success icon three seconds after the latest copy', async () => {
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

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(copyButton) })

      expect(callbacks.onCopyMessage).toHaveBeenCalledOnce()
      expect(callbacks.onCopyMessage).toHaveBeenCalledWith(
        '## Answer\n\nKeep the Markdown source.'
      )
      expect(copyButton).toHaveAccessibleName('回复已复制到剪贴板')
      expect(copyButton.querySelector('.message__copy-success')).not.toBeNull()
      await act(async () => { vi.advanceTimersByTime(2000) })
      await act(async () => { fireEvent.click(copyButton) })
      await act(async () => { vi.advanceTimersByTime(2999) })
      expect(copyButton).toHaveAccessibleName('回复已复制到剪贴板')
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(copyButton).toHaveAccessibleName('复制此回复')
      expect(copyButton.querySelector('.message__copy-success')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
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
