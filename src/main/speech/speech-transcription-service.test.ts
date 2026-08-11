import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  SPEECH_TRANSCRIPTION_SAMPLE_RATE,
  type SpeechTranscriptionInput
} from '../../shared/speech-model-contracts'
import {
  SpeechTranscriptionService,
  createSherpaRecognizerConfig
} from './speech-transcription-service'
import type { SelectedSpeechRuntimeModel } from './speech-model-manager'

const requestId = '00000000-0000-4000-8000-000000000001'

function whisperModel(): SelectedSpeechRuntimeModel {
  return {
    id: 'whisper-tiny-multilingual',
    family: 'whisper',
    directory: 'C:\\models\\whisper',
    files: [
      {
        name: 'tiny-encoder.int8.onnx',
        role: 'encoder',
        size: 1,
        sha256: 'a'.repeat(64)
      },
      {
        name: 'tiny-decoder.int8.onnx',
        role: 'decoder',
        size: 1,
        sha256: 'b'.repeat(64)
      },
      {
        name: 'tiny-tokens.txt',
        role: 'tokens',
        size: 1,
        sha256: 'c'.repeat(64)
      }
    ]
  }
}

function paraformerModel(): SelectedSpeechRuntimeModel {
  return {
    id: 'paraformer-bilingual-zh-en-int8',
    family: 'paraformer',
    directory: 'C:\\models\\paraformer',
    files: [
      {
        name: 'model.int8.onnx',
        role: 'model',
        size: 1,
        sha256: 'a'.repeat(64)
      },
      {
        name: 'tokens.txt',
        role: 'tokens',
        size: 1,
        sha256: 'b'.repeat(64)
      }
    ]
  }
}

function input(): SpeechTranscriptionInput {
  return {
    requestId,
    sampleRate: SPEECH_TRANSCRIPTION_SAMPLE_RATE,
    audio: new Float32Array([0, 0.25, -0.25]).buffer
  }
}

describe('SpeechTranscriptionService', () => {
  it('wires the selected Whisper files to bounded local inference', async () => {
    const runner = vi.fn(async () => ' 本地识别结果 ')
    const service = new SpeechTranscriptionService(
      {
        getSelectedRuntimeModel: vi.fn(async () => whisperModel())
      },
      runner
    )

    await expect(service.transcribe(input())).resolves.toEqual({
      text: '本地识别结果'
    })
    expect(runner).toHaveBeenCalledWith(
      createSherpaRecognizerConfig(whisperModel()),
      expect.any(Float32Array),
      SPEECH_TRANSCRIPTION_SAMPLE_RATE,
      expect.any(AbortSignal)
    )
    expect(
      createSherpaRecognizerConfig(whisperModel()).modelConfig.whisper
        ?.language
    ).toBe('')
  })

  it('wires an offline Paraformer model to local inference', () => {
    expect(
      createSherpaRecognizerConfig(paraformerModel()).modelConfig
        .paraformer
    ).toEqual({
      model: join(paraformerModel().directory, 'model.int8.onnx')
    })
  })

  it('requires an installed selected model and rejects oversized audio', async () => {
    const service = new SpeechTranscriptionService(
      {
        getSelectedRuntimeModel: vi.fn(async () => undefined)
      },
      vi.fn()
    )

    await expect(service.transcribe(input())).rejects.toThrow(
      '安装并选择本地语音模型'
    )
    await expect(
      service.transcribe({
        ...input(),
        audio: new ArrayBuffer(
          SPEECH_TRANSCRIPTION_SAMPLE_RATE * 20 * 4 + 4
        )
      })
    ).rejects.toThrow('录音数据')
  })

  it('aborts active inference and cleans up cancellation state', async () => {
    const runner = vi.fn(
      (
        _config: unknown,
        _samples: Float32Array,
        _sampleRate: number,
        signal: AbortSignal
      ) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled by test')),
            { once: true }
          )
        })
    )
    const service = new SpeechTranscriptionService(
      {
        getSelectedRuntimeModel: vi.fn(async () => whisperModel())
      },
      runner
    )

    const transcription = service.transcribe(input())
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
    expect(service.cancel(requestId)).toBe(true)
    await expect(transcription).rejects.toThrow('cancelled by test')
    expect(service.cancel(requestId)).toBe(false)
  })

  it('surfaces inference failures and frees the request for retry', async () => {
    const runner = vi.fn(async () => {
      throw new Error('Runtime failed')
    })
    const service = new SpeechTranscriptionService(
      {
        getSelectedRuntimeModel: vi.fn(async () => whisperModel())
      },
      runner
    )

    await expect(service.transcribe(input())).rejects.toThrow(
      'Runtime failed'
    )
    await expect(service.transcribe(input())).rejects.toThrow(
      'Runtime failed'
    )
  })
})
