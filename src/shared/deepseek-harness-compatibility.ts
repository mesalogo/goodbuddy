type DeepSeekHarnessModelProfile = {
  baseUrl: string
  protocol: string
  authentication: string
}

export function isDeepSeekHarnessCompatibleBaseUrl(
  value: string
): boolean {
  try {
    const url = new URL(value)
    return (
      Boolean(url.hostname) &&
      (url.protocol === 'http:' || url.protocol === 'https:')
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
