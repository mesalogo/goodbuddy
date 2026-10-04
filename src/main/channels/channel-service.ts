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
  isPermanentChannelError,
  type ChannelDriver,
  type ChannelExecutor,
  type DedupStore,
  type Outbox
} from './channel-driver'

export type ChannelServiceOptions = {
  allowedSenderIds?: readonly string[]
  allowGroupMessages?: boolean
  maximumConcurrency?: number
  maximumInputLength?: number
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
  private allowedSenderIds: ReadonlySet<string> = new Set()
  private readonly allowGroupMessages: boolean
  private readonly maximumConcurrency: number
  private readonly maximumInputLength: number
  private readonly dedupStore: DedupStore
  private readonly outbox: Outbox
  private readonly onDeliveryFailure?: (error: unknown) => void
  private readonly onDeliverySuccess?: () => void
  private readonly active = new Map<string, AbortController>()
  private readonly conversationTails = new Map<string, Promise<void>>()
  private state: ServiceState = 'idle'
  private stopPromise?: Promise<void>
  private readonly lifetime = new AbortController()
  private readonly sending = new Set<string>()
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryPromise?: Promise<void>
  private retryRequested = false
  private retryDelay = 1_000

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

    this.updateAllowedSenderIds(options.allowedSenderIds ?? [])
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
    this.dedupStore = options.dedupStore ?? new MemoryDedupStore()
    this.outbox = options.outbox ?? new MemoryOutbox()
    this.onDeliveryFailure = options.onDeliveryFailure
    this.onDeliverySuccess = options.onDeliverySuccess
  }

  updateAllowedSenderIds(senderIds: readonly string[]): void {
    const allowed = new Set(senderIds.map((senderId) => senderId.trim()))
    if (allowed.has('')) {
      throw new Error('通道白名单包含无效身份')
    }
    this.allowedSenderIds = allowed
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
        if (this.state !== 'running') {
          await acknowledge()
          return
        }

        try {
          this.enqueue(rawMessage)
          await acknowledge()
        } catch (error) {
          this.onDeliveryFailure?.(error)
        }
      })
      this.scheduleRetry(0)
    } catch (error) {
      if (!this.lifetime.signal.aborted) {
        this.state = 'idle'
      }
      throw error
    }
  }

  cancel(eventId: string): boolean {
    const suffix = `\u0000${eventId}`
    const controller = [...this.active.entries()].find(
      ([key]) =>
        key.startsWith(`${this.driver.channel}\u0000`) &&
        key.endsWith(suffix)
    )?.[1]
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
    this.lifetime.abort(new Error('通道服务已停止'))
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
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
      this.retryPromise,
      ...this.conversationTails.values()
    ])
    const driverResult = results[0]
    if (driverResult?.status === 'rejected') {
      throw driverResult.reason
    }
  }

  private scheduleRetry(delay = this.retryDelay): void {
    if (this.state !== 'running') {
      return
    }
    if (this.retryPromise) {
      this.retryRequested = true
      return
    }
    if (this.retryTimer) {
      return
    }
    const run = (): void => {
      this.retryTimer = undefined
      this.retryRequested = false
      this.retryPromise = this.retryUndelivered()
        .catch((error: unknown) => {
          if (!this.lifetime.signal.aborted) {
            this.onDeliveryFailure?.(error)
          }
        })
        .finally(() => {
          this.retryPromise = undefined
          if (this.retryRequested) {
            this.scheduleRetry()
          } else {
            this.retryDelay = 1_000
          }
        })
    }
    if (delay === 0) {
      run()
    } else {
      this.retryTimer = setTimeout(run, delay)
      this.retryTimer.unref?.()
    }
  }

  private async retryUndelivered(): Promise<void> {
    // Live sends may finish while this snapshot is read or earlier retries await I/O.
    const liveDeliveries = new Set(this.sending)
    const entries = (await this.outbox.listUndelivered(
      this.driver.channel,
      100
    )).filter((entry) => !liveDeliveries.has(entry.id) && !this.sending.has(entry.id))
    let consecutiveFailures = 0
    let failed = false
    for (const entry of entries) {
      if (this.state !== 'running') {
        return
      }
      if (entry.state === 'terminal' || entry.attempts >= 5) {
        this.onDeliveryFailure?.(
          new Error(
            entry.attempts >= 5
              ? `通道结果已达到重试上限，发件箱记录 ${entry.id} 已终止`
              : `通道结果无法投递，发件箱记录 ${entry.id} 已终止`
          )
        )
        continue
      }
      if (this.sending.has(entry.id)) {
        continue
      }
      try {
        await this.driver.send(
          entry.message,
          this.lifetime.signal
        )
        await this.outbox.markDelivered(entry.id)
        this.onDeliverySuccess?.()
        consecutiveFailures = 0
      } catch (error) {
        if (this.lifetime.signal.aborted) {
          return
        }
        await this.recordDeliveryFailure(entry.id, error)
        failed = true
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) {
          break
        }
      }
    }
    if (this.state === 'running') {
      const remaining = await this.outbox.listUndelivered(this.driver.channel, 100)
      this.retryRequested ||= remaining.some((entry) =>
        entry.state !== 'terminal' && entry.attempts < 5 && !this.sending.has(entry.id)
      )
      this.retryDelay = failed ? Math.min(this.retryDelay * 2, 30_000) : 1_000
    }
  }

  private async process(rawMessage: unknown): Promise<void> {
    if (this.state !== 'running') {
      return
    }
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
      message.accountId,
      message.eventId
    )
    if (!claimed) {
      return
    }

    let durableResult = false
    try {
      if (this.lifetime.signal.aborted || !this.allowedSenderIds.has(message.senderId)) {
        return
      }
      if (message.text.length > this.maximumInputLength) {
        durableResult = await this.tryDeliver(
          this.result(message, {
            status: 'rejected',
            error: `消息过长，最多允许 ${this.maximumInputLength} 个字符`
          }),
          this.lifetime.signal
        )
        return
      }

      if (this.active.size >= this.maximumConcurrency) {
        durableResult = await this.tryDeliver(
          this.result(message, {
            status: 'busy',
            error: '当前请求较多，请稍后重试'
          }),
          this.lifetime.signal
        )
        return
      }

      const key = this.activeKey(
        message.channel,
        message.accountId,
        message.eventId
      )
      const controller = new AbortController()
      this.active.set(key, controller)
      try {
        let rawResult: Awaited<ReturnType<ChannelExecutor>>
        try {
          rawResult = await this.execute(message, controller.signal)
        } catch {
          const cancelled = controller.signal.aborted
          durableResult = await this.tryDeliver(
            this.result(message, {
              status: cancelled ? 'cancelled' : 'failed',
              error: cancelled ? '请求已取消' : '请求处理失败'
            }),
            this.lifetime.signal
          )
          return
        }
        if (controller.signal.aborted) {
          durableResult = await this.tryDeliver(
            this.result(message, {
              status: 'cancelled',
              error: '请求已取消'
            }),
            this.lifetime.signal
          )
          return
        }

        const result = channelExecutorResultSchema.safeParse(rawResult)
        if (!result.success) {
          durableResult = await this.tryDeliver(
            this.result(message, {
              status: 'failed',
              error: '请求返回了无效结果'
            }),
            controller.signal
          )
          return
        }
        durableResult = await this.tryDeliver(
          this.result(message, result.data),
          controller.signal
        )
      } finally {
        this.active.delete(key)
      }
    } finally {
      if (!durableResult) {
        await this.dedupStore.release(
          message.channel,
          message.accountId,
          message.eventId
        )
      }
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
        .then(() => {
          signal.throwIfAborted()
          return this.executor(message, signal, reportProgress)
        })
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
            output: result.output
          }),
      ...(result.error === undefined
        ? {}
        : {
            error: redactChannelError(result.error).slice(
              0,
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
  ): Promise<boolean> {
    const entry = await this.outbox.enqueue(message)
    this.sending.add(entry.id)
    try {
      const deliverySignal = AbortSignal.any([signal, this.lifetime.signal])
      deliverySignal.throwIfAborted()
      await this.driver.send(message, deliverySignal)
      await this.outbox.markDelivered(entry.id)
      this.onDeliverySuccess?.()
    } catch (error) {
      if (!this.lifetime.signal.aborted) {
        await this.recordDeliveryFailure(entry.id, error)
        if (!isPermanentChannelError(error)) {
          this.scheduleRetry()
        }
      }
    } finally {
      this.sending.delete(entry.id)
    }
    return true
  }

  private async recordDeliveryFailure(id: string, error: unknown): Promise<void> {
    if (isPermanentChannelError(error) && this.outbox.markTerminal) {
      await this.outbox.markTerminal(id)
    } else {
      await this.outbox.markFailed(id)
    }
    this.onDeliveryFailure?.(error)
  }

  private async tryDeliver(
    message: ChannelResultMessage,
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      return await this.deliver(message, signal)
    } catch (error) {
      this.onDeliveryFailure?.(error)
      return false
    }
  }

  private activeKey(
    channel: string,
    accountId: string,
    eventId: string
  ): string {
    return `${channel}\u0000${accountId}\u0000${eventId}`
  }

  private enqueue(rawMessage: unknown): void {
    const parsed = channelInboundTextSchema.safeParse(rawMessage)
    if (!parsed.success) {
      throw new Error('通道消息格式无效')
    }
    if (parsed.data.channel !== this.driver.channel) {
      throw new Error('通道消息来源不匹配')
    }
    const key =
      `${parsed.data.channel}\u0000${parsed.data.accountId}` +
      `\u0000${parsed.data.conversationId}`
    const previous = this.conversationTails.get(key) ?? Promise.resolve()
    const task =
      this.conversationTails.has(key)
        ? previous
            .catch(() => undefined)
            .then(() => this.process(parsed.data))
        : this.process(parsed.data)
    const tail = task.then(
      () => undefined,
      () => undefined
    )
    this.conversationTails.set(key, tail)
    void tail.finally(() => {
      if (this.conversationTails.get(key) === tail) {
        this.conversationTails.delete(key)
      }
    })
    void task.catch(() => {
      // The event claim is released when no durable result could be recorded.
    })
  }
}
