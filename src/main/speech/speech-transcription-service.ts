import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  speechTranscriptionInputSchema,
  speechTranscriptionResultSchema,
  type SpeechTranscriptionInput,
  type SpeechTranscriptionResult
} from '../../shared/speech-model-contracts'
import type {
  SelectedSpeechRuntimeModel,
  SpeechModelManager
} from './speech-model-manager'

const TRANSCRIPTION_TIMEOUT_MS = 120_000

type SherpaRecognizerConfig = {
  featConfig: {
    sampleRate: number
    featureDim: number
  }
  modelConfig: {
    tokens: string
    numThreads: number
    debug: number
    provider: 'cpu'
    senseVoice?: {
      model: string
      language: string
      useInverseTextNormalization: number
    }
    paraformer?: {
      model: string
    }
    whisper?: {
      encoder: string
      decoder: string
      language: string
      task: 'transcribe'
      tailPaddings: number
    }
  }
}

type SpeechTranscriptionRunner = (
  config: SherpaRecognizerConfig,
  samples: Float32Array,
  sampleRate: number,
  signal: AbortSignal
) => Promise<string>

type SpeechModelResolver = Pick<
  SpeechModelManager,
  'getSelectedRuntimeModel'
>

const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads')

let recognizer
let stream
try {
  const sherpa = require(workerData.sherpaModulePath)
  recognizer = sherpa.createOfflineRecognizer(workerData.config)
  stream = recognizer.createStream()
  stream.acceptWaveform(
    workerData.sampleRate,
    new Float32Array(workerData.samples)
  )
  recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  parentPort.postMessage({
    ok: true,
    text: typeof result?.text === 'string' ? result.text : ''
  })
} catch {
  parentPort.postMessage({ ok: false })
} finally {
  stream?.free()
  recognizer?.free()
}
`

function createAbortError(): Error {
  const error = new Error('语音识别已取消')
  error.name = 'AbortError'
  return error
}

function requiredFile(
  model: SelectedSpeechRuntimeModel,
  role: SelectedSpeechRuntimeModel['files'][number]['role']
): string {
  const file = model.files.find((candidate) => candidate.role === role)
  if (!file) {
    throw new Error('所选语音模型文件不完整，请重新安装模型')
  }
  return join(model.directory, file.name)
}

export function createSherpaRecognizerConfig(
  model: SelectedSpeechRuntimeModel
): SherpaRecognizerConfig {
  const tokens = requiredFile(model, 'tokens')
  const base = {
    featConfig: {
      sampleRate: 16_000,
      featureDim: 80
    },
    modelConfig: {
      tokens,
      numThreads: 2,
      debug: 0,
      provider: 'cpu' as const
    }
  }
  if (model.family === 'sensevoice') {
    return {
      ...base,
      modelConfig: {
        ...base.modelConfig,
        senseVoice: {
          model: requiredFile(model, 'model'),
          language: 'auto',
          useInverseTextNormalization: 1
        }
      }
    }
  }
  if (model.family === 'paraformer') {
    return {
      ...base,
      modelConfig: {
        ...base.modelConfig,
        paraformer: {
          model: requiredFile(model, 'model')
        }
      }
    }
  }
  return {
    ...base,
    modelConfig: {
      ...base.modelConfig,
      whisper: {
        encoder: requiredFile(model, 'encoder'),
        decoder: requiredFile(model, 'decoder'),
        language: '',
        task: 'transcribe',
        tailPaddings: -1
      }
    }
  }
}

const require = createRequire(import.meta.url)

export const runSherpaTranscription: SpeechTranscriptionRunner = (
  config,
  samples,
  sampleRate,
  signal
) =>
  new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError())
      return
    }
    const audioBuffer = samples.buffer as ArrayBuffer
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        sherpaModulePath: require.resolve('sherpa-onnx'),
        config,
        sampleRate,
        samples: audioBuffer
      },
      transferList: [audioBuffer]
    })
    let settled = false
    const finish = (
      action: () => void,
      terminate = true
    ): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      worker.removeAllListeners()
      if (terminate) {
        void worker.terminate()
      }
      action()
    }
    const abort = (): void =>
      finish(() => reject(createAbortError()))
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error('本地语音识别超时，请缩短录音后重试'))
        ),
      TRANSCRIPTION_TIMEOUT_MS
    )
    signal.addEventListener('abort', abort, { once: true })
    worker.once(
      'message',
      (message: { ok?: boolean; text?: unknown }) => {
        if (message.ok && typeof message.text === 'string') {
          const text = message.text
          finish(() => resolve(text), false)
        } else {
          finish(
            () =>
              reject(
                new Error('本地语音识别失败，请重新安装模型后重试')
              ),
            false
          )
        }
      }
    )
    worker.once('error', () =>
      finish(() =>
        reject(new Error('本地语音识别 Runtime 启动失败'))
      )
    )
    worker.once('exit', (code) => {
      if (code !== 0) {
        finish(
          () =>
            reject(new Error('本地语音识别 Runtime 意外退出')),
          false
        )
      }
    })
  })

export class SpeechTranscriptionService {
  private readonly active = new Map<string, AbortController>()

  constructor(
    private readonly models: SpeechModelResolver,
    private readonly runner: SpeechTranscriptionRunner =
      runSherpaTranscription
  ) {}

  async transcribe(input: unknown): Promise<SpeechTranscriptionResult> {
    const request = speechTranscriptionInputSchema.parse(input)
    if (this.active.has(request.requestId)) {
      throw new Error('该语音识别请求已在运行')
    }
    if (this.active.size > 0) {
      throw new Error('已有语音识别正在运行，请稍后重试')
    }
    const samples = new Float32Array(request.audio.slice(0))
    if (
      samples.some(
        (sample) =>
          !Number.isFinite(sample) || sample < -1 || sample > 1
      )
    ) {
      throw new Error('录音采样数据无效')
    }
    const controller = new AbortController()
    this.active.set(request.requestId, controller)
    try {
      const model = await this.models.getSelectedRuntimeModel()
      if (!model) {
        throw new Error('请先在设置中安装并选择本地语音模型')
      }
      const text = await this.runner(
        createSherpaRecognizerConfig(model),
        samples,
        request.sampleRate,
        controller.signal
      )
      return speechTranscriptionResultSchema.parse({ text })
    } finally {
      this.active.delete(request.requestId)
    }
  }

  cancel(requestId: SpeechTranscriptionInput['requestId']): boolean {
    const parsedId = speechTranscriptionInputSchema.shape.requestId.parse(
      requestId
    )
    const controller = this.active.get(parsedId)
    if (!controller) {
      return false
    }
    controller.abort()
    return true
  }

  dispose(): void {
    for (const controller of this.active.values()) {
      controller.abort()
    }
    this.active.clear()
  }
}
