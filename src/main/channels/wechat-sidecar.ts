import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  wechatSidecarCommandSchema,
  wechatSidecarStartAccountCommandSchema,
  type WechatSidecarCommand,
  type WechatSidecarCredentialMessage,
  type WechatSidecarMessage,
  type WechatSidecarStartAccountCommand
} from './wechat-sidecar-protocol'
import {
  isAllowedWechatUrl,
  redactWechatSidecarError
} from './wechat-sidecar-security'
import {
  downloadWechatFile,
  downloadWechatImage,
  uploadWechatAttachment
} from './wechat-media'
import { CHANNEL_LIMITS } from '../../shared/channel-contracts'

const QR_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_API_BASE_URL = QR_BASE_URL
const BOT_TYPE = '3'
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const MAX_REPLY_CONTEXTS = 1_000
const MAX_API_REDIRECTS = 3
const ILINK_CHANNEL_VERSION = '2.4.6'
const ILINK_CLIENT_VERSION = '132102'
const parentPort = process.parentPort

class RequestTimeoutError extends Error {}

type QrResponse = {
  qrcode?: string
  qrcode_img_content?: string
}

type QrStatusResponse = {
  status?:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect'
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  redirect_host?: string
}

type WeixinMessageItem = {
  type?: number
  text_item?: { text?: string }
  image_item?: {
    media?: {
      encrypt_query_param?: string
      aes_key?: string
      full_url?: string
    }
    aeskey?: string
    mid_size?: number
    hd_size?: number
  }
  file_item?: {
    media?: {
      encrypt_query_param?: string
      aes_key?: string
      full_url?: string
    }
    file_name?: string
    len?: string
  }
}

type WeixinMessage = {
  seq?: number
  message_id?: number
  from_user_id?: string
  create_time_ms?: number
  message_type?: number
  item_list?: WeixinMessageItem[]
  context_token?: string
}

type UpdatesResponse = {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

type ReplyContext = {
  recipientId: string
  contextToken?: string
}

const replyContexts = new Map<string, ReplyContext>()
const replyControllers = new Map<string, AbortController>()
let activeQr:
  | {
      qrcode: string
      pollingBaseUrl: string
      expiresAt: number
      verifyCode?: string
    }
  | undefined
let account: WechatSidecarStartAccountCommand | undefined
let lifecycleController = new AbortController()

function post(message: WechatSidecarMessage | WechatSidecarCredentialMessage): void {
  parentPort.postMessage(message)
}

function safeDetail(error: unknown): string {
  return redactWechatSidecarError(error)
}

function assertTencentUrl(raw: string): URL {
  if (!isAllowedWechatUrl(raw)) {
    throw new Error('微信服务返回了不受信任的地址')
  }
  const url = new URL(raw)
  return url
}

function normalizeBaseUrl(raw: string | undefined): string {
  return assertTencentUrl(raw?.trim() || DEFAULT_API_BASE_URL)
    .toString()
    .replace(/\/$/u, '')
}

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function commonHeaders(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

function baseInfo(): { channel_version: string; bot_agent: string } {
  return {
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: 'GoodBuddy/0.8.6'
  }
}

async function requestJson<T>(input: {
  baseUrl: string
  endpoint: string
  method: 'GET' | 'POST'
  token?: string
  body?: unknown
  timeoutMs: number
  signal?: AbortSignal
}): Promise<T> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const url = new URL(input.endpoint, `${baseUrl}/`)
  assertTencentUrl(url.toString())
  const timeoutController = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, input.timeoutMs)
  const abort = (): void => timeoutController.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) {
    abort()
  }
  try {
    try {
      const body =
        input.body === undefined
          ? undefined
          : JSON.stringify(input.body)
      let requestUrl = url
      for (
        let redirectCount = 0;
        redirectCount <= MAX_API_REDIRECTS;
        redirectCount += 1
      ) {
        const response = await fetch(requestUrl, {
          method: input.method,
          headers: commonHeaders(input.token),
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          signal: timeoutController.signal
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (
            !location ||
            redirectCount === MAX_API_REDIRECTS
          ) {
            throw new Error('微信服务重定向无效')
          }
          requestUrl = assertTencentUrl(
            new URL(location, requestUrl).toString()
          )
          continue
        }
        const text = await response.text()
        if (!response.ok) {
          throw new Error(
            `微信服务请求失败（${response.status}）`
          )
        }
        return JSON.parse(text) as T
      }
      throw new Error('微信服务重定向过多')
    } catch (error) {
      if (timedOut) {
        throw new RequestTimeoutError('微信请求等待超时')
      }
      throw error
    }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abort)
  }
}

