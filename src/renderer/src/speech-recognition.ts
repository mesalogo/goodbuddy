export type SpeechRecognitionErrorCode =
  | 'aborted'
  | 'audio-capture'
  | 'bad-grammar'
  | 'language-not-supported'
  | 'network'
  | 'no-speech'
  | 'not-allowed'
  | 'phrases-not-supported'
  | 'service-not-allowed'

export type SpeechRecognitionResultEvent = {
  results: ArrayLike<{
    0?: { transcript?: string }
  }>
}

export type SpeechRecognitionErrorEvent = {
  error?: SpeechRecognitionErrorCode | string
  message?: string
}

export type SpeechRecognitionInstance = {
  lang: string
  interimResults: boolean
  continuous: boolean
  processLocally?: boolean
  start: () => void
  stop: () => void
  onresult?: (event: SpeechRecognitionResultEvent) => void
  onerror?: (event: SpeechRecognitionErrorEvent) => void
  onend?: () => void
}

type LocalAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'

type LocalSpeechOptions = {
  langs: string[]
  processLocally: true
}

export type SpeechRecognitionConstructor = {
  new (): SpeechRecognitionInstance
  available?: (
    options: LocalSpeechOptions
  ) => Promise<LocalAvailability>
  install?: (options: LocalSpeechOptions) => Promise<boolean>
}

export type PreparedSpeechRecognition = {
  recognition: SpeechRecognitionInstance
  local: boolean
}

type SpeechPreparationTimeouts = {
  availabilityMs?: number
  installMs?: number
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(message)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export function getSpeechRecognitionConstructor(
  target: Window
): SpeechRecognitionConstructor | undefined {
  const speechWindow = target as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return (
    speechWindow.SpeechRecognition ??
    speechWindow.webkitSpeechRecognition
  )
}

export async function prepareSpeechRecognition(
  Recognition: SpeechRecognitionConstructor,
  lang: string,
  onDownload?: () => void,
  timeouts: SpeechPreparationTimeouts = {},
  userAgent = navigator.userAgent
): Promise<PreparedSpeechRecognition> {
  if (isElectronUserAgent(userAgent)) {
    throw new Error(
      '当前 Electron 版本不支持可靠的语音识别，请改用系统听写功能输入文字'
    )
  }
  const recognition = new Recognition()
  const options: LocalSpeechOptions = {
    langs: [lang],
    processLocally: true
  }
  let local = false

  if (Recognition.available) {
    const availability = await withTimeout(
      Recognition.available(options),
      timeouts.availabilityMs ?? 5_000,
      '检查中文离线语音包超时，请确认网络后重试'
    )
    if (availability === 'available') {
      local = true
    } else if (
      availability === 'downloadable' &&
      Recognition.install
    ) {
      onDownload?.()
      local = await withTimeout(
        Recognition.install(options),
        timeouts.installMs ?? 120_000,
        '中文离线语音包下载超时，请检查网络后重试'
      )
    } else if (availability === 'downloading') {
      throw new Error('中文离线语音包正在下载，请稍后重试')
    }
  }

  if (local) {
    recognition.processLocally = true
  }
  recognition.lang = lang
  recognition.interimResults = false
  recognition.continuous = false
  return { recognition, local }
}

export function isElectronUserAgent(userAgent: string): boolean {
  return /\bElectron\/[\d.]+\b/u.test(userAgent)
}

export function describeSpeechRecognitionError(
  event: SpeechRecognitionErrorEvent
): string {
  switch (event.error) {
    case 'aborted':
      return '语音识别已取消'
    case 'audio-capture':
      return '未检测到可用麦克风，请检查设备连接和系统输入设置'
    case 'language-not-supported':
      return '当前系统没有可用的中文语音识别包'
    case 'network':
      return 'Electron 在线语音服务不可用，请安装中文离线语音包后重试'
    case 'no-speech':
      return '没有检测到语音，请靠近麦克风后重试'
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风权限被拒绝，请在系统隐私设置中允许 GoodBuddy 使用麦克风'
    case 'phrases-not-supported':
      return '当前语音识别服务不支持短语增强'
    case 'bad-grammar':
      return '当前语音识别服务无法处理语法配置'
    default:
      return '语音识别失败，请检查麦克风和系统语音设置'
  }
}
