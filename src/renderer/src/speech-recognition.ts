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
    throw new Error('本地语音识别服务未加载，请重启 GoodBuddy 后重试')
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

export type PcmRecordingResult = {
  audio: ArrayBuffer
  sampleRate: 16_000
}

export type PcmRecording = {
  result: Promise<PcmRecordingResult>
  stop: () => void
  cancel: () => void
}

type AudioContextConstructor = new () => AudioContext

function recordingAbortError(): Error {
  const error = new Error('语音录音已取消')
  error.name = 'AbortError'
  return error
}

export function resamplePcm(
  samples: Float32Array,
  sourceRate: number,
  targetRate = 16_000
): Float32Array {
  if (
    samples.length === 0 ||
    !Number.isFinite(sourceRate) ||
    sourceRate <= 0 ||
    !Number.isFinite(targetRate) ||
    targetRate <= 0
  ) {
    return new Float32Array()
  }
  if (sourceRate === targetRate) {
    return samples.slice()
  }
  const outputLength = Math.max(
    1,
    Math.floor((samples.length * targetRate) / sourceRate)
  )
  const output = new Float32Array(outputLength)
  const ratio = sourceRate / targetRate
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const leftIndex = Math.min(Math.floor(position), samples.length - 1)
    const rightIndex = Math.min(leftIndex + 1, samples.length - 1)
    const fraction = position - leftIndex
    output[index] =
      (samples[leftIndex] ?? 0) * (1 - fraction) +
      (samples[rightIndex] ?? 0) * fraction
  }
  return output
}

export async function startPcmRecording(
  mediaDevices: Pick<MediaDevices, 'getUserMedia'>,
  AudioContextType: AudioContextConstructor,
  maxSeconds = 20
): Promise<PcmRecording> {
  const stream = await mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    },
    video: false
  })
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: ScriptProcessorNode | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const chunks: Float32Array[] = []
  let sampleCount = 0
  let resolveResult!: (result: PcmRecordingResult) => void
  let rejectResult!: (reason: Error) => void
  const result = new Promise<PcmRecordingResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    processor?.disconnect()
    source?.disconnect()
    for (const track of stream.getTracks()) {
      track.stop()
    }
    if (context) {
      void context.close().catch(() => undefined)
    }
  }
  const stop = (): void => {
    if (settled) {
      return
    }
    settled = true
    cleanup()
    if (!context || sampleCount === 0) {
      rejectResult(new Error('没有录到声音，请检查麦克风后重试'))
      return
    }
    const combined = new Float32Array(sampleCount)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    const resampled = resamplePcm(combined, context.sampleRate)
    resolveResult({
      audio: resampled.buffer as ArrayBuffer,
      sampleRate: 16_000
    })
  }
  const cancel = (): void => {
    if (settled) {
      return
    }
    settled = true
    cleanup()
    rejectResult(recordingAbortError())
  }

  try {
    context = new AudioContextType()
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(4_096, 1, 1)
    const maximumSamples = Math.ceil(
      Math.min(context.sampleRate, 192_000) * maxSeconds
    )
    processor.onaudioprocess = (event) => {
      if (settled) {
        return
      }
      const channel = event.inputBuffer.getChannelData(0)
      const remaining = maximumSamples - sampleCount
      if (remaining <= 0) {
        stop()
        return
      }
      const chunk = channel.slice(0, remaining)
      chunks.push(chunk)
      sampleCount += chunk.length
      if (sampleCount >= maximumSamples) {
        stop()
      }
    }
    source.connect(processor)
    processor.connect(context.destination)
    timer = setTimeout(stop, maxSeconds * 1_000)
    return { result, stop, cancel }
  } catch (error) {
    cleanup()
    throw error
  }
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
