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
      quality: 'high',
      speed: 'fast',
      recommended: true,
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
      quality: 'basic',
      speed: 'fast',
      recommended: false,
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
    },
    {
      id: 'paraformer-bilingual-zh-en-int8',
      displayName: 'Paraformer 中英双语 INT8',
      description:
        '面向普通话与英语的快速离线识别，适合以中文为主并夹杂英文的本地听写。',
      languages: ['中文', '英语'],
      family: 'paraformer',
      quantization: 'int8',
      quality: 'high',
      speed: 'fast',
      recommended: true,
      repositoryUrl:
        'https://huggingface.co/csukuangfj/' +
        'sherpa-onnx-paraformer-bilingual-zh-en',
      license: {
        name: 'MIT License',
        notice:
          '转换仓库声明 MIT License；模型源自 FunASR Paraformer，使用前请同时阅读仓库说明。',
        url:
          'https://huggingface.co/csukuangfj/' +
          'sherpa-onnx-paraformer-bilingual-zh-en/blob/' +
          '4b891f7b5c73d874e607797a4b0578fd4c35dd4b/README.md'
      },
      manualOnly: false,
      files: [
        {
          name: 'model.int8.onnx',
          role: 'model',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-paraformer-bilingual-zh-en/resolve/' +
              '4b891f7b5c73d874e607797a4b0578fd4c35dd4b/' +
              'model.int8.onnx',
            size: 223_385_835,
            sha256:
              '9ada9127ca5b82320385ac12340eb8b05dee64fd45cf8cf593ec693826ec2fd7'
          }
        },
        {
          name: 'tokens.txt',
          role: 'tokens',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-paraformer-bilingual-zh-en/resolve/' +
              '4b891f7b5c73d874e607797a4b0578fd4c35dd4b/' +
              'tokens.txt',
            size: 75_756,
            sha256:
              '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6'
          }
        }
      ]
    },
    {
      id: 'paraformer-trilingual-zh-yue-en-int8',
      displayName: 'Paraformer 中粤英三语 INT8',
      description:
        '支持普通话、粤语和英语的离线识别，适合多语混合及粤语输入。',
      languages: ['中文', '粤语', '英语'],
      family: 'paraformer',
      quantization: 'int8',
      quality: 'high',
      speed: 'balanced',
      recommended: false,
      repositoryUrl:
        'https://huggingface.co/csukuangfj/' +
        'sherpa-onnx-paraformer-trilingual-zh-cantonese-en',
      license: {
        name: 'Apache License 2.0',
        notice:
          '转换模型来自 ModelScope SeACo-Paraformer 中粤英模型；上游仓库声明 Apache License 2.0。',
        url:
          'https://modelscope.cn/models/dengcunqin/' +
          'speech_seaco_paraformer_large_asr_nat-zh-cantonese-en-' +
          '16k-common-vocab11666-pytorch'
      },
      manualOnly: false,
      files: [
        {
          name: 'model.int8.onnx',
          role: 'model',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-paraformer-trilingual-zh-cantonese-en/' +
              'resolve/8d90151338178bb433354c9fb677bd3acb8023cd/' +
              'model.int8.onnx',
            size: 244_684_152,
            sha256:
              'eb3cdd288f535cf73258f491cdd7d68ad5a00aee135c0bba4c0884ea8d926144'
          }
        },
        {
          name: 'tokens.txt',
          role: 'tokens',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-paraformer-trilingual-zh-cantonese-en/' +
              'resolve/8d90151338178bb433354c9fb677bd3acb8023cd/' +
              'tokens.txt',
            size: 118_931,
            sha256:
              '8e4593d7a2eb2404ff82976b5494265e9a06283ca4d5e8605bf7b4fed557a492'
          }
        }
      ]
    },
    {
      id: 'whisper-small-multilingual-int8',
      displayName: 'Whisper Small（多语言）INT8',
      description:
        '多语言均衡模型，识别质量明显高于 Tiny，适合常规多语言听写。',
      languages: ['中文', '英语', '多语言'],
      family: 'whisper',
      quantization: 'int8',
      quality: 'balanced',
      speed: 'balanced',
      recommended: false,
      repositoryUrl:
        'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small',
      license: {
        name: 'MIT License',
        notice:
          'Whisper 模型由 OpenAI 以 MIT License 发布；转换后的文件应同时遵守上游仓库随附说明。',
        url: 'https://github.com/openai/whisper/blob/main/LICENSE'
      },
      manualOnly: false,
      files: [
        {
          name: 'small-encoder.int8.onnx',
          role: 'encoder',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-whisper-small/resolve/' +
              '8f3c18b358db4d1f2fc1eae49d75cd20989e4309/' +
              'small-encoder.int8.onnx',
            size: 112_442_483,
            sha256:
              '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9'
          }
        },
        {
          name: 'small-decoder.int8.onnx',
          role: 'decoder',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-whisper-small/resolve/' +
              '8f3c18b358db4d1f2fc1eae49d75cd20989e4309/' +
              'small-decoder.int8.onnx',
            size: 262_226_114,
            sha256:
              'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee'
          }
        },
        {
          name: 'small-tokens.txt',
          role: 'tokens',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-whisper-small/resolve/' +
              '8f3c18b358db4d1f2fc1eae49d75cd20989e4309/' +
              'small-tokens.txt',
            size: 816_730,
            sha256:
              'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'
          }
        }
      ]
    },
    {
      id: 'whisper-medium-multilingual-int8',
      displayName: 'Whisper Medium（多语言）INT8',
      description:
        '高质量多语言模型，适合更重视准确率且能够接受较慢 CPU 推理的场景。',
      languages: ['中文', '英语', '多语言'],
      family: 'whisper',
      quantization: 'int8',
      quality: 'high',
      speed: 'slow',
      recommended: false,
      repositoryUrl:
        'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-medium',
      license: {
        name: 'MIT License',
        notice:
          'Whisper 模型由 OpenAI 以 MIT License 发布；转换后的文件应同时遵守上游仓库随附说明。',
        url: 'https://github.com/openai/whisper/blob/main/LICENSE'
      },
      manualOnly: false,
      files: [
        {
          name: 'medium-encoder.int8.onnx',
          role: 'encoder',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-whisper-medium/resolve/' +
              '8c31d28503847560985df21f90e14f0c736e075e/' +
              'medium-encoder.int8.onnx',
            size: 374_196_283,
            sha256:
              '1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e'
          }
        },
        {
          name: 'medium-decoder.int8.onnx',
          role: 'decoder',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-whisper-medium/resolve/' +
              '8c31d28503847560985df21f90e14f0c736e075e/' +
              'medium-decoder.int8.onnx',
            size: 571_059_257,
            sha256:
              '595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747'
          }
        },
        {
          name: 'medium-tokens.txt',
          role: 'tokens',
          download: {
            url:
              'https://huggingface.co/csukuangfj/' +
              'sherpa-onnx-whisper-medium/resolve/' +
              '8c31d28503847560985df21f90e14f0c736e075e/' +
              'medium-tokens.txt',
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
