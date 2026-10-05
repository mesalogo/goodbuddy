import { setTimeout as delay } from 'node:timers/promises'
import type { ChannelInboundText, ChannelResultMessage } from '../../shared/channel-contracts'
import type { ChannelRuntimeStatus } from '../../shared/channel-settings-contracts'
import type { ChannelDriver, ChannelInboundHandler } from './channel-driver'
import { redactChannelError } from './channel-service'

export type TelegramChannelDriverOptions = {
  secret: string
  allowedSenderIds: readonly string[]
  fetch?: typeof globalThis.fetch
  onStatus?: (status: ChannelRuntimeStatus) => void
}

type BotIdentity = { botId: string; botUsername?: string }
type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    date: number
    from?: { id: number; is_bot?: boolean }
    chat: { id: number; type: string }
    text?: string
    message_thread_id?: number
    is_topic_message?: boolean
    [key: string]: unknown
  }
}

export class TelegramError extends Error {
  constructor(readonly code: number, readonly retryAfter = 1) {
    super(code === 401 ? 'Telegram Token is invalid. Replace the Bot Token.'
      : code === 409 ? 'Telegram polling conflict. Stop the other poller or remove the existing webhook.'
        : code === 403 ? 'Telegram access forbidden. The Bot may be blocked or disabled.'
          : code === 429 ? 'Telegram rate limit. Waiting before retrying.'
            : code === 0 ? 'Telegram network request failed. Check the network and OS proxy.'
              : `Telegram request failed (HTTP ${code}).`)
  }

  get permanent(): boolean {
    return this.code >= 400 && this.code < 500 && this.code !== 429
  }

  get terminal(): boolean {
    return this.permanent
  }
}

