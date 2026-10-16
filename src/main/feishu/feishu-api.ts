import type { FeishuDomain } from '../../shared/channel-settings-contracts'

export type FeishuCredentials = { appId: string; appSecret: string; domain: FeishuDomain }

export type FeishuFetch = (input: string, init?: RequestInit) => Promise<Response>

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

export function feishuOpenBaseUrl(domain: FeishuDomain): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

export class FeishuApiError extends Error {
  constructor(message: string, readonly code?: number, readonly permanent = false) {
    super(message)
  }
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new FeishuApiError('飞书响应过大')
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new FeishuApiError('飞书响应过大')
  return text
}

/**
 * Minimal Feishu Open API client with tenant token caching. Responses are
 * bounded; secrets never appear in thrown messages.
 */
export class FeishuApi {
  private token?: { value: string; expiresAt: number }
  private tokenRequest?: Promise<string>

  constructor(
    private readonly credentials: FeishuCredentials,
    private readonly fetchImpl: FeishuFetch = (input, init) => fetch(input, init)
  ) {}

  get baseUrl(): string { return feishuOpenBaseUrl(this.credentials.domain) }

  private async rawJson(path: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    const text = await readBounded(response)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new FeishuApiError(`飞书接口返回了非 JSON 响应（HTTP ${response.status}）`)
    }
    if (!body || typeof body !== 'object') throw new FeishuApiError('飞书接口返回了无效响应')
    return body as Record<string, unknown>
  }

  async tenantAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    this.tokenRequest ??= (async () => {
      const body = await this.rawJson('/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.credentials.appId, app_secret: this.credentials.appSecret })
      }, signal)
      const code = typeof body.code === 'number' ? body.code : -1
      const token = body.tenant_access_token
      if (code !== 0 || typeof token !== 'string' || !token) {
        throw new FeishuApiError(`飞书凭据验证失败：${typeof body.msg === 'string' ? body.msg : `code ${code}`}`, code, true)
      }
      const expire = typeof body.expire === 'number' ? body.expire : 7200
      this.token = { value: token, expiresAt: Date.now() + expire * 1000 }
      return token
    })().finally(() => { this.tokenRequest = undefined })
    return this.tokenRequest
  }

  /** Calls an Open API path with the tenant token; throws on non-zero `code`. */
  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; signal?: AbortSignal } = {}
  ): Promise<T> {
    const token = await this.tenantAccessToken(options.signal)
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') query.set(key, String(value))
    }
    const suffix = query.size ? `?${query.toString()}` : ''
    const body = await this.rawJson(`${path}${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    }, options.signal)
    const code = typeof body.code === 'number' ? body.code : -1
    if (code !== 0) {
      if (code === 99991663 || code === 99991664) this.token = undefined
      throw new FeishuApiError(`飞书接口错误 ${code}：${typeof body.msg === 'string' ? body.msg.slice(0, 300) : '未知错误'}`, code)
    }
    return (body.data ?? {}) as T
  }

  /** Bot identity; verifies credentials and that the bot capability is enabled. */
  async botInfo(signal?: AbortSignal): Promise<{ openId?: string; name?: string }> {
    const token = await this.tenantAccessToken(signal)
    const body = await this.rawJson('/open-apis/bot/v3/info', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` }
    }, signal)
    if (body.code !== 0) {
      throw new FeishuApiError(`飞书应用未开启机器人能力或无权读取机器人信息：${typeof body.msg === 'string' ? body.msg : ''}`, Number(body.code))
    }
    const bot = (body.bot ?? {}) as Record<string, unknown>
    return {
      ...(typeof bot.open_id === 'string' ? { openId: bot.open_id } : {}),
      ...(typeof bot.app_name === 'string' ? { name: bot.app_name } : {})
    }
  }
}
