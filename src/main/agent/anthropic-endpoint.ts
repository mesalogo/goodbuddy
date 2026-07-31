export function createAnthropicApiBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function createAnthropicMessagesUrl(baseUrl: string): URL {
  return new URL(`${createAnthropicApiBaseUrl(baseUrl)}/messages`)
}