function cancelled(): Error {
  const error = new Error('Telegram operation cancelled.')
  error.name = 'AbortError'
  return error
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal })
  } catch {
    throw cancelled()
  }
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export class TelegramChannelDriver implements ChannelDriver {
  readonly channel = 'telegram'
  private allowed: ReadonlySet<string> = new Set()
  private readonly fetchImpl: typeof globalThis.fetch
  private lifecycle = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly feedback = new Map<string, number>()
  private readonly progress = new Map<string, { offset: number; terminal?: TelegramError }>()
  private identity?: BotIdentity
  private terminalFailure?: TelegramError
  private readonly readinessWaiters = new Set<() => void>()
  private offset = 0
  private pollPromise?: Promise<void>
  private stopPromise?: Promise<void>
  private lastStatus?: string

  constructor(private readonly options: TelegramChannelDriverOptions) {
    if (!options.secret.trim() || /[\s/?#]/u.test(options.secret)) {
      throw new Error('Telegram Bot Token is invalid.')
    }
    this.updateAllowedSenderIds(options.allowedSenderIds)
    this.fetchImpl = options.fetch ?? (async (input, init) => {
      const { net } = await import('electron')
      return net.fetch(input instanceof Request ? input.url : String(input), init)
    })
  }

  testConnection(): Promise<BotIdentity> {
    return this.track((async () => {
      const identity = await this.identify(this.lifecycle.signal)
      await this.checkWebhook(this.lifecycle.signal)
      return identity
    })())
  }

  updateAllowedSenderIds(ids: readonly string[]): void {
    if (ids.some((id) => !/^[1-9]\d*$/u.test(id))) {
      throw new Error('Telegram whitelist must contain numeric user IDs.')
    }
    this.allowed = new Set(ids)
  }

  start(handler: ChannelInboundHandler): Promise<void> {
    if (this.stopPromise) return Promise.reject(new Error('Telegram driver has stopped. Create a new driver to restart.'))
    if (this.pollPromise) return Promise.resolve()
    this.status({ state: 'starting' })
    this.pollPromise = this.poll(handler, this.lifecycle.signal)
    return Promise.resolve()
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.lifecycle.abort()
    this.stopPromise = (async () => {
      await Promise.allSettled([...this.operations, this.pollPromise])
      this.feedback.clear()
      this.progress.clear()
      this.status({ state: 'stopped' })
    })()
    return this.stopPromise
  }

  send(message: ChannelResultMessage, signal: AbortSignal): Promise<void> {
    return this.track(this.sendResult(message, AbortSignal.any([signal, this.lifecycle.signal])))
  }

  private async sendResult(message: ChannelResultMessage, signal: AbortSignal): Promise<void> {
    checkSignal(signal)
    await this.waitForIdentity(signal)
    const match = /^([1-9]\d*):([1-9]\d*)$/u.exec(message.conversationId)
    if (!this.identity || message.channel !== this.channel || !match ||
      match[1] !== this.identity.botId || match[2] !== message.recipientId) {
      throw Object.assign(new Error('Telegram reply belongs to another Bot or has an invalid private conversation.'), { permanent: true, terminal: true })
    }
    const text = this.redact([
      message.output?.trim(), message.error?.trim(),
      message.attachments?.length ? 'Attachments are available in GoodBuddy on the desktop; no attachments were sent to Telegram.' : undefined
    ].filter(Boolean).join('\n\n') || 'Request completed.')
    const key = `${message.conversationId}:${message.eventId}:${message.status}`
    let record = this.progress.get(key)
    if (!record) {
      record = { offset: 0 }
      this.progress.set(key, record)
      if (this.progress.size > 128) this.progress.delete(this.progress.keys().next().value!)
    }
    if (record.terminal) throw record.terminal
    while (record.offset < text.length) {
      let end = Math.min(record.offset + 4096, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/u.test(text.charAt(end))) end -= 1
      try {
        await this.request('sendMessage', { chat_id: match[2], text: text.slice(record.offset, end) }, signal, true)
        record.offset = end
      } catch (error) {
        if (error instanceof TelegramError && error.permanent) record.terminal = error
        throw error
      }
    }
    this.progress.delete(key)
  }

  private async waitForIdentity(signal: AbortSignal): Promise<void> {
    checkSignal(signal)
    if (!this.identity && !this.terminalFailure) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          this.readinessWaiters.delete(finish)
          signal.removeEventListener('abort', finish)
          if (signal.aborted) reject(cancelled())
          else resolve()
        }
        this.readinessWaiters.add(finish)
        signal.addEventListener('abort', finish, { once: true })
      })
    }
    checkSignal(signal)
    // A polling conflict does not prevent an identified Bot from sending replies.
    if (this.terminalFailure && !(this.identity && this.terminalFailure.code === 409)) {
      throw this.terminalFailure
    }
  }

  private async identify(signal: AbortSignal): Promise<BotIdentity> {
    const me = await this.request<{ id: number; is_bot: boolean; username?: string }>('getMe', {}, signal)
    if (!positiveId(me?.id) || me.is_bot !== true) throw new Error('Telegram returned an invalid Bot identity.')
    return { botId: String(me.id), ...(me.username ? { botUsername: me.username } : {}) }
  }

  private async checkWebhook(signal: AbortSignal): Promise<void> {
    const webhook = await this.request<{ url: string }>('getWebhookInfo', {}, signal)
    if (typeof webhook?.url !== 'string') throw new Error('Telegram returned invalid webhook information.')
    if (webhook.url) throw new TelegramError(409)
  }

  private async poll(handler: ChannelInboundHandler, signal: AbortSignal): Promise<void> {
    let failures = 0
    let pollingReady = false
    while (!signal.aborted) {
      const started = Date.now()
      try {
        if (!this.identity) {
          // Outgoing replies need the Bot identity, not permission to long-poll.
          this.identity = await this.identify(signal)
          checkSignal(signal)
        }
        if (!pollingReady) {
          await this.checkWebhook(signal)
          pollingReady = true
          for (const notify of this.readinessWaiters) notify()
          failures = 0
          this.status({ state: 'running' })
        }
        const updates = await this.request<TelegramUpdate[]>('getUpdates', {
          offset: this.offset, timeout: 30, limit: 100, allowed_updates: ['message']
        }, signal)
        if (!Array.isArray(updates)) throw new TelegramError(0)
        for (const update of updates) {
          checkSignal(signal)
          if (!Number.isSafeInteger(update.update_id) || update.update_id < this.offset) continue
          let acknowledged = false
          await this.receive(update, handler, () => { acknowledged = true }, signal)
          checkSignal(signal)
          if (!acknowledged) throw new Error('Telegram inbound message was not acknowledged.')
          this.offset = update.update_id + 1
        }
        failures = 0
        this.status({ state: 'running' })
        // A server/proxy returning immediately must not turn long polling into a busy loop.
        await wait(Math.max(0, 250 - (Date.now() - started)), signal)
      } catch (error) {
        if (signal.aborted) break
        const safe = this.safeError(error)
        if (safe instanceof TelegramError && safe.permanent) {
          this.terminalFailure = safe
          for (const notify of this.readinessWaiters) notify()
          this.status({ state: 'error', lastError: safe.message })
          break
        }
        this.status({ state: 'starting', lastError: `${safe.message} Reconnecting.` })
        const pause = safe instanceof TelegramError && safe.code === 429
          ? safe.retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5))
        try { await wait(pause, signal) } catch { break }
      }
    }
  }

  private async receive(update: TelegramUpdate, handler: ChannelInboundHandler, acknowledge: () => void, signal: AbortSignal): Promise<void> {
    const message = update.message
    if (!message || message.chat?.type !== 'private' || !positiveId(message.chat.id) ||
      !positiveId(message.from?.id) || message.from.is_bot !== false ||
      message.message_thread_id !== undefined || message.is_topic_message) {
      acknowledge()
      return
    }
    const senderId = String(message.from.id)
    const media = ['caption', 'photo', 'video', 'animation', 'audio', 'voice', 'document', 'sticker', 'video_note', 'contact', 'location', 'venue', 'poll', 'dice', 'paid_media'].some((key) => message[key] !== undefined)
    const text = typeof message.text === 'string' && !media ? message.text.trim() : ''
    const command = /^\/(start|whoami)(?:@([^\s]+))?(?:\s|$)/u.exec(text)
    const help = command && (!command[2] || command[2].toLowerCase() === this.identity?.botUsername?.toLowerCase())
    if (help || (media && this.allowed.has(senderId))) {
      const now = Date.now()
      const feedbackKey = `${senderId}:${help ? command[1] : 'media'}`
      if (now - (this.feedback.get(feedbackKey) ?? -Infinity) >= 5000) {
        this.feedback.delete(feedbackKey)
        this.feedback.set(feedbackKey, now)
        if (this.feedback.size > 128) this.feedback.delete(this.feedback.keys().next().value!)
        const reply = help ? command[1] === 'whoami' ? senderId
          : 'GoodBuddy accepts private text requests from authorized users. Send /whoami and add your numeric ID to the desktop whitelist. Offline messages retained by Telegram may run when reconnected. After a crash, check desktop task records and results before resending; tasks do not automatically resume.'
          : 'Only text messages are supported. Please describe your request in text.'
        try {
          await this.request('sendMessage', { chat_id: String(message.chat.id), text: reply }, signal)
        } catch (error) {
          if (signal.aborted) throw error
          this.status({ state: 'running', lastError: this.safeError(error).message })
        }
      }
      acknowledge()
      return
    }
    if (!text || !this.allowed.has(senderId) || !Number.isSafeInteger(message.date) || message.date < 0) {
      acknowledge()
      return
    }
    const inbound: ChannelInboundText = {
      channel: this.channel, accountId: this.identity!.botId,
      eventId: String(update.update_id), senderId,
      conversationId: `${this.identity!.botId}:${message.chat.id}`,
      conversationType: 'direct', text, mentioned: false, receivedAt: message.date * 1000
    }
    await handler(inbound, acknowledge)
    checkSignal(signal)
    // Help commands have separate cooldowns so /start does not suppress /whoami.
    const typingKey = `${senderId}:typing`
    if (Date.now() - (this.feedback.get(typingKey) ?? -Infinity) >= 5000) {
      this.feedback.delete(typingKey)
      this.feedback.set(typingKey, Date.now())
      if (this.feedback.size > 128) this.feedback.delete(this.feedback.keys().next().value!)
      try { await this.request('sendChatAction', { chat_id: String(message.chat.id), action: 'typing' }, signal) } catch { /* Feedback must not reject an already queued request. */ }
    }
  }

  private async request<T = unknown>(method: string, body: object, signal: AbortSignal, retryRateLimit = false): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      checkSignal(signal)
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), method === 'getUpdates' ? 40_000 : 15_000)
      let failure: TelegramError
      try {
        const response = await this.fetchImpl(`https://api.telegram.org/bot${this.options.secret}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          redirect: 'error', signal: AbortSignal.any([signal, timeout.signal])
        })
        const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } }
        checkSignal(signal)
        if (response.ok && data.ok === true) return data.result as T
        const code = response.ok ? (Number.isSafeInteger(data.error_code) ? data.error_code! : 0) : response.status
        const seconds = data.parameters?.retry_after
        failure = new TelegramError(code, typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 86400)) : 1)
      } catch (error) {
        if (signal.aborted) throw cancelled()
        failure = error instanceof TelegramError ? error : new TelegramError(0)
      } finally {
        clearTimeout(timer)
      }
      if (failure.code !== 429 || !retryRateLimit) throw failure
      // The outbox may retry as soon as this call rejects, including the final attempt.
      await wait(failure.retryAfter * 1000, signal)
      if (attempt >= 3) throw failure
    }
  }

  private redact(value: string): string {
    return redactChannelError(value
      .replace(/https?:\/\/api\.telegram\.org\/[^\s"'<>]+/giu, '[Telegram URL hidden]')
      .split(this.options.secret).join('[Token hidden]'))
  }

  private safeError(error: unknown): Error {
    return error instanceof TelegramError ? error : new Error('Telegram operation failed. Check the connection and inbound queue.')
  }

  private status(status: ChannelRuntimeStatus): void {
    const key = JSON.stringify(status)
    if (key === this.lastStatus) return
    this.lastStatus = key
    this.options.onStatus?.(status)
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.operations.add(promise)
    void promise.finally(() => this.operations.delete(promise)).catch(() => undefined)
    return promise
  }
}
