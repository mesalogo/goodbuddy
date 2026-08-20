import {
  speechModelCatalogEntrySchema,
  type SpeechModelCatalogEntry
} from '../../shared/speech-model-contracts'
import {
  huggingFaceTarget,
  modelScopeTarget
} from '../model-download-targets'

const senseVoiceModelScopeRepository =
  'pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue'
const senseVoiceModelScopeRevision =
  '73eca47697f980daa3d16112404174b6b950b514'
const senseVoiceHuggingFaceRepository =
  'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
const senseVoiceHuggingFaceRevision =
  '2365baeacb507f821a0c8120fcee3d484dba7a07'

const whisperTinyModelScopeRepository =
  'pengzhendong/sherpa-onnx-whisper-tiny'
const whisperTinyModelScopeRevision =
  '33a655645234f82ce833cf27b689d9c2212e693f'
const whisperTinyHuggingFaceRepository =
  'csukuangfj/sherpa-onnx-whisper-tiny'
const whisperTinyHuggingFaceRevision =
  '65176e2deb88badc814a94058666cadccc29b61c'

const paraformerBilingualModelScopeRepository =
  'pengzhendong/sherpa-onnx-paraformer-zh'
const paraformerBilingualModelScopeRevision =
  '66e549ea2ba4951d5d533b8ad3ffad09a29a4ba9'

const paraformerTrilingualModelScopeRepository =
  'pengzhendong/sherpa-onnx-paraformer-trilingual-zh-cantonese-en'
const paraformerTrilingualModelScopeRevision =
  '7cd698783acc17a4d0a7d3390e1588b534d949c7'

const whisperSmallModelScopeRepository =
  'pengzhendong/sherpa-onnx-whisper-small'
const whisperSmallModelScopeRevision =
  '893b50bd57565edb13eb1dfe84d33bfef77b0102'

const whisperMediumModelScopeRepository =
  'pengzhendong/sherpa-onnx-whisper-medium'
const whisperMediumModelScopeRevision =
  '4d75596a69806a269ff5911bb56fbae542f35463'

