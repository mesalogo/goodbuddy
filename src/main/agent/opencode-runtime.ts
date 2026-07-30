import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient
} from '@opencode-ai/sdk'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { AgentRuntime } from './runtime'

type OpenCodeServer = Awaited<ReturnType<typeof createOpencodeServer>>

export type OpenCodeRuntimeOptions = {
  baseUrl?: string
  embedded: boolean
  defaultWorkspace: string
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly requiresToolApproval = true
  private client?: OpencodeClient
  private server?: OpenCodeServer
  private readonly sessions = new Map<string, string>()

  constructor(private readonly options: OpenCodeRuntimeOptions) {}

  private async getClient(): Promise<OpencodeClient> {
    if (this.client) {
      return this.client
    }

    let baseUrl = this.options.baseUrl
    if (!baseUrl && this.options.embedded) {
      this.server = await createOpencodeServer({
        hostname: '127.0.0.1',
        port: 0,
        timeout: 10_000
      })
      baseUrl = this.server.url
    }

    if (!baseUrl) {
      throw new Error('未配置 OpenCode Server')
    }

    this.client = createOpencodeClient({
      baseUrl,
      directory: this.options.defaultWorkspace
    })
    return this.client
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    try {
      const client = await this.getClient()
      const response = await client.session.list({
        query: { directory: this.options.defaultWorkspace }
      })

      if (response.error) {
        throw new Error('OpenCode Server 返回错误')
      }

      return {
        id: 'opencode',
        label: 'OpenCode',
        available: true,
        detail: this.server
          ? '由 GoodBuddy 管理本机 OpenCode 进程'
          : `已连接 ${this.options.baseUrl}`
      }
    } catch (error) {
      return {
        id: 'opencode',
        label: 'OpenCode',
        available: false,
        detail: error instanceof Error ? error.message : 'OpenCode 不可用'
      }
    }
  }

  private async getSessionId(
    client: OpencodeClient,
    request: AgentRequest,
    directory: string
  ): Promise<string> {
    const current = this.sessions.get(request.conversationId)
    if (current) {
      return current
    }

    const response = await client.session.create({
      body: { title: 'GoodBuddy 对话' },
      query: { directory }
    })

    if (!response.data) {
      throw new Error('OpenCode 会话创建失败')
    }

    this.sessions.set(request.conversationId, response.data.id)
    return response.data.id
  }

  async *run(
    request: AgentRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, void, void> {
    const client = await this.getClient()
    const directory = this.options.defaultWorkspace
    const sessionId = await this.getSessionId(client, request, directory)

    yield {
      requestId: request.requestId,
      type: 'status',
      message: 'OpenCode 正在处理请求'
    }

    const subscription = await client.event.subscribe({
      query: { directory },
      signal
    })

    const abortSession = (): void => {
      void client.session.abort({
        path: { id: sessionId },
        query: { directory }
      })
    }
    signal.addEventListener('abort', abortSession, { once: true })

    try {
      const prompt = client.session.promptAsync({
        body: {
          parts: [{ type: 'text', text: request.prompt }]
        },
        path: { id: sessionId },
        query: { directory },
        signal
      })

      for await (const event of subscription.stream) {
        if (
          event.type === 'message.part.updated' &&
          event.properties.part.sessionID === sessionId
        ) {
          const { part, delta } = event.properties
          if (part.type === 'text' && delta) {
            yield {
              requestId: request.requestId,
              type: 'text',
              delta
            }
          } else if (part.type === 'tool') {
            const state =
              part.state.status === 'error' ? 'failed' : part.state.status
            yield {
              requestId: request.requestId,
              type: 'tool',
              name: part.tool,
              state,
              summary: `OpenCode 工具：${part.tool}`
            }
          }
        }

        if (
          event.type === 'session.error' &&
          event.properties.sessionID === sessionId
        ) {
          const error = event.properties.error
          const message =
            error &&
            typeof error.data === 'object' &&
            error.data &&
            'message' in error.data &&
            typeof error.data.message === 'string'
              ? error.data.message
              : 'OpenCode 执行失败'
          throw new Error(message)
        }

        if (
          event.type === 'session.idle' &&
          event.properties.sessionID === sessionId
        ) {
          await prompt
          yield {
            requestId: request.requestId,
            type: 'done',
            sessionId
          }
          return
        }
      }

      await prompt
      throw new Error('OpenCode 事件流意外结束')
    } finally {
      signal.removeEventListener('abort', abortSession)
    }
  }

  async dispose(): Promise<void> {
    this.server?.close()
    this.server = undefined
    this.client = undefined
  }
}
