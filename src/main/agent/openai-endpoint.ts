export function createOpenAIApiBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.replace(/\/+$/u, '')
  url.hash = ''
  const normalized = url.toString()
  return url.pathname === '/'
    ? normalized.replace(/\/(?=[?#]|$)/u, '')
    : normalized
}

/**
 * Appends an API path while preserving any query the base URL carries, which
 * gateways such as Azure OpenAI require. Child runtimes cannot forward a query
 * through their own base URL, so they keep using createOpenAIApiBaseUrl.
 */
function createOpenAIRequestUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`
  url.hash = ''
  return url
}

export function createOpenAIChatCompletionsUrl(baseUrl: string): URL {
  return createOpenAIRequestUrl(baseUrl, '/chat/completions')
}

export function createOpenAIResponsesUrl(baseUrl: string): URL {
  return createOpenAIRequestUrl(baseUrl, '/responses')
}

export function createOpenAIImagesGenerationsUrl(baseUrl: string): URL {
  return createOpenAIRequestUrl(baseUrl, '/images/generations')
}
