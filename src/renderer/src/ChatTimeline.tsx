import { AttachmentResultButton } from './AttachmentResultButton'
import { AttachmentActions, AttachmentStatus } from './AttachmentActions'
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  FileText,
  Library,
  ClockFading,
  LoaderCircle,
  ShieldCheck,
  UserRound,
  XCircle
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageOperationStatus } from './ImageOperationStatus'
import type { ImageOperation } from '../../shared/image-generation-contracts'
import type { RuntimeChecklist } from '../../shared/runtime-checklist'
import type {
  ApprovalDecision,
  AgentEvent,
  AgentQuestionAnswer,
  KnowledgeSearchReference
} from '../../shared/contracts'
import type {
  AssistantArtifact,
  ConversationAttachment,
  ConversationContextCompressionMarker,
  ConversationMessage,
  ConversationMessageBlock,
  ConversationSubagentActivity,
  ConversationToolActivity
} from '../../shared/assistant-contracts'
import { AgentQuestionCard } from './AgentQuestionCard'
import { MarkdownRenderer } from './MarkdownRenderer'
import { formatTime, type TimeFormatLocale } from './time-format'
import { formatCompactTokens } from './token-format'

export type ToolActivity = ConversationToolActivity

export type SubagentActivity = ConversationSubagentActivity

export type KnowledgeRetrievalStatus = Omit<
  Extract<AgentEvent, { type: 'knowledge-retrieval' }>,
  'requestId' | 'type'
>

export type Message = {
  id: string
  queueItemId?: ConversationMessage['queueItemId']
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  blocks?: ConversationMessageBlock[]
  displayCaptureTruncated?: boolean
  createdAt: number
  state: 'streaming' | 'complete' | 'error'
  status?: string
  runtimeChecklist?: RuntimeChecklist
  contextCompression?: ConversationMessage['contextCompression']
  contextCompressions?: ConversationMessage['contextCompressions']
  tools?: ToolActivity[]
  subagents?: SubagentActivity[]
  approval?: {
    id: string
    taskId?: string
    title: string
    description: string
    toolName?: string
    argumentSummary?: string
    allowPermanent?: boolean
  }
  pendingQuestions?: Extract<AgentEvent, { type: 'question' }>[]
  answeredQuestions?: ConversationMessage['answeredQuestions']
  sources?: string[]
  sourceReferences?: KnowledgeSearchReference[]
  knowledgeRetrieval?: KnowledgeRetrievalStatus
  artifactIds?: string[]
  imageOperations?: ConversationMessage['imageOperations']
  imageSourceArtifactIds?: string[]
  imageContextNotice?: ConversationMessage['imageContextNotice']
  task?: ConversationMessage['task']
  attachments?: ConversationAttachment[]
}

export type ImageViewerItem = {
  src: string
  title: string
}

type MessageBlockRenderItem =
  | {
      kind: 'block'
      block: Extract<
        ConversationMessageBlock,
        { type: 'text' | 'reasoning' }
      >
    }
  | {
      kind: 'tools'
      id: string
      tools: ToolActivity[]
    }
  | {
      kind: 'subagents'
      id: string
      childTaskIds: string[]
    }
  | {
      kind: 'question'
      id: string
      questionId: string
    }

function groupMessageBlocks(
  blocks: ConversationMessageBlock[]
): MessageBlockRenderItem[] {
  const items: MessageBlockRenderItem[] = []
  for (const block of blocks) {
    if (block.type === 'question') {
      items.push({ kind: 'question', id: block.id, questionId: block.questionId })
      continue
    }
    if (block.type === 'subagent') {
      const previous = items.at(-1)
      if (previous?.kind === 'subagents') {
        previous.childTaskIds.push(block.childTaskId)
      } else {
        items.push({
          kind: 'subagents',
          id: block.id,
          childTaskIds: [block.childTaskId]
        })
      }
      continue
    }
    if (block.type !== 'tool') {
      items.push({ kind: 'block', block })
      continue
    }
    const previous = items.at(-1)
    if (previous?.kind === 'tools') {
      previous.tools.push(block.tool)
    } else {
      items.push({
        kind: 'tools',
        id: block.id,
        tools: [block.tool]
      })
    }
  }
  return items
}

function formatAttachmentSize(size: number): string {
  return `${Math.max(1, Math.ceil(size / 1024))} KB`
}

function MessageReasoning({
  content,
  streaming
}: {
  content: string
  streaming: boolean
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!streaming || !contentRef.current) {
      return
    }
    contentRef.current.scrollTo({
      top: contentRef.current.scrollHeight,
      behavior: 'auto'
    })
  }, [content, streaming])

  return (
    <details className="message-reasoning" open={streaming}>
      <summary>
        {streaming
          ? t('chat.reasoning.streaming')
          : t('chat.reasoning.complete')}
      </summary>
      <div
        className="markdown-content message-reasoning__content"
        ref={contentRef}
      >
        <MarkdownRenderer>{content}</MarkdownRenderer>
      </div>
    </details>
  )
}

type CopyContent = (content: string, kind?: 'tool') => Promise<boolean>

