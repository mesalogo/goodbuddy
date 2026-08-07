export function createAnthropicApiBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  url.hash = ''
  return url.toString()
}

export function createAnthropicMessagesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/u, '')
  url.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/messages`
  url.hash = ''
  return url
}
