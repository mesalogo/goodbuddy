import type {
  AgentRuntimeStatus,
  ModelAuthentication,
  ModelProtocol
} from '../../shared/contracts'
import { createAnthropicMessagesUrl } from './anthropic-endpoint'
import {
  createOpenAIChatCompletionsUrl,
  createOpenAIImagesGenerationsUrl
} from './openai-endpoint'
import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeEvent,
  RuntimeModelUsageEvent
} from './runtime'
import { redactSensitiveText } from './approval-summary'

type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
}

type AnthropicApiMessage = {
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

type ModelUsageUpdate = {
  callId?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reportedTotalTokens?: number
}

type ModelUsageAccumulator = ModelUsageUpdate & {
  reported: boolean
}

const maxGeneratedImageBytes = 3_900_000
const maxImageResponseBytes = 5_300_000

export type ModelRuntimeOptions = {
  apiKey?: string
  baseUrl: string
  model: string
  protocol: ModelProtocol
  authentication: ModelAuthentication
  skillInstructions?: string
  fetcher?: typeof fetch
}

function getErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const error = 'error' in value ? value.error : undefined
  if (typeof error === 'string') {
    return redactSensitiveText(error).slice(0, 1_000)
  }
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return redactSensitiveText(error.message).slice(0, 1_000)
  }
  if (
    'message' in value &&
    typeof value.message === 'string'
  ) {
    return redactSensitiveText(value.message).slice(0, 1_000)
  }
  return undefined
}

function getAnthropicTextDelta(value: unknown): string | undefined {
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

function getOpenAITextDelta(value: unknown): string | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('choices' in value) ||
    !Array.isArray(value.choices)
  ) {
    return undefined
  }
  const first = value.choices[0]
  if (
    !first ||
    typeof first !== 'object' ||
    !('delta' in first) ||
    !first.delta ||
    typeof first.delta !== 'object' ||
    !('content' in first.delta) ||
    typeof first.delta.content !== 'string'
  ) {
    return undefined
  }
  return first.delta.content
}

function getRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
}

function getSafeTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined
}

function getProviderIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512
    ? value
    : undefined
}

function getUsageUpdate(
  value: unknown,
  protocol: 'anthropic' | 'openai'
): ModelUsageUpdate {
  const event = getRecord(value)
  if (!event) {
    return {}
  }

  let metadata = event
  let usage: Record<string, unknown> | undefined
  if (protocol === 'anthropic') {
    if (event.type === 'message_start') {
      metadata = getRecord(event.message) ?? event
      usage = getRecord(metadata.usage)
    } else if (event.type === 'message_delta') {
      usage = getRecord(event.usage)
    }
  } else {
    usage = getRecord(event.usage)
  }

  const promptDetails =
    protocol === 'openai'
      ? getRecord(usage?.prompt_tokens_details)
      : undefined
  return {
    callId: getProviderIdentifier(metadata.id),
    model: getProviderIdentifier(metadata.model),
    inputTokens: getSafeTokenCount(
      protocol === 'anthropic'
        ? usage?.input_tokens
        : usage?.prompt_tokens ?? usage?.input_tokens
    ),
    outputTokens: getSafeTokenCount(
      protocol === 'anthropic'
        ? usage?.output_tokens
        : usage?.completion_tokens ?? usage?.output_tokens
    ),
    cacheReadTokens: getSafeTokenCount(
      protocol === 'anthropic'
        ? usage?.cache_read_input_tokens
        : usage?.cache_read_tokens ?? promptDetails?.cached_tokens
    ),
    cacheWriteTokens: getSafeTokenCount(
      protocol === 'anthropic'
        ? usage?.cache_creation_input_tokens
        : usage?.cache_write_tokens
    ),
    reportedTotalTokens: getSafeTokenCount(usage?.total_tokens)
  }
}

function applyUsageUpdate(
  accumulator: ModelUsageAccumulator,
  update: ModelUsageUpdate
): void {
  for (const key of [
    'callId',
    'model',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reportedTotalTokens'
  ] as const) {
    const value = update[key]
    if (value !== undefined) {
      Object.assign(accumulator, { [key]: value })
      if (
        key !== 'callId' &&
        key !== 'model'
      ) {
        accumulator.reported = true
      }
    }
  }
}

