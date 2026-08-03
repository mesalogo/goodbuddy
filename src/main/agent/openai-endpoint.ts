export function createOpenAIApiBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.replace(/\/+$/u, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/u, '')
}

export function createOpenAIChatCompletionsUrl(baseUrl: string): URL {
  return new URL(`${createOpenAIApiBaseUrl(baseUrl)}/chat/completions`)
}

export function createOpenAIResponsesUrl(baseUrl: string): URL {
  return new URL(`${createOpenAIApiBaseUrl(baseUrl)}/responses`)
}

export function createOpenAIImagesGenerationsUrl(baseUrl: string): URL {
  return new URL(`${createOpenAIApiBaseUrl(baseUrl)}/images/generations`)
}
