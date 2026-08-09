import {
  CHANNEL_LIMITS,
  channelExecutorResultSchema,
  channelInboundTextSchema,
  channelResultMessageSchema,
  type ChannelInboundText,
  type ChannelResultMessage
} from '../../shared/channel-contracts'
import {
  MemoryDedupStore,
  MemoryOutbox,
  type ChannelDriver,
  type ChannelExecutor,
  type DedupStore,
  type Outbox
} from './channel-driver'

const TRUNCATION_MARKER = '\n…（结果已截断）'

export type ChannelServiceOptions = {
  allowedSenderIds?: readonly string[]
  allowGroupMessages?: boolean
  maximumConcurrency?: number
  maximumInputLength?: number
  maximumResultLength?: number
  dedupStore?: DedupStore
  outbox?: Outbox
  onDeliveryFailure?: (error: unknown) => void
  onDeliverySuccess?: () => void
}

type ServiceState = 'idle' | 'running' | 'stopped'

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const candidate = value ?? fallback
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > maximum
  ) {
    throw new Error(`${name}无效`)
  }
  return candidate
}

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value
  }
  if (maximumLength <= TRUNCATION_MARKER.length) {
    return value.slice(0, maximumLength)
  }
  return (
    value.slice(0, maximumLength - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  )
}

export function redactChannelError(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [已隐藏]')
    .replace(
      /\b(api[_-]?key|authorization|password|secret|token)\b(\s*[:=]\s*)([^\s,;]+)/giu,
      '$1$2[已隐藏]'
    )
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '[凭据已隐藏]')
    .replace(
      /\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/giu,
      '$1[凭据已隐藏]@'
    )
    .replace(
      /(?:[a-z]:\\|\\\\)[^\r\n"'<>|]*/giu,
      '[路径已隐藏]'
    )
}

export class ChannelService {
  private readonly allowedSenderIds: ReadonlySet<string>
  private readonly allowGroupMessages: boolean
  private readonly maximumConcurrency: number
  private readonly maximumInputLength: number
  private readonly maximumResultLength: number
  private readonly dedupStore: DedupStore
  private readonly outbox: Outbox
  private readonly onDeliveryFailure?: (error: unknown) => void
  private readonly onDeliverySuccess?: () => void
  private readonly tasks = new Set<Promise<void>>()
  private readonly active = new Map<string, AbortController>()
  private state: ServiceState = 'idle'
  private stopPromise?: Promise<void>

  constructor(
    private readonly driver: ChannelDriver,
    private readonly executor: ChannelExecutor,
    options: ChannelServiceOptions = {}
  ) {
    const channel = driver.channel.trim()
    if (
      channel.length < 1 ||
      channel.length > CHANNEL_LIMITS.maximumChannelLength
    ) {
      throw new Error('通道标识无效')
    }

    this.allowedSenderIds = new Set(
      (options.allowedSenderIds ?? []).map((senderId) => senderId.trim())
    )
    if (this.allowedSenderIds.has('')) {
      throw new Error('通道白名单包含无效身份')
    }
    this.allowGroupMessages = options.allowGroupMessages ?? false
    this.maximumConcurrency = boundedInteger(
      options.maximumConcurrency,
      2,
      100,
      '通道并发限制'
    )
    this.maximumInputLength = boundedInteger(
      options.maximumInputLength,
      8_000,
      CHANNEL_LIMITS.maximumTextLength,
      '通道输入长度限制'
    )
    this.maximumResultLength = boundedInteger(
      options.maximumResultLength,
      4_000,
      CHANNEL_LIMITS.maximumResultLength,
      '通道结果长度限制'
    )
    this.dedupStore = options.dedupStore ?? new MemoryDedupStore()
    this.outbox = options.outbox ?? new MemoryOutbox()
    this.onDeliveryFailure = options.onDeliveryFailure
    this.onDeliverySuccess = options.onDeliverySuccess
  }

  async start(): Promise<void> {
    if (this.state === 'running') {
      return
    }
    if (this.state === 'stopped') {
      throw new Error('通道服务已停止')
    }

    this.state = 'running'
    try {
      await this.driver.start(async (rawMessage, acknowledge) => {
        await acknowledge()
        if (this.state !== 'running') {
          return
        }

        const task = this.process(rawMessage).catch(() => {
          // Processing failures are converted to bounded channel results.
        })
        this.tasks.add(task)
        void task.finally(() => {
          this.tasks.delete(task)
        })
      })
      await this.retryUndelivered()
    } catch (error) {
      this.state = 'idle'
      throw error
    }
  }

  cancel(eventId: string): boolean {
    const controller = this.active.get(
      this.activeKey(this.driver.channel, eventId)
    )
    if (!controller) {
      return false
    }
    controller.abort(new Error('通道请求已取消'))
    return true
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise
    }
    if (this.state === 'stopped') {
      return Promise.resolve()
    }

    this.state = 'stopped'
    for (const controller of this.active.values()) {
      controller.abort(new Error('通道服务已停止'))
    }

