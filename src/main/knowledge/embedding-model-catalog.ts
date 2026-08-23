import {
  embeddingModelCatalogEntrySchema,
  type EmbeddingModelCatalogEntry
} from './embedding-model-contracts'
import {
  huggingFaceTarget,
  modelScopeTarget
} from '../model-download-targets'

const repository = 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX'
const huggingFaceRevision = '536a9f241cb3f02a9c5995a1e708c784bd274859'
const modelScopeRevision = '2741cd30a7448219ec2699afdf373a44df5aaa33'

export const EMBEDDING_MODEL_CATALOG: readonly EmbeddingModelCatalogEntry[] =
  embeddingModelCatalogEntrySchema.array().parse([
    {
      id: 'granite-embedding-97m-multilingual-r2-int8',
      displayName: 'Granite Embedding 97M Multilingual R2',
      description:
        '面向中文、英文及跨语言检索的 384 维本地 INT8 向量模型。',
      languages: ['200+ languages'],
      runtime: 'onnxruntime-web/wasm',
      dimensions: 384,
      contextTokens: 32_768,
      quantization: 'INT8',
      recommended: true,
      available: true,
      repositoryUrls: {
        modelscope: `https://modelscope.cn/models/${repository}`,
        'hugging-face': `https://huggingface.co/${repository}`
      },
      license: {
        name: 'Apache License 2.0',
        notice:
          '模型由 IBM Granite 发布，ONNX 工件由 ONNX Community 转换，依据 Apache License 2.0 使用。',
        url: 'https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2/blob/main/LICENSE'
      },
      files: [
        {
          name: 'model_quantized.onnx',
          role: 'model',
          size: 97_858_099,
          sha256:
            '704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22',
          targets: {
            modelscope: modelScopeTarget(
              repository,
              modelScopeRevision,
              'onnx/model_quantized.onnx'
            ),
            'hugging-face': huggingFaceTarget(
              repository,
              huggingFaceRevision,
              'onnx/model_quantized.onnx'
            )
          }
        },
        {
          name: 'tokenizer.json',
          role: 'tokenizer',
          size: 25_301_671,
          sha256:
            '51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a',
          targets: {
            modelscope: modelScopeTarget(
              repository,
              modelScopeRevision,
              'tokenizer.json'
            ),
            'hugging-face': huggingFaceTarget(
              repository,
              huggingFaceRevision,
              'tokenizer.json'
            )
          }
        },
        {
          name: 'tokenizer_config.json',
          role: 'tokenizer-configuration',
          size: 12_860,
          sha256:
            '6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5',
          targets: {
            modelscope: modelScopeTarget(
              repository,
              modelScopeRevision,
              'tokenizer_config.json'
            ),
            'hugging-face': huggingFaceTarget(
              repository,
              huggingFaceRevision,
              'tokenizer_config.json'
            )
          }
        },
        {
          name: 'config.json',
          role: 'configuration',
          size: 1_215,
          sha256:
            'ae74d55a56f779774cb9a8e63d3c2da9ae1af83c00229ffdff43d0b38407a0ee',
          targets: {
            modelscope: modelScopeTarget(
              repository,
              modelScopeRevision,
              'config.json'
            ),
            'hugging-face': huggingFaceTarget(
              repository,
              huggingFaceRevision,
              'config.json'
            )
          }
        },
        {
          name: 'special_tokens_map.json',
          role: 'tokenizer-configuration',
          size: 871,
          sha256:
            '013787ee251ff611722479197c00853b62113ad303cb0a36524231783c676c69',
          targets: {
            modelscope: modelScopeTarget(
              repository,
              modelScopeRevision,
              'special_tokens_map.json'
            ),
            'hugging-face': huggingFaceTarget(
              repository,
              huggingFaceRevision,
              'special_tokens_map.json'
            )
          }
        }
      ]
    }
  ])
