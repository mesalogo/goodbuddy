import {
  Bot,
  ChevronDown,
  CircleHelp,
  FileText,
  History,
  Library,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  UserRound
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  AgentRuntimeStatus,
  AppInfo,
  ContextAttachment
} from '../../shared/contracts'
import { SettingsPanel } from './SettingsPanel'

type ToolActivity = {
  name: string
  state: 'pending' | 'running' | 'completed' | 'failed'
  summary: string
}

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  state: 'streaming' | 'complete' | 'error'
  status?: string
  tools?: ToolActivity[]
  approval?: {
    id: string
    title: string
    description: string
  }
}

type Conversation = {
  id: string
  title: string
  updatedAt: number
  messages: Message[]
}

type ActiveRun = {
  conversationId: string
  messageId: string
}

const storageKey = 'goodbuddy.conversations.v1'

const quickActions = [
  {
    title: '总结一段内容',
    description: '提炼重点并输出行动项',
    prompt: '请帮我总结下面的内容，并列出重点和行动项：\n'
  },
  {
    title: '分析错误信息',
    description: '定位原因并给出排查步骤',
    prompt: '请分析下面的错误信息，给出可能原因和排查步骤：\n'
  },
  {
    title: '编写工作内容',
    description: '起草邮件、周报或方案',
    prompt: '请帮我起草一份清晰、专业的工作内容：\n'
  }
]

function createConversation(): Conversation {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: '新对话',
    updatedAt: now,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          '你好，我是 GoodBuddy。你可以直接向我提问，后续还可以让我读取经过授权的文件、搜索项目并调用工具。',
        createdAt: now,
        state: 'complete'
      }
    ]
  }
}

function loadConversations(): Conversation[] {
  try {
    const value = localStorage.getItem(storageKey)
    if (!value) {
      return [createConversation()]
    }
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as Conversation[])
      : [createConversation()]
  } catch {
    return [createConversation()]
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp)
}

