import type {
  AgentEvent,
  AgentRuntimeStatus
} from '../../shared/contracts'
import { createAnthropicMessagesUrl } from './anthropic-endpoint'
import type {
  AgentExecutionRequest,
  AgentRuntime
} from './runtime'

type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

type ApiMessage = {
  role: 'user' | 'assistant'
  content:
    | string
    | Array<
        | {
            type: 'image'
            source: {
              type: 'base64'
              media_type: 'image/png' | 'image/jpeg'
              data: string
            }
          }
        | {
            type: 'text'
            text: string
          }
      >
}

export type ModelRuntimeOptions = {
  apiKey: string
  baseUrl: string
  model: string
  skillInstructions?: string
  fetcher?: typeof fetch
}

function getErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const error = 'error' in value ? value.error : undefined
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return undefined
}

function getTextDelta(value: unknown): string | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    value.type !== 'content_block_delta' ||
    !('delta' in value) ||
    !value.delta ||
    typeof value.delta !== 'object'
  ) {
    return undefined
  }
  if (
    'type' in value.delta &&
    value.delta.type === 'text_delta' &&
    'text' in value.delta &&
    typeof value.delta.text === 'string'
  ) {
    return value.delta.text
  }
  return undefined
}

function parseStreamBlock(block: string): {
  delta?: string
  stopped: boolean
} {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') {
    return { stopped: false }
  }
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return { stopped: false }
  }
  const error = getErrorMessage(event)
  if (error) {
    throw new Error(error.slice(0, 1_000))
  }
  return {
    delta: getTextDelta(event),
    stopped:
      event !== null &&
      typeof event === 'object' &&
      'type' in event &&
      event.type === 'message_stop'
  }
}

export class ModelAgentRuntime implements AgentRuntime {
  readonly requiresToolApproval = false
  private readonly conversations = new Map<string, ConversationMessage[]>()
  private readonly fetcher: typeof fetch

  constructor(private readonly options: ModelRuntimeOptions) {
    this.fetcher = options.fetcher ?? fetch
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    return {
      id: 'model',
      label: this.options.model,
      available: Boolean(this.options.apiKey),
      detail: `Anthropic Messages 兼容模型接口 · ${this.options.baseUrl}`
    }
  }

  async testConnection(): Promise<AgentRuntimeStatus> {
    if (!this.options.apiKey) {
      return this.getStatus()
    }
    const response = await this.fetcher(
      createAnthropicMessagesUrl(this.options.baseUrl),
      {
        method: 'POST',
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: 1,
          stream: false,
          messages: [{ role: 'user', content: 'Reply OK.' }]
        })
      }
    )
    if (!response.ok) {
      let detail: string | undefined
      try {
        detail = getErrorMessage(await response.json())
      } catch {
        detail = undefined
      }
      throw new Error(
        detail?.slice(0, 1_000) ??
          `模型接口连接测试失败（HTTP ${response.status}）`
      )
    }
    await response.body?.cancel().catch(() => undefined)
    return {
      id: 'model',
      label: this.options.model,
      available: true,
      detail: `已验证模型接口连接 · ${this.options.baseUrl}`
    }
  }

  private getMessages(request: AgentExecutionRequest): ApiMessage[] {
    const history =
      request.history && request.history.length > 0
        ? request.history
        : this.conversations.get(request.conversationId) ?? []
    const content: ApiMessage['content'] =
      request.images && request.images.length > 0
        ? [
            ...request.images.map((image) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: image.mediaType,
                data: image.data
              }
            })),
            {
              type: 'text' as const,
              text: request.prompt
            }
          ]
        : request.prompt
    return [
      ...history.slice(-20),
      {
        role: 'user',
        content
      }
    ]
  }

  private saveConversation(
    conversationId: string,
    messages: ConversationMessage[]
  ): void {
    const retained: ConversationMessage[] = []
    let bytes = 0
    for (const message of messages.slice(-20).reverse()) {
      const messageBytes = Buffer.byteLength(message.content)
      if (bytes + messageBytes > 512 * 1024) {
        break
      }
      retained.unshift(message)
      bytes += messageBytes
    }
    this.conversations.delete(conversationId)
    this.conversations.set(conversationId, retained)
    while (this.conversations.size > 50) {
      const oldest = this.conversations.keys().next().value
      if (oldest) {
        this.conversations.delete(oldest)
      }
    }
  }

  async *run(
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, void, void> {
    if (!this.options.apiKey) {
      throw new Error('请先在设置中配置模型接口 API Key')
    }

    yield {
      requestId: request.requestId,
      type: 'status',
      message: `${this.options.model} 正在思考`
    }

    const messages = this.getMessages(request)
    const response = await this.fetcher(
      createAnthropicMessagesUrl(this.options.baseUrl),
      {
        method: 'POST',
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: 4096,
          stream: true,
          system: [
            'You are GoodBuddy, a secure desktop assistant. Answer clearly in the language used by the user. Never claim to have used desktop tools unless a tool result was provided.',
            this.options.skillInstructions
          ]
            .filter(Boolean)
            .join('\n\n'),
          messages
        }),
        signal
      }
    )

    if (!response.ok) {
      let detail: string | undefined
      try {
        detail = getErrorMessage(await response.json())
      } catch {
        detail = undefined
      }
      throw new Error(
        detail ?? `模型接口请求失败（HTTP ${response.status}）`
      )
    }

    if (!response.body) {
      throw new Error('模型接口未返回流式响应')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    let receivedStop = false
    let streamEnded = false

    try {
      while (!receivedStop) {
        const { done, value } = await reader.read()
        streamEnded = done
        buffer += decoder.decode(value, { stream: !done }).replaceAll(
          '\r\n',
          '\n'
        )

        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          throw new Error('模型接口流式响应块超过安全限制')
        }

        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        if (done && buffer.trim()) {
          blocks.push(buffer)
          buffer = ''
        }

        for (const block of blocks) {
          const parsed = parseStreamBlock(block)
          const { delta } = parsed
          if (delta) {
            answer += delta
            yield {
              requestId: request.requestId,
              type: 'text',
              delta
            }
          }

          if (parsed.stopped) {
            receivedStop = true
            break
          }
        }

        if (done) {
          break
        }
      }
    } finally {
      if (!streamEnded) {
        await reader.cancel().catch(() => undefined)
      }
      reader.releaseLock()
    }

    if (!receivedStop) {
      throw new Error('模型接口流式响应意外中断')
    }
    if (!answer) {
      throw new Error('模型接口返回了空内容')
    }

    this.saveConversation(request.conversationId, [
      ...(request.history ??
        this.conversations.get(request.conversationId) ??
        []).slice(-20),
      { role: 'user', content: request.prompt },
      { role: 'assistant', content: answer }
    ])

    yield {
      requestId: request.requestId,
      type: 'done'
    }
  }

  async dispose(): Promise<void> {
    this.conversations.clear()
  }
}