/**
 * Model weights are never bundled with GoodBuddy. Each file keeps a canonical
 * fingerprint for local import compatibility, while a source target can pin a
 * different verified size and SHA-256 when that source publishes another
 * compatible artifact revision.
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
      repositoryUrls: {
        modelscope:
          `https://modelscope.cn/models/${senseVoiceModelScopeRepository}`,
        'hugging-face':
          `https://huggingface.co/${senseVoiceHuggingFaceRepository}`
      },
      license: {
        name: '模型仓库自定义许可（Model License）',
        notice:
          'SenseVoiceSmall 权重采用上游声明的自定义 MODEL LICENSE，并非 Apache-2.0 或 MIT；导入和使用前请阅读完整许可条款。',
        url: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE'
      },
      manualOnly: false,
      files: [
        {
          name: 'model.int8.onnx',
          role: 'model',
          size: 239_233_841,
          sha256:
            'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
          targets: {
            modelscope: modelScopeTarget(
              senseVoiceModelScopeRepository,
              senseVoiceModelScopeRevision,
              'model.int8.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              senseVoiceHuggingFaceRepository,
              senseVoiceHuggingFaceRevision,
              'model.int8.onnx'
            )
          }
        },
        {
          name: 'tokens.txt',
          role: 'tokens',
          size: 315_894,
          sha256:
            'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
          targets: {
            modelscope: modelScopeTarget(
              senseVoiceModelScopeRepository,
              senseVoiceModelScopeRevision,
              'tokens.txt'
            ),
            'hugging-face': huggingFaceTarget(
              senseVoiceHuggingFaceRepository,
              senseVoiceHuggingFaceRevision,
              'tokens.txt'
            )
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
      repositoryUrls: {
        modelscope:
          `https://modelscope.cn/models/${whisperTinyModelScopeRepository}`,
        'hugging-face':
          `https://huggingface.co/${whisperTinyHuggingFaceRepository}`
      },
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
          size: 12_937_772,
          sha256:
            'd24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434',
          targets: {
            modelscope: modelScopeTarget(
              whisperTinyModelScopeRepository,
              whisperTinyModelScopeRevision,
              'tiny-encoder.int8.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              whisperTinyHuggingFaceRepository,
              whisperTinyHuggingFaceRevision,
              'tiny-encoder.int8.onnx'
            )
          }
        },
        {
          name: 'tiny-decoder.int8.onnx',
          role: 'decoder',
          size: 89_855_401,
          sha256:
            'd2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925',
          targets: {
            modelscope: modelScopeTarget(
              whisperTinyModelScopeRepository,
              whisperTinyModelScopeRevision,
              'tiny-decoder.int8.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              whisperTinyHuggingFaceRepository,
              whisperTinyHuggingFaceRevision,
              'tiny-decoder.int8.onnx'
            )
          }
        },
        {
          name: 'tiny-tokens.txt',
          role: 'tokens',
          size: 816_730,
          sha256:
            'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
          targets: {
            modelscope: modelScopeTarget(
              whisperTinyModelScopeRepository,
              whisperTinyModelScopeRevision,
              'tiny-tokens.txt'
            ),
            'hugging-face': huggingFaceTarget(
              whisperTinyHuggingFaceRepository,
              whisperTinyHuggingFaceRevision,
              'tiny-tokens.txt'
            )
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
      repositoryUrls: {
        modelscope:
          `https://modelscope.cn/models/${paraformerBilingualModelScopeRepository}`,
        'hugging-face':
          'https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-bilingual-zh-en'
      },
      license: {
        name: 'Apache License 2.0 / MIT License',
        notice:
          'ModelScope 工件声明 Apache License 2.0；Hugging Face 转换仓库声明 MIT License。模型源自 FunASR Paraformer，使用前请阅读所选来源的仓库说明。',
        url:
          `https://modelscope.cn/models/${paraformerBilingualModelScopeRepository}`
      },
      manualOnly: false,
      files: [
        {
          name: 'model.int8.onnx',
          role: 'model',
          size: 223_385_835,
          sha256:
            '9ada9127ca5b82320385ac12340eb8b05dee64fd45cf8cf593ec693826ec2fd7',
          targets: {
            modelscope: modelScopeTarget(
              paraformerBilingualModelScopeRepository,
              paraformerBilingualModelScopeRevision,
              'model.int8.onnx',
              {
                size: 227_330_205,
                sha256:
                  '90bc03034ae1bef9575f8cc798cd1519c8be8aa9e8b458a033e32017ff4d584c'
              }
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-paraformer-bilingual-zh-en',
              '4b891f7b5c73d874e607797a4b0578fd4c35dd4b',
              'model.int8.onnx'
            )
          }
        },
        {
          name: 'tokens.txt',
          role: 'tokens',
          size: 75_756,
          sha256:
            '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6',
          targets: {
            modelscope: modelScopeTarget(
              paraformerBilingualModelScopeRepository,
              paraformerBilingualModelScopeRevision,
              'tokens.txt',
              {
                size: 75_354,
                sha256:
                  '6c0e3b35cece259829e6cb5b8d90d13db88f61ea3a2953d11898e4b2bfd7a2e2'
              }
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-paraformer-bilingual-zh-en',
              '4b891f7b5c73d874e607797a4b0578fd4c35dd4b',
              'tokens.txt'
            )
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
      repositoryUrls: {
        modelscope:
          `https://modelscope.cn/models/${paraformerTrilingualModelScopeRepository}`,
        'hugging-face':
          'https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-trilingual-zh-cantonese-en'
      },
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
          size: 244_684_152,
          sha256:
            'eb3cdd288f535cf73258f491cdd7d68ad5a00aee135c0bba4c0884ea8d926144',
          targets: {
            modelscope: modelScopeTarget(
              paraformerTrilingualModelScopeRepository,
              paraformerTrilingualModelScopeRevision,
              'model.int8.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-paraformer-trilingual-zh-cantonese-en',
              '8d90151338178bb433354c9fb677bd3acb8023cd',
              'model.int8.onnx'
            )
          }
        },
        {
          name: 'tokens.txt',
          role: 'tokens',
          size: 118_931,
          sha256:
            '8e4593d7a2eb2404ff82976b5494265e9a06283ca4d5e8605bf7b4fed557a492',
          targets: {
            modelscope: modelScopeTarget(
              paraformerTrilingualModelScopeRepository,
              paraformerTrilingualModelScopeRevision,
              'tokens.txt'
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-paraformer-trilingual-zh-cantonese-en',
              '8d90151338178bb433354c9fb677bd3acb8023cd',
              'tokens.txt'
            )
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
      repositoryUrls: {
        modelscope:
          `https://modelscope.cn/models/${whisperSmallModelScopeRepository}`,
        'hugging-face':
          'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small'
      },
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
          size: 112_442_483,
          sha256:
            '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9',
          targets: {
            modelscope: modelScopeTarget(
              whisperSmallModelScopeRepository,
              whisperSmallModelScopeRevision,
              'small-encoder.int8.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-whisper-small',
              '8f3c18b358db4d1f2fc1eae49d75cd20989e4309',
              'small-encoder.int8.onnx'
            )
          }
        },
        {
          name: 'small-decoder.int8.onnx',
          role: 'decoder',
          size: 262_226_114,
          sha256:
            'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee',
          targets: {
            modelscope: modelScopeTarget(
              whisperSmallModelScopeRepository,
              whisperSmallModelScopeRevision,
              'small-decoder.int8.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-whisper-small',
              '8f3c18b358db4d1f2fc1eae49d75cd20989e4309',
              'small-decoder.int8.onnx'
            )
          }
        },
        {
          name: 'small-tokens.txt',
          role: 'tokens',
          size: 816_730,
          sha256:
            'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
          targets: {
            modelscope: modelScopeTarget(
              whisperSmallModelScopeRepository,
              whisperSmallModelScopeRevision,
              'small-tokens.txt'
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-whisper-small',
              '8f3c18b358db4d1f2fc1eae49d75cd20989e4309',
              'small-tokens.txt'
            )
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
      repositoryUrls: {
        modelscope:
          `https://modelscope.cn/models/${whisperMediumModelScopeRepository}`,
        'hugging-face':
          'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-medium'
      },
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
          size: 374_196_283,
          sha256:
            '1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e',
          targets: {
            modelscope: modelScopeTarget(
              whisperMediumModelScopeRepository,
              whisperMediumModelScopeRevision,
              'medium-encoder.int8.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-whisper-medium',
              '8c31d28503847560985df21f90e14f0c736e075e',
              'medium-encoder.int8.onnx'
            )
          }
        },
        {
          name: 'medium-decoder.int8.onnx',
          role: 'decoder',
          size: 571_059_257,
          sha256:
            '595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747',
          targets: {
            modelscope: modelScopeTarget(
              whisperMediumModelScopeRepository,
              whisperMediumModelScopeRevision,
              'medium-decoder.int8.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-whisper-medium',
              '8c31d28503847560985df21f90e14f0c736e075e',
              'medium-decoder.int8.onnx'
            )
          }
        },
        {
          name: 'medium-tokens.txt',
          role: 'tokens',
          size: 816_730,
          sha256:
            'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
          targets: {
            modelscope: modelScopeTarget(
              whisperMediumModelScopeRepository,
              whisperMediumModelScopeRevision,
              'medium-tokens.txt'
            ),
            'hugging-face': huggingFaceTarget(
              'csukuangfj/sherpa-onnx-whisper-medium',
              '8c31d28503847560985df21f90e14f0c736e075e',
              'medium-tokens.txt'
            )
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