async function startLogin(): Promise<void> {
  lifecycleController.abort()
  lifecycleController = new AbortController()
  activeQr = undefined
  post({ type: 'status', status: 'starting' })
  try {
    const result = await requestJson<QrResponse>({
      baseUrl: QR_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      method: 'POST',
      body: { local_token_list: [] },
      timeoutMs: API_TIMEOUT_MS,
      signal: lifecycleController.signal
    })
    if (!result.qrcode || !result.qrcode_img_content) {
      throw new Error('微信服务未返回有效二维码')
    }
    activeQr = {
      qrcode: result.qrcode,
      pollingBaseUrl: QR_BASE_URL,
      expiresAt: Date.now() + 5 * 60_000
    }
    const expiresAt = new Date(activeQr.expiresAt).toISOString()
    post({ type: 'status', status: 'pending' })
    post({
      type: 'qr',
      qrId: randomUUID(),
      payload: result.qrcode_img_content,
      expiresAt
    })
    void pollQr(lifecycleController.signal)
  } catch (error) {
    if (!lifecycleController.signal.aborted) {
      post({
        type: 'status',
        status: 'failed',
        detail: safeDetail(error)
      })
    }
  }
}

async function pollQr(signal: AbortSignal): Promise<void> {
  while (!signal.aborted && activeQr) {
    const current = activeQr
    if (Date.now() >= current.expiresAt) {
      post({ type: 'status', status: 'expired' })
      activeQr = undefined
      return
    }
    try {
      let endpoint =
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(current.qrcode)}`
      if (current.verifyCode) {
        endpoint += `&verify_code=${encodeURIComponent(current.verifyCode)}`
      }
      const status = await requestJson<QrStatusResponse>({
        baseUrl: current.pollingBaseUrl,
        endpoint,
        method: 'GET',
        timeoutMs: LONG_POLL_TIMEOUT_MS,
        signal
      })
      if (signal.aborted || !activeQr) {
        return
      }
      switch (status.status) {
        case 'wait':
        case undefined:
          break
        case 'scaned':
          activeQr.verifyCode = undefined
          post({ type: 'status', status: 'scanned' })
          break
        case 'need_verifycode':
          post({ type: 'status', status: 'verification_required' })
          post({
            type: 'verification_required',
            prompt: activeQr.verifyCode
              ? '数字不匹配，请重新输入手机微信显示的数字'
              : '请输入手机微信显示的数字'
          })
          return
        case 'verify_code_blocked':
          post({
            type: 'status',
            status: 'failed',
            detail: '验证码错误次数过多，请重新扫码'
          })
          activeQr = undefined
          return
        case 'expired':
          post({ type: 'status', status: 'expired' })
          activeQr = undefined
          return
        case 'scaned_but_redirect':
          if (!status.redirect_host) {
            throw new Error('微信扫码重定向地址缺失')
          }
          activeQr.pollingBaseUrl = normalizeBaseUrl(
            `https://${status.redirect_host}`
          )
          break
        case 'binded_redirect':
          post({
            type: 'status',
            status: 'failed',
            detail: '此微信已绑定，但本地凭据不可用，请先在微信中解除旧连接'
          })
          activeQr = undefined
          return
        case 'confirmed': {
          if (
            !status.bot_token ||
            !status.ilink_bot_id ||
            !status.ilink_user_id
          ) {
            throw new Error('微信确认结果缺少账号凭据')
          }
          const baseUrl = normalizeBaseUrl(status.baseurl)
          const credential: WechatSidecarCredentialMessage = {
            type: 'credential',
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
            baseUrl,
            token: status.bot_token
          }
          post(credential)
          post({
            type: 'connected',
            accountId: credential.accountId,
            userId: credential.userId
          })
          post({ type: 'status', status: 'connected' })
          activeQr = undefined
          return
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return
      }
      if (error instanceof RequestTimeoutError) {
        continue
      }
      await sleep(2_000, signal)
    }
  }
}

function submitVerification(code: string): void {
  if (!activeQr) {
    post({
      type: 'status',
      status: 'failed',
      detail: '当前没有等待验证的微信扫码'
    })
    return
  }
  activeQr.verifyCode = code
  post({ type: 'status', status: 'scanned' })
  void pollQr(lifecycleController.signal)
}

async function startAccount(
  command: WechatSidecarStartAccountCommand
): Promise<void> {
  lifecycleController.abort()
  lifecycleController = new AbortController()
  account = {
    ...command,
    baseUrl: normalizeBaseUrl(command.baseUrl)
  }
  post({ type: 'status', status: 'starting' })
  try {
    await notifyLifecycle('notifystart')
  } catch {
    // Connection notification is advisory; polling remains authoritative.
  }
  post({
    type: 'connected',
    accountId: account.accountId,
    userId: account.userId
  })
  post({ type: 'status', status: 'connected' })
  void pollMessages(lifecycleController.signal)
}

