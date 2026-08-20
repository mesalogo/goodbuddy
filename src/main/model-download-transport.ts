import { ensureModelOperationNotAborted } from './model-package-utils'

const MAX_REDIRECTS = 3
const redirectStatuses = new Set([301, 302, 303, 307, 308])

function validateDownloadUrl(value: string, modelLabel: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      `${modelLabel}下载地址必须是使用标准端口、无凭据和 Fragment 的 HTTPS URL`
    )
  }
  return url
}

export async function fetchModelDownloadResponse(options: {
  transport: typeof fetch
  initialUrl: string
  redirectHosts: readonly string[]
  signal: AbortSignal
  modelLabel: string
}): Promise<Response> {
  let url = validateDownloadUrl(options.initialUrl, options.modelLabel)
  const initialHost = url.hostname
  const allowedRedirectHosts = new Set(options.redirectHosts)
  for (let redirectCount = 0; ; redirectCount += 1) {
    ensureModelOperationNotAborted(options.signal)
    const response = await options.transport(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal
    })
    if (!redirectStatuses.has(response.status)) {
      return response
    }
    if (redirectCount >= MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(
        `${options.modelLabel}下载重定向次数过多`
      )
    }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) {
      throw new Error(
        `${options.modelLabel}下载重定向缺少地址`
      )
    }
    const nextUrl = validateDownloadUrl(
      new URL(location, url).toString(),
      options.modelLabel
    )
    if (
      nextUrl.hostname !== initialHost &&
      !allowedRedirectHosts.has(nextUrl.hostname)
    ) {
      throw new Error(
        `${options.modelLabel}下载重定向到未声明的主机`
      )
    }
    url = nextUrl
  }
}
