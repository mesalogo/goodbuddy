import {
  speechModelCatalogEntrySchema,
  type SpeechModelCatalogEntry
} from '../../shared/speech-model-contracts'

/**
 * This catalog intentionally contains metadata only. Model weights are never
 * bundled with GoodBuddy. Entries remain manual-only until every downloadable
 * file has a pinned revision, byte size, and independently verified SHA-256.
 */
export const SPEECH_MODEL_CATALOG: readonly SpeechModelCatalogEntry[] =
  speechModelCatalogEntrySchema.array().parse([
    {
      id: 'sensevoice-small-int8',
      displayName: 'SenseVoiceSmall INT8',
      description:
        '快速中文语音识别，兼顾粤语、英语、日语和韩语，适合本地 CPU 使用。',
      languages: ['中文', '粤语', '英语', '日语', '韩语'],
      family: 'sensevoice',
      quantization: 'int8',
      repositoryUrl:
        'https://modelscope.cn/models/pengzhendong/' +
        'sherpa-onnx-sense-voice-zh-en-ja-ko-yue',
      license: {
        name: '模型仓库自定义许可（Model License）',
        notice:
          'SenseVoiceSmall 权重采用模型仓库声明的自定义 MODEL LICENSE，并非 Apache-2.0 或 MIT；导入和使用前请阅读完整许可条款。',
        url: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE'
      },
      manualOnly: false,
      files: [
        {
          name: 'model.int8.onnx',
          role: 'model',
          download: {
            url:
              'https://modelscope.cn/models/pengzhendong/' +
              'sherpa-onnx-sense-voice-zh-en-ja-ko-yue/' +
              'resolve/73eca47697f980daa3d16112404174b6b950b514/' +
              'model.int8.onnx',
            size: 239_233_841,
            sha256:
              'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'
          }
        },
        {
          name: 'tokens.txt',
          role: 'tokens',
          download: {
            url:
              'https://modelscope.cn/models/pengzhendong/' +
              'sherpa-onnx-sense-voice-zh-en-ja-ko-yue/' +
              'resolve/73eca47697f980daa3d16112404174b6b950b514/' +
              'tokens.txt',
            size: 315_894,
            sha256:
              'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'
          }
        }
      ]
    },
    {
      id: 'whisper-tiny-multilingual',
      displayName: 'Whisper Tiny（多语言）',
      description:
        'OpenAI Whisper Tiny 多语言备选，体积较小，支持中文及多种语言。',
      languages: ['中文', '英语', '多语言'],
      family: 'whisper',
      quantization: 'int8',
      repositoryUrl:
        'https://modelscope.cn/models/pengzhendong/' +
        'sherpa-onnx-whisper-tiny',
      license: {
        name: 'MIT License',
        notice:
          'Whisper 模型由 OpenAI 以 MIT License 发布；转换后的文件应同时遵守上游仓库随附说明。',
        url: 'https://github.com/openai/whisper/blob/main/LICENSE'
      },
      manualOnly: false,
      files: [
        {
          name: 'tiny-encoder.int8.onnx',
          role: 'encoder',
          download: {
            url:
              'https://modelscope.cn/models/pengzhendong/' +
              'sherpa-onnx-whisper-tiny/resolve/' +
              '33a655645234f82ce833cf27b689d9c2212e693f/' +
              'tiny-encoder.int8.onnx',
            size: 12_937_772,
            sha256:
              'd24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434'
          }
        },
        {
          name: 'tiny-decoder.int8.onnx',
          role: 'decoder',
          download: {
            url:
              'https://modelscope.cn/models/pengzhendong/' +
              'sherpa-onnx-whisper-tiny/resolve/' +
              '33a655645234f82ce833cf27b689d9c2212e693f/' +
              'tiny-decoder.int8.onnx',
            size: 89_855_401,
            sha256:
              'd2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925'
          }
        },
        {
          name: 'tiny-tokens.txt',
          role: 'tokens',
          download: {
            url:
              'https://modelscope.cn/models/pengzhendong/' +
              'sherpa-onnx-whisper-tiny/resolve/' +
              '33a655645234f82ce833cf27b689d9c2212e693f/' +
              'tiny-tokens.txt',
            size: 816_730,
            sha256:
              'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
          }
        }
      ]
    }
  ])

export function getSpeechModelCatalogEntry(
  modelId: string
): SpeechModelCatalogEntry | undefined {
  return SPEECH_MODEL_CATALOG.find((entry) => entry.id === modelId)
}