async function pollMessages(signal: AbortSignal): Promise<void> {
  let cursor = ''
  let timeoutMs = LONG_POLL_TIMEOUT_MS
  let failures = 0
  while (!signal.aborted && account) {
    try {
      const result = await requestJson<UpdatesResponse>({
        baseUrl: account.baseUrl,
        endpoint: 'ilink/bot/getupdates',
        method: 'POST',
        token: account.token,
        body: {
          get_updates_buf: cursor,
          base_info: baseInfo()
        },
        timeoutMs,
        signal
      })
      if (signal.aborted) {
        return
      }
      if (
        (result.ret !== undefined && result.ret !== 0) ||
        (result.errcode !== undefined && result.errcode !== 0)
      ) {
        throw new Error('微信消息轮询失败')
      }
      failures = 0
      if (result.get_updates_buf) {
        cursor = result.get_updates_buf
      }
      if (
        result.longpolling_timeout_ms &&
        result.longpolling_timeout_ms > 0
      ) {
        timeoutMs = Math.min(result.longpolling_timeout_ms, 60_000)
      }
      for (const message of result.msgs ?? []) {
        await handleInboundMessage(message, signal)
      }
    } catch (error) {
      if (signal.aborted) {
        return
      }
      if (error instanceof RequestTimeoutError) {
        continue
      }
      failures += 1
      if (failures >= 3) {
        post({
          type: 'status',
          status: 'failed',
          detail: safeDetail(error)
        })
        failures = 0
        await sleep(30_000, signal)
        continue
      }
      await sleep(2_000, signal)
    }
  }
}

async function handleInboundMessage(
  message: WeixinMessage,
  signal: AbortSignal
): Promise<void> {
  if (message.message_type !== undefined && message.message_type !== 1) {
    return
  }
  const senderId = message.from_user_id?.trim()
  const text = message.item_list
    ?.find((item) => item.type === 1)
    ?.text_item?.text?.trim() ?? ''
  const mediaItems = (message.item_list ?? [])
    .filter((item) => item.type === 2 || item.type === 4)
    .slice(0, CHANNEL_LIMITS.maximumAttachmentCount)
  if (!senderId || (!text && mediaItems.length === 0)) {
    return
  }
  const eventId = stableEventId(
    message,
    senderId,
    text || `media:${mediaItems.length}`
  )
  replyContexts.set(eventId, {
    recipientId: senderId,
    ...(message.context_token
      ? { contextToken: message.context_token }
      : {})
  })
  while (replyContexts.size > MAX_REPLY_CONTEXTS) {
    const oldest = replyContexts.keys().next().value
    if (oldest === undefined) {
      break
    }
    replyContexts.delete(oldest)
  }
  const results = await Promise.all(
    mediaItems.map(async (item, index) => {
      try {
        if (item.type === 2 && item.image_item) {
          return {
            attachment: await downloadWechatImage(
              item.image_item,
              `微信图片-${message.message_id ?? message.seq ?? index + 1}`,
              signal
            )
          }
        }
        if (item.type === 4 && item.file_item) {
          return {
            attachment: await downloadWechatFile(
              item.file_item,
              signal
            )
          }
        }
        return {}
      } catch (error) {
        return { error: safeDetail(error) }
      }
    })
  )
  const attachments = []
  let attachmentError: string | undefined
  for (const result of results) {
    attachmentError ??= result.error
    if (!result.attachment) {
      continue
    }
    const total = attachments.reduce(
      (sum, candidate) => sum + candidate.size,
      0
    )
    if (
      total + result.attachment.size >
      CHANNEL_LIMITS.maximumAttachmentBytes
    ) {
      attachmentError = '微信附件总大小超过 12MB 限制'
      break
    }
    attachments.push(result.attachment)
  }
  post({
    type: 'inbound_message',
    eventId,
    senderId,
    conversationId: senderId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(attachmentError ? { attachmentError } : {})
  })
}

function stableEventId(
  message: WeixinMessage,
  senderId: string,
  text: string
): string {
  if (message.message_id !== undefined) {
    return `message-${message.message_id}`
  }
  if (message.seq !== undefined) {
    return `sequence-${message.seq}`
  }
  return `digest-${createHash('sha256')
    .update(
      `${senderId}\u0000${message.create_time_ms ?? 0}\u0000${text}`,
      'utf8'
    )
    .digest('hex')}`
}

