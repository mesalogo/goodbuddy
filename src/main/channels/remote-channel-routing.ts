export function parseRemoteChannelPrompt(
  text: string
): {
  prompt: string
} {
  const prompt = text.trim()
  if (!prompt) {
    throw new Error('远程请求内容不能为空')
  }
  return { prompt }
}

export function requestsRemoteResultFile(text: string): boolean {
  const value = text.trim()
  return (
    /(?:生成|导出|整理|制作|写成|发送|发我).{0,12}(?:文件|附件|可下载文档)|(?:以|用)(?:文件|附件|可下载文档)(?:形式|格式)/u.test(
      value
    ) ||
    /\b(?:create|generate|export|send|return|provide)\b.{0,40}\b(?:file|attachment|downloadable document)\b/iu.test(
      value
    )
  )
}