const ToolDetail = memo(function ToolDetail({ label, content, formatJson = false, onCopy }: {
  label: string
  content: string
  formatJson?: boolean
  onCopy: CopyContent
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const display = useMemo(() => {
    if (formatJson) {
      try {
        return JSON.stringify(JSON.parse(content), null, 2)
      } catch {
        // Truncated JSON and plain-text arguments remain readable as received.
      }
    }
    return content
  }, [content, formatJson])

  return (
    <section className="tool-detail" aria-label={label}>
      <header className="tool-detail__toolbar">
        <strong>{label}</strong>
        <button type="button" aria-label={t('chat.tools.copy', { label })} onClick={() => { void onCopy(content, 'tool') }}>
          <Copy aria-hidden="true" size={13} />
          {t('chat.tools.copyAction')}
        </button>
      </header>
      <pre tabIndex={0} aria-label={label}>
        {display}
      </pre>
    </section>
  )
})

const ToolExecutionRow = memo(function ToolExecutionRow({ onCopy, ...tool }: Pick<
  ToolActivity, 'name' | 'summary' | 'state' | 'input' | 'output' | 'error'
> & {
  onCopy: CopyContent
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const summary = tool.summary.trim()
  // Only suppress known boilerplate; recovery hints and custom summaries remain visible.
  const summaryIdentity = summary.replace(
    /^(?:(?:OpenCode|Continue|DeepSeek Harness|远端 Runtime) 工具|直连模型工具(?:已完成|执行失败)?|正在执行直连模型工具)\s*[:：]\s*/u,
    ''
  )
  const hasSummary = summary.length > 0 && summaryIdentity !== tool.name.trim()
  const StateIcon = tool.state === 'running' ? LoaderCircle
    : tool.state === 'pending' ? Clock3
      : tool.state === 'completed' ? Check : XCircle
  return (
    <li>
      <details
        className={`tool-execution tool-execution--${tool.state}`}
      >
        <summary>
          <ChevronRight aria-hidden="true" size={14} className="tool-execution__chevron" />
          <span className="tool-execution__identity">
            <strong title={tool.name}>{tool.name}</strong>
            {hasSummary && <span title={tool.summary}>{tool.summary}</span>}
          </span>
          <small
            aria-label={t(`chat.tools.states.${tool.state}`)}
            title={t(`chat.tools.states.${tool.state}`)}
            className="tool-execution__status"
          >
            <StateIcon aria-hidden="true" size={13} />
            {(tool.state === 'failed' || tool.state === 'recoverable' || tool.state === 'cancelled') && t(`chat.tools.states.${tool.state}`)}
          </small>
        </summary>
        <div className="tool-execution__details">
          {hasSummary && <p className="tool-execution__full-summary">{tool.summary}</p>}
          {tool.error && (
            <div className="tool-execution__error">
              <ToolDetail label={t('chat.tools.error')} content={tool.error} onCopy={onCopy} />
            </div>
          )}
          {tool.output ? (
            <ToolDetail label={t('chat.tools.output')} content={tool.output} onCopy={onCopy} />
          ) : !tool.error && (
            <p>{t(tool.state === 'running' ? 'chat.tools.waitingOutput'
              : tool.state === 'pending' ? 'chat.tools.waitingStart'
                : tool.state === 'completed' ? 'chat.tools.emptyOutput' : 'chat.tools.noDetails')}</p>
          )}
          {tool.input && (
            <details className="tool-execution__input">
              <summary>{t('chat.tools.input')}</summary>
              <ToolDetail label={t('chat.tools.input')} content={tool.input} formatJson onCopy={onCopy} />
            </details>
          )}
        </div>
      </details>
      {tool.error && (
        <p className="tool-execution__error-preview" title={tool.error}>{tool.error}</p>
      )}
    </li>
  )
})

function ToolExecutionList({
  tools,
  onCopy
}: {
  tools: ToolActivity[]
  onCopy: CopyContent
}): React.JSX.Element {
  const { t } = useTranslation('app')

  return (
    <section
      aria-label={t('chat.tools.region', { count: tools.length })}
      className="tool-execution-list"
    >
      <ol>
        {tools.map((tool) => (
          <ToolExecutionRow
            key={tool.callId ?? tool.name}
            name={tool.name}
            summary={tool.summary}
            state={tool.state}
            input={tool.input}
            output={tool.output}
            error={tool.error}
            onCopy={onCopy}
          />
        ))}
      </ol>
    </section>
  )
}

const SubagentStatusCard = memo(function SubagentStatusCard({
  renderHtml,
  subagent,
  questionFormId,
  onCopy
}: {
  renderHtml: boolean
  subagent: SubagentActivity
  questionFormId?: string
  onCopy: CopyContent
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const [expanded, setExpanded] = useState(false)
  const StateIcon =
    subagent.state === 'completed'
      ? CheckCircle2
      : subagent.state === 'running'
        ? LoaderCircle
        : subagent.state === 'queued'
          ? Clock3
          : XCircle
  const actor =
    'actor' in subagent
      ? subagent.actor
      : {
          kind: 'expert' as const,
          expertId: subagent.expertId,
          expertName: subagent.expertName
        }
  const actorLabel =
    actor.kind === 'direct-model'
      ? t('chat.subagents.directModelLabel')
      : actor.expertName
  const source =
    actor.kind === 'direct-model'
      ? t('chat.subagents.directModel')
      : subagent.routingMode === 'smart'
      ? t('chat.subagents.smart')
      : subagent.routingMode === 'native'
        ? t('chat.subagents.native')
        : t('chat.subagents.manual')
  const sourceAndMode =
    actor.kind === 'direct-model' && subagent.workMode
      ? `${source} · ${subagent.workMode === 'execute' ? 'Execute' : 'Ask'}`
      : source
  const progress = subagent.progress?.filter((block, index, blocks) =>
    !(
      subagent.state === 'completed' &&
      index === blocks.length - 1 &&
      block.type === 'text' &&
      block.content.trim() === subagent.output?.trim()
    )
  )

  return (
    <details
      className={`subagent-status-card subagent-status-card--${subagent.state}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="subagent-status-card__identity">
          <span className="subagent-status-card__heading">
            <span className="subagent-status-card__badge">
              <Bot aria-hidden="true" size={13} />
              {t('chat.subagents.badge')}
            </span>
            <strong>{actorLabel}</strong>
          </span>
          {subagent.reason && (
            <span className="subagent-status-card__task">
              <small>{t('chat.subagents.task')}</small>
              <span>{subagent.reason}</span>
            </span>
          )}
          <small className="subagent-status-card__source">
            {sourceAndMode}
          </small>
        </span>
        <span
          aria-label={questionFormId ? t('chat.status.waitingForAnswer') : t(`chat.subagents.states.${subagent.state}`)}
          className={`subagent-status-card__status subagent-status-card__status--${subagent.state}`}
        >
          <StateIcon aria-hidden="true" size={14} />
          {questionFormId ? t('chat.status.waitingForAnswer') : t(`chat.subagents.states.${subagent.state}`)}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="subagent-status-card__chevron"
          size={15}
        />
      </summary>
      {expanded && (
        <div className="subagent-status-card__details">
          {questionFormId && (
            <button className="secondary-button" type="button" onClick={() => {
              const form = document.getElementById(questionFormId)
              form?.scrollIntoView({ block: 'center' })
              form?.focus({ preventScroll: true })
            }}>
              {t('workspace:question.locate')}
            </button>
          )}
          {progress && progress.length > 0 && (
            <section aria-label={t('chat.subagents.progress')}>
              <strong>{t('chat.subagents.progress')}</strong>
              <div className="subagent-status-card__progress">
                {groupMessageBlocks(progress).map((item) =>
                  item.kind === 'tools' ? (
                    <ToolExecutionList key={item.id} onCopy={onCopy} tools={item.tools.map((tool) =>
                      (tool.state === 'pending' || tool.state === 'running') &&
                      subagent.state !== 'queued' && subagent.state !== 'running'
                        ? { ...tool, state: subagent.state === 'cancelled' ? 'cancelled' : 'interrupted' }
                        : tool
                    )} />
                  ) : item.kind === 'subagents' || item.kind === 'question' ? null
                    : item.block.type === 'reasoning' ? (
                      <MessageReasoning
                        key={item.block.id}
                        content={item.block.content}
                        streaming={false}
                      />
                    ) : item.block.type === 'text' ? (
                      <div key={item.block.id} className="markdown-content">
                        <MarkdownRenderer>{item.block.content}</MarkdownRenderer>
                      </div>
                    ) : null
                )}
              </div>
            </section>
          )}
          {subagent.output ? (
            <section aria-label={t('chat.subagents.finalOutput')}>
              <strong>{t('chat.subagents.finalOutput')}</strong>
              <div className="markdown-content">
                <MarkdownRenderer
                  renderHtml={
                    renderHtml && subagent.state === 'completed'
                  }
                >
                  {subagent.output}
                </MarkdownRenderer>
              </div>
            </section>
          ) : !subagent.progress?.length ? (
            <p>{t('chat.subagents.noOutput')}</p>
          ) : null}
          {subagent.error &&
            (subagent.state === 'failed' ||
              subagent.state === 'cancelled') && (
              <section className="subagent-status-card__error">
                <strong>{t('chat.subagents.error')}</strong>
                <p>{subagent.error}</p>
              </section>
            )}
        </div>
      )}
    </details>
  )
})

function SubagentStatusList({
  renderHtml,
  subagents,
  pendingQuestions,
  questionFormId,
  onCopy
}: {
  renderHtml: boolean
  subagents: SubagentActivity[]
  pendingQuestions?: Message['pendingQuestions']
  questionFormId?: string
  onCopy: CopyContent
}): React.JSX.Element {
  const { t } = useTranslation('app')

  return (
    <section
      aria-label={t('chat.subagents.region')}
      className="subagent-status-list"
    >
      {subagents.map((subagent) => (
        <SubagentStatusCard
          key={subagent.childTaskId}
          renderHtml={renderHtml}
          subagent={subagent}
          questionFormId={pendingQuestions?.some((question) => question.childTaskId === subagent.childTaskId) ? questionFormId : undefined}
          onCopy={onCopy}
        />
      ))}
    </section>
  )
}

type ChatMessageRowProps = {
  onOpenImageModelSettings?: () => void
  onReselectImageSources?: (operation: ImageOperation) => void
  onEditImage?: (artifact: AssistantArtifact) => void
  artifactById: ReadonlyMap<string, AssistantArtifact>
  canRetry: boolean
  conversationId: string
  greeting: boolean
  locale: TimeFormatLocale
  message: Message
  renderAssistantHtml?: boolean
  onArticleRef: (messageId: string, element: HTMLElement | null) => void
  onCopyMessage: CopyContent
  onDownloadImage: (item: ImageViewerItem) => void
  onOpenCitationContext: (
    reference: KnowledgeSearchReference
  ) => Promise<void>
  onOpenCitationSource: (
    reference: KnowledgeSearchReference
  ) => Promise<void>
  onOpenImage: (item: ImageViewerItem, trigger: HTMLElement) => void
  onRespondApproval: (
    conversationId: string,
    messageId: string,
    approvalId: string,
    decision: ApprovalDecision
  ) => Promise<void>
  onRespondQuestion: (
    conversationId: string,
    messageId: string,
    questionId: string,
    answers?: AgentQuestionAnswer[]
  ) => Promise<void>
  onRetry: (content: string) => void
  retryContent?: string
}

function ChatMessageRowView({
  onOpenImageModelSettings,
  onReselectImageSources,
  onEditImage,
  artifactById,
  canRetry,
  conversationId,
  greeting,
  locale,
  message,
  renderAssistantHtml = false,
  onArticleRef,
  onCopyMessage,
  onDownloadImage,
  onOpenCitationContext,
  onOpenCitationSource,
  onOpenImage,
  onRespondApproval,
  onRespondQuestion,
  onRetry,
  retryContent
}: ChatMessageRowProps): React.JSX.Element {
  const { t } = useTranslation('app')
  const [copied, setCopied] = useState(false)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyResetTimer.current), [])

  const copyReply = async (): Promise<void> => {
    const success = await onCopyMessage(greeting ? t('conversation.greeting') : message.content)
    clearTimeout(copyResetTimer.current)
    setCopied(success)
    if (success) {
      copyResetTimer.current = setTimeout(() => setCopied(false), 3000)
    }
  }
  const imageArtifactIds = useMemo(() => [...new Set([
    ...(message.artifactIds ?? []),
    ...(message.imageOperations?.flatMap(operation => operation.artifactIds) ?? [])
  ])], [message.artifactIds, message.imageOperations])
  const compressionMarkers =
    message.contextCompressions ??
    (message.contextCompression ? [message.contextCompression] : [])
  const subagentsById = new Map(
    (message.subagents ?? []).map((subagent) => [
      subagent.childTaskId,
      subagent
    ])
  )
  const orderedSubagentIds = new Set(
    message.blocks
      ?.filter((block) => block.type === 'subagent')
      .map((block) => block.childTaskId)
  )
  const unorderedSubagents = message.subagents?.filter(
    (subagent) => !orderedSubagentIds.has(subagent.childTaskId)
  )
  const compressionLabel = (
    compression: ConversationContextCompressionMarker
  ): string =>
    compression.state === 'compressing'
      ? compression.scope === 'agent-run'
        ? t('chat.contextCompression.agentCompressing')
        : t('chat.contextCompression.compressing')
      : compression.state === 'completed' &&
          compression.estimatedAfterTokens !== undefined
        ? compression.scope === 'agent-run'
          ? t('chat.contextCompression.agentCompleted', {
              before: formatCompactTokens(
                compression.estimatedBeforeTokens
              ),
              after: formatCompactTokens(
                compression.estimatedAfterTokens
              ),
              count: compression.compressionCount ?? 1
            })
          : t('chat.contextCompression.completed', {
              before: formatCompactTokens(
                compression.estimatedBeforeTokens
              ),
              after: formatCompactTokens(
                compression.estimatedAfterTokens
              )
            })
        : compression.scope === 'agent-run'
          ? t('chat.contextCompression.agentFailed')
          : t('chat.contextCompression.failed')

  const question = message.pendingQuestions?.[0]
  const questionTask = question?.childTaskId ? subagentsById.get(question.childTaskId) : undefined
  const questionFormId = `agent-question-${message.id}`
  const orderedQuestionIds = useMemo(() => new Set(
    message.blocks?.filter(block => block.type === 'question').map(block => block.questionId)
  ), [message.blocks])
  const answeredQuestionsById = useMemo(() => new Map(
    message.answeredQuestions?.map(review => [review.questionId, review])
  ), [message.answeredQuestions])
  const renderQuestion = (questionId: string): React.JSX.Element | null => {
    if (question?.questionId === questionId) {
      return (
        <AgentQuestionCard
          id={questionFormId}
          pendingCount={message.pendingQuestions?.length}
          taskTitle={questionTask?.reason ??
            (questionTask && 'expertName' in questionTask ? questionTask.expertName : undefined) ?? message.task?.title}
          key={questionId}
          onReject={() => onRespondQuestion(conversationId, message.id, questionId)}
          onSubmit={(answers) => onRespondQuestion(conversationId, message.id, questionId, answers)}
          value={question}
        />
      )
    }
    const review = answeredQuestionsById.get(questionId)
    if (!review) return null
    return (
      <div className="agent-question-review" key={questionId}>
        <header>
          <CircleHelp aria-hidden="true" size={16} />
          <strong>{t('chat.questionReview.title')}</strong>
        </header>
        {review.questions.map((item, index) => (
          <div className="agent-question-review__item" key={`${questionId}:${index}`}>
            <p className="agent-question-review__question">
              <span>{item.header}</span>
              {item.question}
            </p>
            <p className="agent-question-review__answer">
              <span>{t('chat.questionReview.answerLabel')}</span>
              {review.skipped || !item.answer?.length
                ? t('chat.questionReview.skipped')
                : item.answer.join('、')}
            </p>
          </div>
        ))}
      </div>
    )
  }
  const activeTool = message.tools?.find((tool) =>
    tool.state === 'pending' || tool.state === 'running')
  const activeSubagent = message.subagents?.some((subagent) =>
    subagent.state === 'queued' || subagent.state === 'running')
  const activeCompression = compressionMarkers.find((marker) =>
    marker.state === 'compressing')
  const statusText = message.role === 'assistant' && message.state === 'streaming'
    ? question
      ? t('chat.status.waitingForAnswer')
      : message.approval
        ? t('chat.status.waitingForApproval')
        : activeCompression
          ? undefined
          : message.status || (activeTool
            ? t(activeTool.state === 'running'
              ? 'chat.status.runningTool' : 'chat.status.pendingTool', { name: activeTool.name })
            : activeSubagent
              ? t('chat.status.waitingForSubagent')
              : t('chat.status.waitingForProgress'))
    : message.status

  return (
    <>
    <article
      className={`message message--${message.role}`}
      ref={(element) => onArticleRef(message.id, element)}
      tabIndex={-1}
    >
      <div aria-hidden="true" className="message__avatar">
        {message.role === 'assistant' ? (
          <Bot size={18} />
        ) : (
          <UserRound size={18} />
        )}
      </div>
      <div className="message__header">
        <div className="message__meta">
          <strong>
            {message.role === 'assistant' ? 'GoodBuddy' : t('chat.user')}
          </strong>
          {message.task && (
            <span
              aria-label={t('chat.taskResult', {
                title: message.task.title
              })}
              className="message__task"
            >
              <ClockFading aria-hidden="true" size={12} />
              {message.task.title}
            </span>
          )}
          <span>{formatTime(message.createdAt, locale)}</span>
        </div>
      </div>
      <div className="message__body">
        {message.attachments && message.attachments.length > 0 && (
          <div
            aria-label={t('chat.attachments.region')}
            className="message-attachments"
          >
            {message.attachments.map((attachment) => {
              const imageSource =
                attachment.kind === 'image'
                  ? attachment.contentUrl ?? attachment.thumbnailUrl
                  : undefined
              const imageItem = imageSource
                ? {
                    src: imageSource,
                    title: attachment.name
                  }
                : undefined
              return (
                <div
                  className={`message-attachment message-attachment--${attachment.kind}`}
                  key={attachment.id}
                  title={attachment.preview}
                >
                  {imageItem ? (
                    <button
                      aria-label={t('chat.images.viewNamed', {
                        title: attachment.name
                      })}
                      className="message-image-button"
                      onClick={(event) =>
                        onOpenImage(imageItem, event.currentTarget)
                      }
                      type="button"
                    >
                      <img
                        alt={attachment.name}
                        loading="lazy"
                        src={imageSource}
                      />
                    </button>
                  ) : (
                    <span
                      aria-hidden="true"
                      className="message-attachment__icon"
                    >
                      <FileText size={16} />
                    </span>
                  )}
                  <span className="message-attachment__details">
                    <strong title={attachment.name}>{attachment.name}</strong>
                    <span className="attachment-metadata">
                      <AttachmentStatus attachment={attachment} />
                      <small>{formatAttachmentSize(attachment.size)}</small>
                    </span>
                    <span className="attachment-actions">
                      {attachment.resultId && <AttachmentResultButton resultId={attachment.resultId} name={attachment.name} />}
                      <AttachmentActions attachment={attachment} />
                    </span>
                    {imageItem && (
                      <span className="message-image-actions">
                        <button
                          onClick={(event) =>
                            onOpenImage(imageItem, event.currentTarget)
                          }
                          type="button"
                        >
                          {t('chat.images.view')}
                        </button>
                        <button
                          aria-label={t('chat.images.downloadNamed', {
                            title: attachment.name
                          })}
                          className="icon-button attachment-action"
                          title={t('chat.images.downloadImage')}
                          data-tooltip={t('chat.images.downloadImage')}
                          onClick={() => onDownloadImage(imageItem)}
                          type="button"
                        >
                          <Download size={16} aria-hidden="true" />
                        </button>
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {message.blocks && message.blocks.length > 0 ? (
          <div className="message-blocks">
            {groupMessageBlocks(message.blocks).map((item) =>
              item.kind === 'question' ? renderQuestion(item.questionId)
              : item.kind === 'tools' ? (
                <ToolExecutionList key={item.id} tools={item.tools} onCopy={onCopyMessage} />
              ) : item.kind === 'subagents' ? (
                <SubagentStatusList
                  pendingQuestions={message.pendingQuestions}
                  questionFormId={questionFormId}
                  onCopy={onCopyMessage}
                  key={item.id}
                  renderHtml={renderAssistantHtml}
                  subagents={item.childTaskIds.flatMap((childTaskId) => {
                    const subagent = subagentsById.get(childTaskId)
                    return subagent ? [subagent] : []
                  })}
                />
              ) : item.block.type === 'reasoning' ? (
                <MessageReasoning
                  content={item.block.content}
                  key={item.block.id}
                  streaming={message.state === 'streaming'}
                />
              ) : (
                <div
                  className="markdown-content message__content"
                  key={item.block.id}
                >
                  <MarkdownRenderer
                    renderHtml={
                      renderAssistantHtml &&
                      message.role === 'assistant' &&
                      message.state === 'complete'
                    }
                  >
                    {item.block.content}
                  </MarkdownRenderer>
                </div>
              )
            )}
          </div>
        ) : (
          <>
            {message.reasoning && (
              <MessageReasoning
                content={message.reasoning}
                key={`${message.id}-${message.state}`}
                streaming={message.state === 'streaming'}
              />
            )}
            {message.content && (
              <div className="markdown-content message__content">
                <MarkdownRenderer
                  renderHtml={
                    renderAssistantHtml &&
                    message.role === 'assistant' &&
                    message.state === 'complete'
                  }
                >
                  {greeting ? t('conversation.greeting') : message.content}
                </MarkdownRenderer>
              </div>
            )}
          </>
        )}
        {unorderedSubagents && unorderedSubagents.length > 0 && (
          <SubagentStatusList
            pendingQuestions={message.pendingQuestions}
            questionFormId={questionFormId}
            onCopy={onCopyMessage}
            renderHtml={renderAssistantHtml}
            subagents={unorderedSubagents}
          />
        )}
        {message.imageOperations?.map(operation => <ImageOperationStatus key={operation.id} operation={operation} onOpenImageModelSettings={onOpenImageModelSettings} onReselectImageSources={onReselectImageSources} />)}
        {imageArtifactIds.map((artifactId) => {
          const candidate = artifactById.get(artifactId)
          const artifact =
            candidate?.kind === 'image' &&
            candidate.content &&
            /^data:image\/(?:png|jpeg|webp);base64,/u.test(candidate.content)
              ? candidate
              : undefined
          return artifact?.content ? (
            <figure className="message-generated-image" key={artifact.id}>
              <button
                aria-label={t('chat.images.viewNamed', {
                  title: artifact.title
                })}
                className="message-image-button"
                onClick={(event) =>
                  onOpenImage(
                    {
                      src: artifact.content!,
                      title: artifact.title
                    },
                    event.currentTarget
                  )
                }
                type="button"
              >
                <img
                  alt={artifact.title}
                  loading="lazy"
                  src={artifact.content}
                />
              </button>
              <figcaption>{artifact.title}</figcaption>
              <div className="message-image-actions">
                {onEditImage && <button type="button" onClick={() => onEditImage(artifact)}>{t('chat.images.edit')}</button>}
                <button
                  onClick={(event) =>
                    onOpenImage(
                      {
                        src: artifact.content!,
                        title: artifact.title
                      },
                      event.currentTarget
                    )
                  }
                  type="button"
                >
                  {t('chat.images.view')}
                </button>
                <button
                  aria-label={t('chat.images.downloadNamed', {
                    title: artifact.title
                  })}
                  className="icon-button attachment-action"
                  title={t('chat.images.downloadImage')}
                  data-tooltip={t('chat.images.downloadImage')}
                  onClick={() =>
                    onDownloadImage({
                      src: artifact.content!,
                      title: artifact.title
                    })
                  }
                  type="button"
                >
                  <Download size={16} aria-hidden="true" />
                </button>
              </div>
            </figure>
          ) : null
        })}
        {message.knowledgeRetrieval && (
          <section
            aria-live={
              message.knowledgeRetrieval.state === 'failed'
                ? 'assertive'
                : 'polite'
            }
            className={`message-retrieval-status message-retrieval-status--${message.knowledgeRetrieval.state}`}
            role={
              message.knowledgeRetrieval.state === 'failed'
                ? 'alert'
                : 'status'
            }
          >
            <Library aria-hidden="true" size={14} />
            <div>
              <strong>
                {t(
                  `chat.knowledgeRetrieval.states.${message.knowledgeRetrieval.state}`
                )}
              </strong>
              <small>
                {t('chat.knowledgeRetrieval.summary', {
                  libraries: message.knowledgeRetrieval.libraryCount,
                  results: message.knowledgeRetrieval.resultCount,
                  duration: message.knowledgeRetrieval.durationMs ?? 0
                })}
              </small>
              {message.knowledgeRetrieval.usedChannels.length > 0 && (
                <small>
                  {t('chat.knowledgeRetrieval.channels', {
                    channels: message.knowledgeRetrieval.usedChannels
                      .map((channel) =>
                        t(
                          `chat.knowledgeRetrieval.channelNames.${channel}`
                        )
                      )
                      .join(' + ')
                  })}
                </small>
              )}
              {message.knowledgeRetrieval.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </section>
        )}
        {message.sources && message.sources.length > 0 && (
          <div className="message-sources">
            <Library size={14} />
            <span>
              {t('chat.sources', {
                sources: [...new Set(message.sources)].join(
                  locale === 'zh-CN' ? '、' : ', '
                )
              })}
            </span>
          </div>
        )}
        {message.sourceReferences &&
          message.sourceReferences.length > 0 && (
            <details className="message-citations">
              <summary>
                {t('chat.citations.view', {
                  count: message.sourceReferences.length
                })}
              </summary>
              <ol>
                {message.sourceReferences.map(
                  (reference, referenceIndex) => (
                    <li
                      key={`${reference.documentId}:${reference.chunkId ?? reference.locator ?? referenceIndex}`}
                    >
                      <strong>
                        [{referenceIndex + 1}] {reference.documentName}
                      </strong>
                      {reference.locator && (
                        <small>{reference.locator}</small>
                      )}
                      <p>{reference.snippet}</p>
                      {reference.external && <small>{reference.libraryName} · {reference.external.provider} · {reference.sourceName}</small>}
                      {reference.retrievalChannels && (
                        <small>
                          {t('chat.citations.retrieval')}
                          {reference.retrievalChannels
                            .map((channel) =>
                              channel === 'fts'
                                ? t('chat.citations.fullText')
                                : channel === 'cjk'
                                  ? t('chat.citations.cjk')
                                  : channel === 'vector'
                                    ? t('chat.citations.vector')
                                    : t('chat.citations.graph')
                            )
                            .join(' + ')}
                        </small>
                      )}
                      {reference.score !== undefined && (
                        <small>
                          {t('chat.citations.score', {
                            score: reference.score.toFixed(4)
                          })}
                        </small>
                      )}
                      <div className="message-citations__actions">
                        <button
                          className="secondary-button"
                          onClick={() =>
                            void onOpenCitationContext(reference)
                          }
                          type="button"
                        >
                          {t('chat.citations.viewContext')}
                        </button>
                        {!reference.external && <button
                          className="secondary-button"
                          disabled={!reference.chunkId || !reference.documentId}
                          onClick={() =>
                            void onOpenCitationSource(reference)
                          }
                          type="button"
                        >
                          {t('chat.citations.openSource')}
                        </button>}
                      </div>
                    </li>
                  )
                )}
              </ol>
            </details>
          )}
        {(!message.blocks || message.blocks.length === 0) &&
          message.tools &&
          message.tools.length > 0 && (
            <ToolExecutionList tools={message.tools} onCopy={onCopyMessage} />
          )}
        {message.approval && (
          <div className="approval-card">
            <span
              aria-atomic="true"
              aria-label={t('chat.approval.waiting', {
                tool: message.approval.toolName ?? message.approval.title
              })}
              aria-live="polite"
              className="sr-only"
              role="status"
            >
              {t('chat.approval.waiting', {
                tool: message.approval.toolName ?? message.approval.title
              })}
            </span>
            <ShieldCheck size={18} />
            <div>
              <strong>{message.approval.title}</strong>
              <p>{message.approval.description}</p>
              {message.approval.argumentSummary && (
                <code>{message.approval.argumentSummary}</code>
              )}
            </div>
            <button
              className="approval-card__deny"
              onClick={() =>
                void onRespondApproval(
                  conversationId,
                  message.id,
                  message.approval!.id,
                  'deny'
                )
              }
              type="button"
            >
              {t('chat.approval.deny')}
            </button>
            <button
              className="approval-card__allow"
              onClick={() =>
                void onRespondApproval(
                  conversationId,
                  message.id,
                  message.approval!.id,
                  'once'
                )
              }
              type="button"
            >
              {t('chat.approval.once')}
            </button>
            <button
              className="approval-card__allow"
              onClick={() =>
                void onRespondApproval(
                  conversationId,
                  message.id,
                  message.approval!.id,
                  'session'
                )
              }
              type="button"
            >
              {t('chat.approval.session')}
            </button>
            {message.approval.allowPermanent && (
              <button
                className="approval-card__allow"
                onClick={() =>
                  void onRespondApproval(
                    conversationId,
                    message.id,
                    message.approval!.id,
                    'permanent'
                  )
                }
                type="button"
              >
                {t('chat.approval.permanent')}
              </button>
            )}
          </div>
        )}
        {question && !orderedQuestionIds.has(question.questionId) && renderQuestion(question.questionId)}
        {message.answeredQuestions?.filter(review => !orderedQuestionIds.has(review.questionId))
          .map(review => renderQuestion(review.questionId))}
        {message.role === 'assistant' && message.imageContextNotice && (
          <p className="message__image-context-note">
            {t(`chat.images.contextNotice.${message.imageContextNotice}`)}
          </p>
        )}
        {message.displayCaptureTruncated && (
          <div
            aria-live="polite"
            className="message__status"
            role="status"
          >
            <span
              aria-hidden="true"
              className="message__status-dot"
            />
            {t('chat.status.displayCaptureTruncated')}
          </div>
        )}
        {statusText && (
          <div
            aria-atomic="true"
            aria-label={statusText}
            aria-live={
              message.knowledgeRetrieval || compressionMarkers.length > 0
                ? undefined
                : message.state === 'error'
                  ? 'assertive'
                  : 'polite'
            }
            className={
              message.state === 'error'
                ? 'message__status message__status--error'
                : 'message__status'
            }
            role={
              message.knowledgeRetrieval || compressionMarkers.length > 0
                ? undefined
                : message.state === 'error'
                  ? 'alert'
                  : 'status'
            }
          >
            <span
              aria-hidden="true"
              className="message__status-dot"
            />
            {statusText}
          </div>
        )}
        {canRetry && (
          <button
            className="message-retry"
            onClick={() => {
              if (retryContent !== undefined) {
                onRetry(retryContent)
              }
            }}
            type="button"
          >
            {t('chat.retry')}
          </button>
        )}
        {message.role === 'assistant' &&
          message.state !== 'streaming' &&
          Boolean(message.content.trim()) && (
            <div className="message__actions">
              <button
                aria-label={t(copied ? 'notices.messageCopied' : 'chat.copyMessage')}
                className="icon-button"
                onClick={() => void copyReply()}
                title={t(copied ? 'notices.messageCopied' : 'chat.copyMessage')}
                type="button"
              >
                {copied
                  ? <Check aria-hidden="true" className="message__copy-success" size={15} />
                  : <Copy aria-hidden="true" size={15} />}
              </button>
            </div>
          )}
      </div>
    </article>
      {message.role === 'assistant' &&
        compressionMarkers.map((compression, index) => (
          <div
            aria-live={
              compression.state === 'failed' ? 'assertive' : 'polite'
            }
            className={`context-compression-event context-compression-event--${compression.state}`}
            key={`${compression.scope ?? 'conversation'}:${index}`}
            role={compression.state === 'failed' ? 'alert' : 'status'}
          >
            <span className="context-compression-event__line" />
            <span className="context-compression-event__label">
              <span
                aria-hidden="true"
                className={
                  compression.state === 'compressing'
                    ? 'message__status-dot message__status-dot--active'
                    : 'message__status-dot'
                }
              />
              {compressionLabel(compression)}
            </span>
            <span className="context-compression-event__line" />
          </div>
        ))}
    </>
  )
}

export const ChatMessageRow = memo(ChatMessageRowView)

type ChatTimelineProps = {
  onOpenImageModelSettings?: () => void
  onReselectImageSources?: (operation: ImageOperation) => void
  onEditImage?: (artifact: AssistantArtifact) => void
  artifactById: ReadonlyMap<string, AssistantArtifact>
  conversationId: string
  hiddenMessageCount: number
  isUnusedConversation: boolean
  locale: TimeFormatLocale
  messageStartIndex: number
  messages: Message[]
  onArticleRef: (messageId: string, element: HTMLElement | null) => void
  onCopyMessage: CopyContent
  onDownloadImage: (item: ImageViewerItem) => void
  onOpenCitationContext: (
    reference: KnowledgeSearchReference
  ) => Promise<void>
  onOpenCitationSource: (
    reference: KnowledgeSearchReference
  ) => Promise<void>
  onOpenImage: (item: ImageViewerItem, trigger: HTMLElement) => void
  onRespondApproval: (
    conversationId: string,
    messageId: string,
    approvalId: string,
    decision: ApprovalDecision
  ) => Promise<void>
  onRespondQuestion: (
    conversationId: string,
    messageId: string,
    questionId: string,
    answers?: AgentQuestionAnswer[]
  ) => Promise<void>
  onRetry: (content: string) => void
  onRevealEarlier: () => void
  renderAssistantHtml?: boolean
  retryContent?: string
  totalMessageCount: number
}

export const ChatTimeline = memo(function ChatTimeline({
  onOpenImageModelSettings,
  onReselectImageSources,
  onEditImage,
  artifactById,
  conversationId,
  hiddenMessageCount,
  isUnusedConversation,
  locale,
  messageStartIndex,
  messages,
  onArticleRef,
  onCopyMessage,
  onDownloadImage,
  onOpenCitationContext,
  onOpenCitationSource,
  onOpenImage,
  onRespondApproval,
  onRespondQuestion,
  onRetry,
  onRevealEarlier,
  renderAssistantHtml = false,
  retryContent,
  totalMessageCount
}: ChatTimelineProps): React.JSX.Element {
  const { t } = useTranslation('app')

  return (
    <div className="message-list">
      {hiddenMessageCount > 0 && (
        <button
          className="load-earlier-messages"
          onClick={onRevealEarlier}
          type="button"
        >
          {t('chat.loadEarlierMessages', {
            count: hiddenMessageCount
          })}
        </button>
      )}
      {messages.map((message, visibleMessageIndex) => {
        const messageIndex = messageStartIndex + visibleMessageIndex
        return (
          <ChatMessageRow
            onOpenImageModelSettings={onOpenImageModelSettings}
            onReselectImageSources={onReselectImageSources}
            onEditImage={onEditImage}
            artifactById={artifactById}
            canRetry={
              message.state === 'error' &&
              messageIndex === totalMessageCount - 1
            }
            conversationId={conversationId}
            greeting={messageIndex === 0 && isUnusedConversation}
            key={message.id}
            locale={locale}
            message={message}
            onArticleRef={onArticleRef}
            onCopyMessage={onCopyMessage}
            onDownloadImage={onDownloadImage}
            onOpenCitationContext={onOpenCitationContext}
            onOpenCitationSource={onOpenCitationSource}
            onOpenImage={onOpenImage}
            onRespondApproval={onRespondApproval}
            onRespondQuestion={onRespondQuestion}
            onRetry={onRetry}
            renderAssistantHtml={renderAssistantHtml}
            retryContent={retryContent}
          />
        )
      })}
    </div>
  )
})