async function sendReply(
  command: Extract<WechatSidecarCommand, { type: 'reply' }>
): Promise<void> {
  const currentAccount = account
  const context = replyContexts.get(command.inReplyToEventId)
  if (!currentAccount || !context) {
    post({
      type: 'reply_result',
      replyId: command.replyId,
      ok: false,
      error: '微信回复上下文已失效'
    })
    return
  }
  const controller = new AbortController()
  const lifecycleSignal = lifecycleController.signal
  const abortFromLifecycle = (): void =>
    controller.abort(lifecycleSignal.reason)
  lifecycleSignal.addEventListener(
    'abort',
    abortFromLifecycle,
    { once: true }
  )
  if (lifecycleSignal.aborted) {
    abortFromLifecycle()
  }
  replyControllers.set(command.replyId, controller)
  try {
    const items: Array<{
      item: WeixinMessageItem
      stableKey: string
    }> = [
      {
        item: {
          type: 1,
          text_item: { text: command.text }
        },
        stableKey: `text\u0000${command.text}`
      }
    ]
    for (const [index, attachment] of (
      command.attachments ?? []
    ).entries()) {
      items.push(
        {
          item: await uploadWechatAttachment({
            attachment,
            recipientId: context.recipientId,
            signal: controller.signal,
            getUploadUrl: (request) =>
              requestJson({
                baseUrl: currentAccount.baseUrl,
                endpoint: 'ilink/bot/getuploadurl',
                method: 'POST',
                token: currentAccount.token,
                body: {
                  ...request,
                  base_info: baseInfo()
                },
                timeoutMs: API_TIMEOUT_MS,
                signal: controller.signal
              })
          }),
          stableKey: `attachment\u0000${index}\u0000${attachment.kind}\u0000${createHash(
            'sha256'
          )
            .update(attachment.dataBase64, 'ascii')
            .digest('hex')}`
        }
      )
    }
    for (const [index, entry] of items.entries()) {
      const clientId = `goodbuddy-${createHash('sha256')
        .update(
          `${command.inReplyToEventId}\u0000${index}\u0000${entry.stableKey}`
        )
        .digest('hex')
        .slice(0, 32)}`
      const response = await requestJson<{
        ret?: number
        errmsg?: string
      }>({
        baseUrl: currentAccount.baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        method: 'POST',
        token: currentAccount.token,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: context.recipientId,
            client_id: clientId,
            context_token: context.contextToken,
            message_type: 2,
            message_state: 2,
            item_list: [entry.item]
          },
          base_info: baseInfo()
        },
        timeoutMs: API_TIMEOUT_MS,
        signal: controller.signal
      })
      if (response.ret !== undefined && response.ret !== 0) {
        throw new Error(response.errmsg || '微信消息发送失败')
      }
    }
    post({ type: 'reply_result', replyId: command.replyId, ok: true })
  } catch (error) {
    post({
      type: 'reply_result',
      replyId: command.replyId,
      ok: false,
      error: safeDetail(error)
    })
  } finally {
    lifecycleSignal.removeEventListener(
      'abort',
      abortFromLifecycle
    )
    replyControllers.delete(command.replyId)
  }
}

function cancelReply(replyId: string): void {
  replyControllers
    .get(replyId)
    ?.abort(new Error('微信回复已取消'))
}

async function notifyLifecycle(
  endpoint: 'notifystart' | 'notifystop'
): Promise<void> {
  if (!account) {
    return
  }
  await requestJson({
    baseUrl: account.baseUrl,
    endpoint: `ilink/bot/msg/${endpoint}`,
    method: 'POST',
    token: account.token,
    body: { base_info: baseInfo() },
    timeoutMs: 10_000
  })
}

async function disconnect(): Promise<void> {
  lifecycleController.abort()
  try {
    await notifyLifecycle('notifystop')
  } catch {
    // Best effort during local disconnect and shutdown.
  }
  activeQr = undefined
  account = undefined
  replyContexts.clear()
  replyControllers.clear()
  post({ type: 'status', status: 'stopped' })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timeout = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) {
      finish()
    }
  })
}

parentPort.on('message', (event) => {
  const startAccountCommand =
    wechatSidecarStartAccountCommandSchema.safeParse(event.data)
  if (startAccountCommand.success) {
    void startAccount(startAccountCommand.data)
    return
  }
  const command = wechatSidecarCommandSchema.safeParse(event.data)
  if (!command.success) {
    post({
      type: 'status',
      status: 'failed',
      detail: '微信 Sidecar 收到无效命令'
    })
    return
  }
  switch (command.data.type) {
    case 'start_login':
      void startLogin()
      break
    case 'submit_verification':
      submitVerification(command.data.code)
      break
    case 'reply':
      void sendReply(command.data)
      break
    case 'cancel_reply':
      cancelReply(command.data.replyId)
      break
    case 'disconnect':
      void disconnect()
      break
    case 'shutdown':
      void disconnect().finally(() => process.exit(0))
      break
  }
})

post({ type: 'status', status: 'stopped' })
