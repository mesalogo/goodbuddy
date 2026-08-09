const ALLOWED_WECHAT_HOST_SUFFIX = '.weixin.qq.com'

export function isAllowedWechatUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLocaleLowerCase()
    return (
      parsed.protocol === 'https:' &&
      (host === 'weixin.qq.com' ||
        host.endsWith(ALLOWED_WECHAT_HOST_SUFFIX)) &&
      parsed.username === '' &&
      parsed.password === ''
    )
  } catch {
    return false
  }
}

export function redactWechatSidecarError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : '微信通信发生未知错误'
  return message
    .replace(
      /\b(token|authorization|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/giu,
      '$1$2[已隐藏]'
    )
    .replace(
      /\bhttps?:\/\/[^\s/]+\/[^\s]*/giu,
      '[微信服务地址已隐藏]'
    )
    .slice(0, 512)
}
