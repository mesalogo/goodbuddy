import type { WorkMode } from '../../shared/assistant-contracts'

const COMMAND_PATTERN =
  /^\/(?<command>ask|execute|exec)(?=$|[\s:：])[\s:：]*/iu
const CHINESE_PATTERN =
  /^(?<command>对话|问答|执行)(?=$|[\s:：])[\s:：]*/u

export function parseRemoteChannelPrompt(
  text: string,
  defaultWorkMode: WorkMode
): {
  workMode: WorkMode
  prompt: string
} {
  const value = text.trim()
  const commandMatch = COMMAND_PATTERN.exec(value)
  const chineseMatch = commandMatch ? undefined : CHINESE_PATTERN.exec(value)
  const match = commandMatch ?? chineseMatch
  const command = (
    match?.groups?.command ?? ''
  ).toLocaleLowerCase()
  const workMode =
    command === 'execute' ||
    command === 'exec' ||
    command === '执行'
      ? 'execute'
      : command === 'ask' ||
          command === '对话' ||
          command === '问答'
        ? 'ask'
        : defaultWorkMode
  const prompt = match ? value.slice(match[0].length).trim() : value
  if (!prompt) {
    throw new Error('远程请求内容不能为空')
  }
  return { workMode, prompt }
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