    this.stopPromise = this.finishStop()
    return this.stopPromise
  }

  private async finishStop(): Promise<void> {
    const driverStop = Promise.resolve().then(() => this.driver.stop())
    const results = await Promise.allSettled([
      driverStop,
      ...this.tasks
    ])
    const driverResult = results[0]
    if (driverResult?.status === 'rejected') {
      throw driverResult.reason
    }
  }

  private async retryUndelivered(): Promise<void> {
    const entries = await this.outbox.listUndelivered(
      this.driver.channel,
      100
    )
    let consecutiveFailures = 0
    for (const entry of entries) {
      if (this.state !== 'running') {
        return
      }
      if (entry.attempts >= 5) {
        continue
      }
      try {
        await this.driver.send(
          entry.message,
          new AbortController().signal
        )
        await this.outbox.markDelivered(entry.id)
        this.onDeliverySuccess?.()
        consecutiveFailures = 0
      } catch (error) {
        await this.outbox.markFailed(entry.id)
        this.onDeliveryFailure?.(error)
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) {
          return
        }
      }
    }
  }

  private async process(rawMessage: unknown): Promise<void> {
    const parsed = channelInboundTextSchema.safeParse(rawMessage)
    if (!parsed.success) {
      return
    }
    const message = parsed.data

    if (
      message.channel !== this.driver.channel ||
      !this.allowedSenderIds.has(message.senderId) ||
      (message.conversationType === 'group' &&
        (!this.allowGroupMessages || !message.mentioned))
    ) {
      return
    }

    const claimed = await this.dedupStore.claim(
      message.channel,
      message.eventId
    )
    if (!claimed) {
      return
    }

    if (message.text.length > this.maximumInputLength) {
      await this.deliver(
        this.result(message, {
          status: 'rejected',
          error: `消息过长，最多允许 ${this.maximumInputLength} 个字符`
        }),
        new AbortController().signal
      )
      return
    }

    if (this.active.size >= this.maximumConcurrency) {
      await this.deliver(
        this.result(message, {
          status: 'busy',
          error: '当前请求较多，请稍后重试'
        }),
        new AbortController().signal
      )
      return
    }

    const key = this.activeKey(message.channel, message.eventId)
    const controller = new AbortController()
    this.active.set(key, controller)
    try {
      const rawResult = await this.execute(message, controller.signal)
      if (controller.signal.aborted) {
        await this.deliver(
          this.result(message, {
            status: 'cancelled',
            error: '请求已取消'
          }),
          new AbortController().signal
        )
        return
      }

      const result = channelExecutorResultSchema.safeParse(rawResult)
      if (!result.success) {
        await this.deliver(
          this.result(message, {
            status: 'failed',
            error: '请求返回了无效结果'
          }),
          controller.signal
        )
        return
      }
      await this.deliver(this.result(message, result.data), controller.signal)
    } catch {
      const cancelled = controller.signal.aborted
      await this.deliver(
        this.result(message, {
          status: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? '请求已取消' : '请求处理失败'
        }),
        new AbortController().signal
      )
    } finally {
      this.active.delete(key)
    }
  }

  private execute(
    message: ChannelInboundText,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<ChannelExecutor>>> {
    if (signal.aborted) {
      return Promise.reject(signal.reason)
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (
        callback: typeof resolve | typeof reject,
        value: Awaited<ReturnType<ChannelExecutor>> | unknown
      ): void => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', abort)
        callback(value as Awaited<ReturnType<ChannelExecutor>>)
      }
      const abort = (): void => {
        finish(reject, signal.reason)
      }

      signal.addEventListener('abort', abort, { once: true })
      let progressCount = 0
      const reportProgress = async (rawResult: {
        status: string
        output?: string
        error?: string
      }): Promise<void> => {
        if (signal.aborted) {
          throw signal.reason
        }
        if (progressCount >= 3) {
          throw new Error('远程进度消息超过限制')
        }
        const result = channelExecutorResultSchema.parse(rawResult)
        progressCount += 1
        await this.deliver(
          this.result(message, result),
          signal
        )
      }
      void Promise.resolve()
        .then(() => this.executor(message, signal, reportProgress))
        .then(
          (result) => finish(resolve, result),
          (error: unknown) => finish(reject, error)
        )
    })
  }

  private result(
    message: ChannelInboundText,
    result: {
      status: string
      output?: string
      error?: string
      attachments?: ChannelResultMessage['attachments']
    }
  ): ChannelResultMessage {
    return channelResultMessageSchema.parse({
      channel: message.channel,
      eventId: message.eventId,
      conversationId: message.conversationId,
      recipientId: message.senderId,
      status: result.status,
      ...(result.output === undefined
        ? {}
        : {
            output: truncate(result.output, this.maximumResultLength)
          }),
      ...(result.error === undefined
        ? {}
        : {
            error: truncate(
              redactChannelError(result.error),
              CHANNEL_LIMITS.maximumErrorLength
            )
          }),
      ...(result.attachments?.length
        ? { attachments: result.attachments }
        : {})
    })
  }

  private async deliver(
    message: ChannelResultMessage,
    signal: AbortSignal
  ): Promise<void> {
    const entry = await this.outbox.enqueue(message)
    try {
      await this.driver.send(message, signal)
      await this.outbox.markDelivered(entry.id)
      this.onDeliverySuccess?.()
    } catch (error) {
      await this.outbox.markFailed(entry.id)
      this.onDeliveryFailure?.(error)
      throw error
    }
  }

  private activeKey(channel: string, eventId: string): string {
    return `${channel}\u0000${eventId}`
  }
}
