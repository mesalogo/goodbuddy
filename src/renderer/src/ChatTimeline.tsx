import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Library,
  ClockFading,
  LoaderCircle,
  ShieldCheck,
  TerminalSquare,
  UserRound,
  XCircle
} from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  createdAt: number
  state: 'streaming' | 'complete' | 'error'
  status?: string
  contextCompression?: ConversationMessage['contextCompression']
  contextCompressions?: ConversationMessage['contextCompressions']
  tools?: ToolActivity[]
  subagents?: SubagentActivity[]
  approval?: {
    id: string
    title: string
    description: string
    toolName?: string
    argumentSummary?: string
    allowPermanent?: boolean
  }
  question?: Extract<AgentEvent, { type: 'question' }>
  sources?: string[]
  sourceReferences?: KnowledgeSearchReference[]
  knowledgeRetrieval?: KnowledgeRetrievalStatus
  artifactIds?: string[]
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

function groupMessageBlocks(
  blocks: ConversationMessageBlock[]
): MessageBlockRenderItem[] {
  const items: MessageBlockRenderItem[] = []
  for (const block of blocks) {
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

function ToolExecutionList({
  tools
}: {
  tools: ToolActivity[]
}): React.JSX.Element {
  const { t } = useTranslation('app')

  return (
    <section
      aria-label={t('chat.tools.region', { count: tools.length })}
      className="tool-execution-list"
    >
      <header className="tool-execution-list__header">
        <TerminalSquare aria-hidden="true" size={15} />
        <strong>{t('chat.tools.title')}</strong>
        <small>{t('chat.tools.count', { count: tools.length })}</small>
      </header>
      <ol>
        {tools.map((tool) => {
          const hasDetails = Boolean(
            tool.input || tool.output || tool.error
          )
          return (
            <li key={tool.callId ?? tool.name}>
              <details
                className={`tool-execution tool-execution--${tool.state}`}
                open={
                  tool.state === 'pending' || tool.state === 'running'
                    ? true
                    : undefined
                }
              >
                <summary>
                  <span className="tool-execution__identity">
                    <strong>{tool.name}</strong>
                    <span>{tool.summary}</span>
                  </span>
                  <small
                    aria-label={t(`chat.tools.states.${tool.state}`)}
                  >
                    {t(`chat.tools.states.${tool.state}`)}
                  </small>
                </summary>
                <div className="tool-execution__details">
                  {tool.input && (
                    <section>
                      <strong>{t('chat.tools.input')}</strong>
                      <pre>{tool.input}</pre>
                    </section>
                  )}
                  {tool.output && (
                    <section>
                      <strong>{t('chat.tools.output')}</strong>
                      <pre>{tool.output}</pre>
                    </section>
                  )}
                  {tool.error && (
                    <section className="tool-execution__error">
                      <strong>{t('chat.tools.error')}</strong>
                      <pre>{tool.error}</pre>
                    </section>
                  )}
                  {!hasDetails && <p>{t('chat.tools.noDetails')}</p>}
                </div>
              </details>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

const SubagentStatusCard = memo(function SubagentStatusCard({
  subagent
}: {
  subagent: SubagentActivity
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
          aria-label={t(`chat.subagents.states.${subagent.state}`)}
          className={`subagent-status-card__status subagent-status-card__status--${subagent.state}`}
        >
          <StateIcon aria-hidden="true" size={14} />
          {t(`chat.subagents.states.${subagent.state}`)}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="subagent-status-card__chevron"
          size={15}
        />
      </summary>
      {expanded && (
        <div className="subagent-status-card__details">
          {subagent.output ? (
            <section>
              <strong>{t('chat.subagents.output')}</strong>
              <div className="markdown-content">
                <MarkdownRenderer>{subagent.output}</MarkdownRenderer>
              </div>
            </section>
          ) : (
            <p>{t('chat.subagents.noOutput')}</p>
          )}
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
  subagents
}: {
  subagents: SubagentActivity[]
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
          subagent={subagent}
        />
      ))}
    </section>
  )
}

type ChatMessageRowProps = {
  artifactById: ReadonlyMap<string, AssistantArtifact>
  canRetry: boolean
  conversationId: string
  greeting: boolean
  locale: TimeFormatLocale
  message: Message
  onArticleRef: (messageId: string, element: HTMLElement | null) => void
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
  artifactById,
  canRetry,
  conversationId,
  greeting,
  locale,
  message,
  onArticleRef,
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

  return (
    <>
    <article
      className={`message message--${message.role}`}
      ref={(element) => onArticleRef(message.id, element)}
      tabIndex={-1}
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
                    <strong>{attachment.name}</strong>
                    <small>{formatAttachmentSize(attachment.size)}</small>
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
                          onClick={() => onDownloadImage(imageItem)}
                          type="button"
                        >
                          <Download size={12} />
                          {t('chat.images.download')}
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
              item.kind === 'tools' ? (
                <ToolExecutionList key={item.id} tools={item.tools} />
              ) : item.kind === 'subagents' ? (
                <SubagentStatusList
                  key={item.id}
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
                  <MarkdownRenderer>{item.block.content}</MarkdownRenderer>
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
                <MarkdownRenderer>
                  {greeting ? t('conversation.greeting') : message.content}
                </MarkdownRenderer>
              </div>
            )}
          </>
        )}
        {unorderedSubagents && unorderedSubagents.length > 0 && (
          <SubagentStatusList subagents={unorderedSubagents} />
        )}
        {message.artifactIds?.map((artifactId) => {
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
                  onClick={() =>
                    onDownloadImage({
                      src: artifact.content!,
                      title: artifact.title
                    })
                  }
                  type="button"
                >
                  <Download size={12} />
                  {t('chat.images.download')}
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
                        <button
                          className="secondary-button"
                          disabled={!reference.chunkId}
                          onClick={() =>
                            void onOpenCitationSource(reference)
                          }
                          type="button"
                        >
                          {t('chat.citations.openSource')}
                        </button>
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
            <ToolExecutionList tools={message.tools} />
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
        {message.question && (
          <AgentQuestionCard
            key={message.question.questionId}
            onReject={() =>
              onRespondQuestion(
                conversationId,
                message.id,
                message.question!.questionId
              )
            }
            onSubmit={(answers) =>
              onRespondQuestion(
                conversationId,
                message.id,
                message.question!.questionId,
                answers
              )
            }
            value={message.question}
          />
        )}
        {message.status && (
          <div
            aria-atomic="true"
            aria-label={message.status}
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
              className={
                message.state === 'streaming'
                  ? 'message__status-dot message__status-dot--active'
                  : 'message__status-dot'
              }
            />
            {message.status}
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
  artifactById: ReadonlyMap<string, AssistantArtifact>
  conversationId: string
  hiddenMessageCount: number
  isUnusedConversation: boolean
  locale: TimeFormatLocale
  messageStartIndex: number
  messages: Message[]
  onArticleRef: (messageId: string, element: HTMLElement | null) => void
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
  retryContent?: string
  totalMessageCount: number
}

export function ChatTimeline({
  artifactById,
  conversationId,
  hiddenMessageCount,
  isUnusedConversation,
  locale,
  messageStartIndex,
  messages,
  onArticleRef,
  onDownloadImage,
  onOpenCitationContext,
  onOpenCitationSource,
  onOpenImage,
  onRespondApproval,
  onRespondQuestion,
  onRetry,
  onRevealEarlier,
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
            onDownloadImage={onDownloadImage}
            onOpenCitationContext={onOpenCitationContext}
            onOpenCitationSource={onOpenCitationSource}
            onOpenImage={onOpenImage}
            onRespondApproval={onRespondApproval}
            onRespondQuestion={onRespondQuestion}
            onRetry={onRetry}
            retryContent={retryContent}
          />
        )
      })}
    </div>
  )
}