function createUsageEvent(
  requestId: string,
  provider: 'anthropic' | 'openai',
  fallbackModel: string,
  usage: ModelUsageAccumulator
): RuntimeModelUsageEvent | undefined {
  if (!usage.reported) {
    return undefined
  }
  return {
    requestId,
    type: 'model-usage',
    callId: (usage.callId ?? requestId).slice(0, 256),
    runtime: 'model',
    provider,
    model: (usage.model ?? fallbackModel).slice(0, 500),
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    ...(usage.reportedTotalTokens === undefined
      ? {}
      : { reportedTotalTokens: usage.reportedTotalTokens })
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (!response.body) {
    throw new Error('模型接口未返回响应内容')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('图像生成响应超过安全限制')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function parseGeneratedImage(value: unknown): {
  data: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
} {
  if (
    !value ||
    typeof value !== 'object' ||
    !('data' in value) ||
    !Array.isArray(value.data) ||
    value.data.length !== 1
  ) {
    throw new Error('图像生成接口返回格式无效')
  }
  const first = value.data[0]
  if (
    !first ||
    typeof first !== 'object'
  ) {
    throw new Error('图像生成接口未返回 base64 图片')
  }
  const inlineUrl =
    'url' in first && typeof first.url === 'string'
      ? /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
          first.url
        )
      : undefined
  const encoded =
    'b64_json' in first && typeof first.b64_json === 'string'
      ? first.b64_json
      : inlineUrl?.[1]
  if (!encoded) {
    throw new Error('图像生成接口未返回 base64 图片')
  }
  if (
    encoded.length === 0 ||
    encoded.length > maxImageResponseBytes ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new Error('图像生成接口返回了无效图片数据')
  }
  const data = Buffer.from(encoded, 'base64')
  if (
    data.length === 0 ||
    data.length > maxGeneratedImageBytes ||
    data.toString('base64') !== encoded
  ) {
    throw new Error('图像生成图片无效或超过安全限制')
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    return { data: encoded, mimeType: 'image/png' }
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return { data: encoded, mimeType: 'image/jpeg' }
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { data: encoded, mimeType: 'image/webp' }
  }
  throw new Error('图像生成接口返回了不支持的图片格式')
}

function parseStreamBlock(
  block: string,
  protocol: ModelProtocol
): {
  delta?: string
  stopped: boolean
  usage?: ModelUsageUpdate
} {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) {
    return { stopped: false }
  }
  if (data === '[DONE]') {
    return {
      stopped: protocol === 'openai-chat-completions'
    }
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
    delta:
      protocol === 'anthropic-messages'
        ? getAnthropicTextDelta(event)
        : getOpenAITextDelta(event),
    usage: getUsageUpdate(
      event,
      protocol === 'anthropic-messages' ? 'anthropic' : 'openai'
    ),
    stopped:
      protocol === 'anthropic-messages' &&
      event !== null &&
      typeof event === 'object' &&
      'type' in event &&
      event.type === 'message_stop'
  }
}

export class ModelAgentRuntime implements AgentRuntime {
  readonly requiresToolApproval = false
  readonly supportsToolExecution = false
  private readonly conversations = new Map<string, ConversationMessage[]>()
  private readonly fetcher: typeof fetch

  constructor(private readonly options: ModelRuntimeOptions) {
    this.fetcher = options.fetcher ?? fetch
  }

  get capability(): 'chat' | 'image-generation' {
    return this.options.protocol === 'openai-images-generations'
      ? 'image-generation'
      : 'chat'
  }

  private isConfigured(): boolean {
    return (
      this.options.authentication === 'none' ||
      Boolean(this.options.apiKey)
    )
  }

  private getEndpoint(): URL {
    if (this.options.protocol === 'anthropic-messages') {
      return createAnthropicMessagesUrl(this.options.baseUrl)
    }
    return this.options.protocol === 'openai-images-generations'
      ? createOpenAIImagesGenerationsUrl(this.options.baseUrl)
      : createOpenAIChatCompletionsUrl(this.options.baseUrl)
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    }
    if (
      this.options.authentication === 'api-key' &&
      this.options.apiKey
    ) {
      if (this.options.protocol === 'anthropic-messages') {
        headers['anthropic-version'] = '2023-06-01'
        headers['x-api-key'] = this.options.apiKey
      } else {
        headers.authorization = `Bearer ${this.options.apiKey}`
      }
    } else if (this.options.protocol === 'anthropic-messages') {
      headers['anthropic-version'] = '2023-06-01'
    }
    return headers
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    const imageGeneration = this.capability === 'image-generation'
    return {
      id: 'model',
      label: this.options.model,
      available: this.isConfigured(),
      supportsToolExecution: this.supportsToolExecution,
      detail: `${imageGeneration
        ? 'OpenAI Images Generations'
        : this.options.protocol === 'anthropic-messages'
          ? 'Anthropic Messages'
          : 'OpenAI Chat Completions'
      } 兼容模型接口 · ${this.options.baseUrl}`,
      capability: imageGeneration ? 'image-generation' : 'chat'
    }
  }

  async testConnection(): Promise<AgentRuntimeStatus> {
    if (!this.isConfigured()) {
      return this.getStatus()
    }
    if (this.options.protocol === 'openai-images-generations') {
      return {
        ...(await this.getStatus()),
        detail: `已识别图像生成配置，发送提示词时执行实际生成验证 · ${this.options.baseUrl}`
      }
    }
    const response = await this.fetcher(this.getEndpoint(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: 1,
        stream: false,
        messages: [{ role: 'user', content: 'Reply OK.' }]
      })
    })
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
      supportsToolExecution: this.supportsToolExecution,
      detail: `已验证模型接口连接 · ${this.options.baseUrl}`
    }
  }

  private getAnthropicMessages(
    request: AgentExecutionRequest
  ): AnthropicApiMessage[] {
    const history =
      request.history && request.history.length > 0
        ? request.history
        : this.conversations.get(request.conversationId) ?? []
    const content: AnthropicApiMessage['content'] =
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

  private getOpenAIMessages(
    request: AgentExecutionRequest,
    system: string
  ): Array<Record<string, unknown>> {
    const history =
      request.history && request.history.length > 0
        ? request.history
        : this.conversations.get(request.conversationId) ?? []
    const userContent =
      request.images && request.images.length > 0
        ? [
            {
              type: 'text',
              text: request.prompt
            },
            ...request.images.map((image) => ({
              type: 'image_url',
              image_url: {
                url: `data:${image.mediaType};base64,${image.data}`
              }
            }))
          ]
        : request.prompt
    return [
      { role: 'system', content: system },
      ...history.slice(-20),
      { role: 'user', content: userContent }
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

  private async *runImageGeneration(
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): AsyncGenerator<RuntimeEvent, void, void> {
    if (request.images?.length) {
      throw new Error('当前图像生成接口暂不支持参考图或图片编辑')
    }
    yield {
      requestId: request.requestId,
      type: 'status',
      message: `${this.options.model} 正在生成图片`
    }
    const imageRequest = {
      model: this.options.model,
      prompt: request.prompt.slice(0, 100_000),
      n: 1,
      response_format: 'b64_json'
    }
    const response = await this.fetcher(this.getEndpoint(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(imageRequest),
      signal
    })
    const responseText = await readBoundedText(
      response,
      response.ok ? maxImageResponseBytes : 128 * 1024
    )
    if (!response.ok) {
      let errorPayload: unknown
      try {
        errorPayload = responseText.trim()
          ? JSON.parse(responseText)
          : undefined
      } catch {
        errorPayload = undefined
      }
      const requestId = [
        response.headers.get('x-request-id'),
        response.headers.get('cf-ray')
      ].find(
        (candidate) =>
          candidate &&
          candidate.length <= 128 &&
          /^[\w.-]+$/u.test(candidate)
      )
      const providerMessage = getErrorMessage(errorPayload)
      const publicMessage =
        response.status === 502 &&
        providerMessage?.includes('模型接口请求失败')
          ? '上游图像服务暂时不可用，请稍后重试或联系服务商'
          : providerMessage
            ? redactSensitiveText(providerMessage).slice(0, 1_000)
            : '图像生成请求失败'
      throw new Error(
        `${publicMessage}（HTTP ${response.status}${
          requestId ? `，请求 ID ${requestId}` : ''
        }）`
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(responseText)
    } catch {
      throw new Error('图像生成接口返回了无效 JSON')
    }
    const image = parseGeneratedImage(payload)
    const usage = {
      reported: false
    } satisfies ModelUsageAccumulator
    applyUsageUpdate(usage, getUsageUpdate(payload, 'openai'))
    const usageEvent = createUsageEvent(
      request.requestId,
      'openai',
      this.options.model,
      usage
    )
    if (usageEvent) {
      yield usageEvent
    }
    yield {
      requestId: request.requestId,
      type: 'generated-image',
      mimeType: image.mimeType,
      data: image.data,
      title: request.prompt.split(/\r?\n/u, 1)[0]!.slice(0, 120)
    }
    yield {
      requestId: request.requestId,
      type: 'done'
    }
  }

  async *run(
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): AsyncGenerator<RuntimeEvent, void, void> {
    if (!this.isConfigured()) {
      throw new Error('请先在设置中配置模型接口 API Key')
    }
    if (this.options.protocol === 'openai-images-generations') {
      yield* this.runImageGeneration(request, signal)
      return
    }

    yield {
      requestId: request.requestId,
      type: 'status',
      message: `${this.options.model} 正在思考`
    }

    const system = [
      'You are GoodBuddy, a secure desktop assistant. Answer clearly in the language used by the user. Never claim to have used desktop tools unless a tool result was provided.',
      this.options.skillInstructions
    ]
      .filter(Boolean)
      .join('\n\n')
    const anthropic = this.options.protocol === 'anthropic-messages'
    const messages = anthropic
      ? this.getAnthropicMessages(request)
      : this.getOpenAIMessages(request, system)
    const response = await this.fetcher(this.getEndpoint(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(
        anthropic
          ? {
              model: this.options.model,
              max_tokens: 4096,
              stream: true,
              system,
              messages
            }
          : {
              model: this.options.model,
              max_tokens: 4096,
              stream: true,
              stream_options: {
                include_usage: true
              },
              messages
            }
      ),
      signal
    })

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
    const usage = {
      reported: false
    } satisfies ModelUsageAccumulator

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
          const parsed = parseStreamBlock(block, this.options.protocol)
          if (parsed.usage) {
            applyUsageUpdate(usage, parsed.usage)
          }
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

    const usageEvent = createUsageEvent(
      request.requestId,
      anthropic ? 'anthropic' : 'openai',
      this.options.model,
      usage
    )
    if (usageEvent) {
      yield usageEvent
    }
    yield {
      requestId: request.requestId,
      type: 'done'
    }
  }

  async dispose(): Promise<void> {
    this.conversations.clear()
  }

  releaseConversation(conversationId: string): Promise<void> {
    this.conversations.delete(conversationId)
    return Promise.resolve()
  }
}
