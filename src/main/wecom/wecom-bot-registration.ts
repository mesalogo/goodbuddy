/**
 * Scan-to-create for a WeCom API-mode smart bot, done by GoodBuddy instead of
 * `wecom-cli auth init`. The CLI keeps the resulting secret encrypted in its
 * own store, so the message channel could not reuse it. Calling the same
 * endpoints here returns the Bot ID and Secret once, which GoodBuddy then
 * saves for the channel and passes to `wecom-cli auth init --bot-id --secret`.
 *
 * The endpoints are the ones the bundled wecom-cli 1.3.4 uses
 * (`/ai/qc/generate`, `/ai/qc/query_result`); they have no public
 * documentation and may change, so manual entry always stays available.
 */

const ORIGIN = 'https://work.weixin.qq.com'
const SOURCE = 'wecom_cli_external'
const POLL_INTERVAL_MS = 2_000
export const WECOM_BOT_REGISTRATION_TIMEOUT_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 15_000

export type WecomFetch = (input: string, init?: RequestInit) => Promise<Response>

export type WecomBotRegistrationSession = {
  scode: string
  /** Payload the WeCom app scans. */
  url: string
  /** Browser page that renders the same code. */
  webUrl: string
}

export type WecomRegisteredBot = { botId: string; secret: string }

export type WecomBotRegistrationOutcome =
  | { status: 'success'; bot: WecomRegisteredBot }
  | { status: 'expired' }
  | { status: 'failed'; message: string }

function platformCode(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
}

async function getJson(fetchImpl: WecomFetch, url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw new Error(`企业微信扫码接口返回 HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (!body || typeof body !== 'object') throw new Error('企业微信扫码接口返回了无法识别的结果')
  const record = body as Record<string, unknown>
  if (typeof record.errcode === 'number' && record.errcode !== 0) {
    throw new Error(typeof record.errmsg === 'string' && record.errmsg ? record.errmsg.slice(0, 300) : `企业微信扫码接口错误 ${record.errcode}`)
  }
  return record
}

const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export async function beginWecomBotRegistration(
  fetchImpl: WecomFetch,
  platform: NodeJS.Platform,
  signal?: AbortSignal
): Promise<WecomBotRegistrationSession> {
  const body = await getJson(fetchImpl, `${ORIGIN}/ai/qc/generate?source=${SOURCE}&plat=${platformCode(platform)}`, signal)
  const data = (body.data ?? {}) as Record<string, unknown>
  const scode = string(data.scode)
  if (!scode || !/^[\w-]{4,128}$/u.test(scode)) throw new Error('企业微信没有返回扫码会话')
  const authUrl = string(data.auth_url)
  // Only accept a WeCom scan URL; otherwise build the one the CLI's terminal code encodes.
  const url = authUrl && authUrl.startsWith(`${ORIGIN}/ai/qc/`)
    ? authUrl
    : `${ORIGIN}/ai/qc/c?s=${encodeURIComponent(scode)}&hide_more_btn=true&for_native=true`
  return { scode, url, webUrl: `${ORIGIN}/ai/qc/gen?source=${SOURCE}&scode=${encodeURIComponent(scode)}` }
}

/** Reads the bot from a query result; tolerant of `botid`/`bot_id`. */
export function registeredBotFromQuery(body: Record<string, unknown>): WecomRegisteredBot | undefined {
  const data = (body.data ?? {}) as Record<string, unknown>
  const info = (data.bot_info ?? {}) as Record<string, unknown>
  const botId = string(info.botid) ?? string(info.bot_id)
  const secret = string(info.secret)
  return botId && secret ? { botId, secret } : undefined
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

export async function pollWecomBotRegistration(input: {
  fetch: WecomFetch
  scode: string
  signal: AbortSignal
  timeoutMs?: number
  intervalMs?: number
}): Promise<WecomBotRegistrationOutcome> {
  const deadline = Date.now() + (input.timeoutMs ?? WECOM_BOT_REGISTRATION_TIMEOUT_MS)
  while (Date.now() < deadline) {
    input.signal.throwIfAborted()
    let body: Record<string, unknown> | undefined
    try {
      body = await getJson(input.fetch, `${ORIGIN}/ai/qc/query_result?scode=${encodeURIComponent(input.scode)}`, input.signal)
    } catch (error) {
      if (input.signal.aborted) throw error
      // Transient network errors: keep polling until the code expires.
      body = undefined
    }
    if (body) {
      const bot = registeredBotFromQuery(body)
      if (bot) return { status: 'success', bot }
      const status = string(((body.data ?? {}) as Record<string, unknown>).status)?.toLowerCase()
      if (status && /expire|timeout|invalid/u.test(status)) return { status: 'expired' }
      if (status && /cancel|reject|refuse|deny/u.test(status)) return { status: 'failed', message: '已在企业微信中取消授权' }
      if (status === 'success' || status === 'bound') {
        return { status: 'failed', message: '扫码成功，但企业微信没有返回机器人凭据，请改用手动填写' }
      }
    }
    await sleep(input.intervalMs ?? POLL_INTERVAL_MS, input.signal)
  }
  return { status: 'expired' }
}