function App(): React.JSX.Element {
  const [conversations, setConversations] = useState(loadConversations)
  const [activeId, setActiveId] = useState(() => conversations[0]?.id ?? '')
  const [input, setInput] = useState('')
  const [runtime, setRuntime] = useState<AgentRuntimeStatus>()
  const [appInfo, setAppInfo] = useState<AppInfo>()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [attachments, setAttachments] = useState<ContextAttachment[]>([])
  const [contextError, setContextError] = useState<string>()
  const activeRuns = useRef(new Map<string, ActiveRun>())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId),
    [activeId, conversations]
  )

  const updateMessage = useCallback(
    (
      conversationId: string,
      messageId: string,
      update: (message: Message) => Message
    ): void => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                updatedAt: Date.now(),
                messages: conversation.messages.map((message) =>
                  message.id === messageId ? update(message) : message
                )
              }
            : conversation
        )
      )
    },
    []
  )

  const handleAgentEvent = useCallback(
    (event: AgentEvent): void => {
      const run = activeRuns.current.get(event.requestId)
      if (!run) {
        return
      }

      if (event.type === 'text') {
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          content: message.content + event.delta,
          status: undefined
        }))
      } else if (event.type === 'status') {
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          status: event.message
        }))
      } else if (event.type === 'tool') {
        updateMessage(run.conversationId, run.messageId, (message) => {
          const tools = [...(message.tools ?? [])]
          const index = tools.findIndex((tool) => tool.name === event.name)
          const tool = {
            name: event.name,
            state: event.state,
            summary: event.summary
          }
          if (index >= 0) {
            tools[index] = tool
          } else {
            tools.push(tool)
          }
          return { ...message, tools }
        })
      } else if (event.type === 'approval') {
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          status: undefined,
          approval: {
            id: event.approvalId,
            title: event.title,
            description: event.description
          }
        }))
      } else {
        updateMessage(run.conversationId, run.messageId, (message) => ({
          ...message,
          state: event.type === 'error' ? 'error' : 'complete',
          status: event.type === 'error' ? event.message : undefined,
          approval: undefined,
          content:
            event.type === 'error' && !message.content
              ? event.message
              : message.content
        }))
        activeRuns.current.delete(event.requestId)
      }
    },
    [updateMessage]
  )

  useEffect(() => {
    const timeout = setTimeout(() => {
      localStorage.setItem(storageKey, JSON.stringify(conversations))
    }, 200)
    return () => clearTimeout(timeout)
  }, [conversations])

  useEffect(() => {
    void window.goodbuddy.agent.getStatus().then(setRuntime)
    void window.goodbuddy.app.getInfo().then(setAppInfo)
    const removeAgentListener =
      window.goodbuddy.agent.onEvent(handleAgentEvent)
    const removeNewConversationListener =
      window.goodbuddy.app.onNewConversation(() => {
        const conversation = createConversation()
        setConversations((current) => [conversation, ...current])
        setActiveId(conversation.id)
        setAttachments((current) => {
          for (const attachment of current) {
            void window.goodbuddy.context.remove(attachment.id)
          }
          return []
        })
        inputRef.current?.focus()
      })
    return () => {
      removeAgentListener()
      removeNewConversationListener()
    }
  }, [handleAgentEvent])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'auto'
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeConversation?.messages])

  const newConversation = (): void => {
    const conversation = createConversation()
    setConversations((current) => [conversation, ...current])
    setActiveId(conversation.id)
    setInput('')
    for (const attachment of attachments) {
      void window.goodbuddy.context.remove(attachment.id)
    }
    setAttachments([])
    inputRef.current?.focus()
  }

  const submit = async (): Promise<void> => {
    const prompt = input.trim()
    if (!prompt || !activeConversation) {
      return
    }

    const requestId = crypto.randomUUID()
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: Date.now(),
      state: 'complete'
    }
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      state: 'streaming',
      status: '正在连接 Agent Runtime'
    }

    const conversationId = activeConversation.id
    activeRuns.current.set(requestId, {
      conversationId,
      messageId: assistantMessage.id
    })
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title:
                conversation.title === '新对话'
                  ? prompt.slice(0, 24)
                  : conversation.title,
              updatedAt: Date.now(),
              messages: [
                ...conversation.messages,
                userMessage,
                assistantMessage
              ]
            }
          : conversation
      )
    )
    setInput('')

    try {
      await window.goodbuddy.agent.run({
        requestId,
        conversationId,
        prompt,
        contextIds: attachments.map((attachment) => attachment.id)
      })
      for (const attachment of attachments) {
        void window.goodbuddy.context.remove(attachment.id)
      }
      setAttachments([])
    } catch (error) {
      handleAgentEvent({
        requestId,
        type: 'error',
        message: error instanceof Error ? error.message : '发送失败'
      })
    }
  }

  const stop = async (): Promise<void> => {
    const requestId = [...activeRuns.current.entries()].find(
      ([, run]) => run.conversationId === activeId
    )?.[0]
    if (requestId) {
      await window.goodbuddy.agent.cancel(requestId)
    }
  }

  const respondToApproval = async (
    conversationId: string,
    messageId: string,
    approvalId: string,
    approved: boolean
  ): Promise<void> => {
    try {
      await window.goodbuddy.agent.respondApproval(approvalId, approved)
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        approval: undefined,
        status: approved
          ? '已授权，Agent 正在执行'
          : '已拒绝工具执行'
      }))
    } catch {
      updateMessage(conversationId, messageId, (message) => ({
        ...message,
        status: '审批响应失败，请重试'
      }))
    }
  }

  const isRunning =
    activeConversation?.messages.some(
      (message) => message.state === 'streaming'
    ) ?? false

  return (
    <div className="app-shell">
      <aside className={sidebarOpen ? 'sidebar' : 'sidebar sidebar--closed'}>
        <div className="brand">
          <div className="brand__mark">
            <Bot size={20} strokeWidth={2.4} />
          </div>
          <div className="brand__copy">
            <strong>GoodBuddy</strong>
            <span>AI desktop companion</span>
          </div>
        </div>

        <button className="new-chat" type="button" onClick={newConversation}>
          <MessageSquarePlus size={17} />
          <span>新建对话</span>
          <kbd>Ctrl N</kbd>
        </button>

        <div className="sidebar-search">
          <Search size={15} />
          <input aria-label="搜索对话" placeholder="搜索对话" />
        </div>

        <nav className="primary-nav" aria-label="主导航">
          <button className="nav-item nav-item--active" type="button">
            <History size={17} />
            <span>最近对话</span>
          </button>
          <button className="nav-item" type="button">
            <Library size={17} />
            <span>知识库</span>
            <span className="nav-item__hint">即将开放</span>
          </button>
          <button className="nav-item" type="button">
            <TerminalSquare size={17} />
            <span>技能与任务</span>
            <span className="nav-item__hint">即将开放</span>
          </button>
        </nav>

        <div className="conversation-list">
          <p className="section-label">对话</p>
          {conversations.map((conversation) => (
            <button
              className={
                conversation.id === activeId
                  ? 'conversation-item conversation-item--active'
                  : 'conversation-item'
              }
              key={conversation.id}
              type="button"
              onClick={() => setActiveId(conversation.id)}
            >
              <span>{conversation.title}</span>
              <small>{formatTime(conversation.updatedAt)}</small>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <button
            className="user-card"
            type="button"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="avatar">GB</span>
            <span className="user-card__copy">
              <strong>本地工作区</strong>
              <small>{appInfo ? `${appInfo.platform} · ${appInfo.arch}` : '加载中'}</small>
            </span>
            <Settings size={16} />
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-button sidebar-toggle"
            type="button"
            aria-label="切换侧栏"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <MoreHorizontal size={19} />
          </button>
          <button className="conversation-title" type="button">
            <span>{activeConversation?.title ?? '新对话'}</span>
            <ChevronDown size={15} />
          </button>
          <div className="topbar__actions">
            <span
              className={
                runtime?.available
                  ? 'runtime-status runtime-status--online'
                  : 'runtime-status'
              }
              title={runtime?.detail}
            >
              <span className="runtime-status__dot" />
              {runtime?.label ?? '正在检测运行时'}
            </span>
            <button className="icon-button" type="button" aria-label="安全状态">
              <ShieldCheck size={18} />
            </button>
            <button className="icon-button" type="button" aria-label="帮助">
              <CircleHelp size={18} />
            </button>
          </div>
        </header>

        <section className="chat" ref={scrollRef}>
          {activeConversation?.messages.length === 1 && (
            <div className="welcome">
              <div className="welcome__badge">
                <Sparkles size={18} />
              </div>
              <p className="eyebrow">GOODBUDDY WORKSPACE</p>
              <h1>今天想一起完成什么？</h1>
              <p className="welcome__description">
                快速提问、梳理信息，或连接 OpenCode 使用文件搜索和开发工具。
              </p>
              <div className="quick-actions">
                {quickActions.map((action) => (
                  <button
                    key={action.title}
                    type="button"
                    onClick={() => {
                      setInput(action.prompt)
                      inputRef.current?.focus()
                    }}
                  >
                    <span className="quick-actions__icon">
                      <FileText size={17} />
                    </span>
                    <strong>{action.title}</strong>
                    <small>{action.description}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="message-list">
            {activeConversation?.messages.map((message) => (
              <article
                className={`message message--${message.role}`}
                key={message.id}
              >
                <div className="message__avatar">
                  {message.role === 'assistant' ? (
                    <Bot size={18} />
                  ) : (
                    <UserRound size={18} />
                  )}
                </div>
                <div className="message__body">
                  <div className="message__meta">
                    <strong>
                      {message.role === 'assistant' ? 'GoodBuddy' : '你'}
                    </strong>
                    <span>{formatTime(message.createdAt)}</span>
                  </div>
                  {message.content && (
                    <div className="message__content">{message.content}</div>
                  )}
                  {message.tools?.map((tool) => (
                    <div className="tool-activity" key={tool.name}>
                      <TerminalSquare size={15} />
                      <span>{tool.summary}</span>
                      <small>{tool.state}</small>
                    </div>
                  ))}
                  {message.approval && (
                    <div className="approval-card">
                      <ShieldCheck size={18} />
                      <div>
                        <strong>{message.approval.title}</strong>
                        <p>{message.approval.description}</p>
                      </div>
                      <button
                        className="approval-card__deny"
                        onClick={() =>
                          void respondToApproval(
                            activeConversation.id,
                            message.id,
                            message.approval!.id,
                            false
                          )
                        }
                        type="button"
                      >
                        拒绝
                      </button>
                      <button
                        className="approval-card__allow"
                        onClick={() =>
                          void respondToApproval(
                            activeConversation.id,
                            message.id,
                            message.approval!.id,
                            true
                          )
                        }
                        type="button"
                      >
                        允许
                      </button>
                    </div>
                  )}
                  {message.status && (
                    <div
                      className={
                        message.state === 'error'
                          ? 'message__status message__status--error'
                          : 'message__status'
                      }
                    >
                      <span className="thinking-dot" />
                      {message.status}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <footer className="composer-wrap">
          <div className="composer">
            {attachments.length > 0 && (
              <div className="context-list">
                {attachments.map((attachment) => (
                  <div
                    className="context-chip"
                    key={attachment.id}
                    title={attachment.preview}
                  >
                    <FileText size={14} />
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>
                        {Math.max(1, Math.ceil(attachment.size / 1024))} KB
                      </small>
                    </span>
                    <button
                      aria-label={`移除 ${attachment.name}`}
                      onClick={() => {
                        void window.goodbuddy.context.remove(attachment.id)
                        setAttachments((current) =>
                          current.filter(
                            (item) => item.id !== attachment.id
                          )
                        )
                      }}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              aria-label="向 GoodBuddy 提问"
              placeholder="给 GoodBuddy 发消息…"
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <div className="composer__toolbar">
              <div className="composer__attachments">
                <button
                  type="button"
                  aria-label="添加附件"
                  onClick={() => {
                    setContextError(undefined)
                    void window.goodbuddy.context
                      .selectFiles()
                      .then((selected) => {
                        setAttachments((current) => [
                          ...current,
                          ...selected.filter(
                            (item) =>
                              !current.some(
                                (existing) => existing.id === item.id
                              )
                          )
                        ])
                      })
                      .catch((reason: unknown) => {
                        setContextError(
                          reason instanceof Error
                            ? reason.message
                            : '添加文件失败'
                        )
                      })
                  }}
                >
                  <Paperclip size={18} />
                </button>
                <span className="divider" />
                <button className="model-button" type="button">
                  <Sparkles size={15} />
                  {runtime?.label ?? 'Runtime'}
                  <ChevronDown size={14} />
                </button>
              </div>
              {isRunning ? (
                <button
                  className="send-button send-button--stop"
                  type="button"
                  aria-label="停止生成"
                  onClick={() => void stop()}
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  type="button"
                  aria-label="发送"
                  disabled={!input.trim()}
                  onClick={() => void submit()}
                >
                  <Send size={17} />
                </button>
              )}
            </div>
          </div>
          <p className="composer-hint">
            {contextError ??
              'AI 可能会犯错。工具执行前请检查参数和权限。'}
            {appInfo?.shortcut && ` 快捷唤起：${appInfo.shortcut}`}
          </p>
        </footer>
      </main>
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          void window.goodbuddy.agent.getStatus().then(setRuntime)
        }}
      />
    </div>
  )
}

export default App
