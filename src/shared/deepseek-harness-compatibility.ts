type DeepSeekHarnessModelProfile = {
  baseUrl: string
  protocol: string
  authentication: string
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  )
}

export function isDeepSeekHarnessCompatibleBaseUrl(
  value: string
): boolean {
  try {
    const url = new URL(value)
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false
    }
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        isLoopbackHostname(url.hostname))
    )
  } catch {
    return false
  }
}

export function isDeepSeekHarnessModelProfile(
  profile: DeepSeekHarnessModelProfile
): boolean {
  return (
    profile.protocol === 'openai-chat-completions' &&
    profile.authentication === 'api-key' &&
    isDeepSeekHarnessCompatibleBaseUrl(profile.baseUrl)
  )
}
