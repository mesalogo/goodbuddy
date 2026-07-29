import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { AgentRuntime } from './runtime'

type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type BigtokenRuntimeOptions = {
  apiKey: string
  baseUrl: string
  model: string
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

export class BigtokenAgentRuntime implements AgentRuntime {
  private readonly conversations = new Map<string, ConversationMessage[]>()
  private readonly fetcher: typeof fetch

  constructor(private readonly options: BigtokenRuntimeOptions) {
    this.fetcher = options.fetcher ?? fetch
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    return {
      id: 'bigtoken',
      label: this.options.model,
      available: Boolean(this.options.apiKey),
      detail: `Bigtoken Anthropic API · ${this.options.baseUrl}`
    }
  }

  private getMessages(request: AgentRequest): ConversationMessage[] {
    const history = this.conversations.get(request.conversationId) ?? []
    return [
      ...history.slice(-20),
      {
        role: 'user',
        content: request.prompt
      } satisfies ConversationMessage
    ]
  }

  async *run(
    request: AgentRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, void, void> {
    yield {
      requestId: request.requestId,
      type: 'status',
      message: `${this.options.model} 正在思考`
    }

    const messages = this.getMessages(request)
    const response = await this.fetcher(
      new URL('/v1/messages', this.options.baseUrl),
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
          system:
            'You are GoodBuddy, a secure desktop assistant. Answer clearly in the language used by the user. Never claim to have used desktop tools unless a tool result was provided.',
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
        detail ?? `Bigtoken 请求失败（HTTP ${response.status}）`
      )
    }

    if (!response.body) {
      throw new Error('Bigtoken 未返回流式响应')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    let completed = false

    while (!completed) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replaceAll(
        '\r\n',
        '\n'
      )

      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')

        if (!data || data === '[DONE]') {
          continue
        }

        let event: unknown
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }

        const error = getErrorMessage(event)
        if (error) {
          throw new Error(error)
        }

        const delta = getTextDelta(event)
        if (delta) {
          answer += delta
          yield {
            requestId: request.requestId,
            type: 'text',
            delta
          }
        }

        if (
          event &&
          typeof event === 'object' &&
          'type' in event &&
          event.type === 'message_stop'
        ) {
          completed = true
          break
        }
      }

      if (done) {
        completed = true
      }
    }

    if (!answer) {
      throw new Error('Bigtoken 返回了空内容')
    }

    this.conversations.set(request.conversationId, [
      ...messages,
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
