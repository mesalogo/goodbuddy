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
