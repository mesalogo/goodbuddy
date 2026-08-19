import {
  documentOcrModelCatalogEntrySchema,
  type DocumentOcrModelCatalogEntry
} from '../shared/document-parsing-contracts'
import {
  huggingFaceTarget,
  modelScopeTarget
} from './model-download-targets'

const repositories = {
  tinyDetection: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx',
  tinyRecognition: 'PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
  smallDetection: 'PaddlePaddle/PP-OCRv6_small_det_onnx',
  smallRecognition: 'PaddlePaddle/PP-OCRv6_small_rec_onnx',
  mediumDetection: 'PaddlePaddle/PP-OCRv6_medium_det_onnx',
  mediumRecognition: 'PaddlePaddle/PP-OCRv6_medium_rec_onnx'
} as const

const modelScopeRevisions = {
  tinyDetection: '7d7f5d128d9309ebf6de4f21f404dd583afdbae3',
  tinyRecognition: 'afba04b618200c5f4824531c6e42c957c6439d9a',
  smallDetection: '956a0b620a4017cc04056c692be1703b0025d028',
  smallRecognition: '296d43bc0ebced0fd9c605174aa5962e49810ab6',
  mediumDetection: 'c317b40325be40bfaaff58c8dcece2a075294f8a',
  mediumRecognition: 'db5d610d492a14e3c34dc1fd4e9339bd369f79e6'
} as const

const huggingFaceRevisions = {
  tinyDetection: '2ba1506c0380b8f0b03dd142459aac66d4421f6c',
  tinyRecognition: '2612ab37152ae0a677521bae4e1e3d4fb4cf7c30',
  smallDetection: '28fe5895c24fd108c19eb3e8479f4ab385fbfc62',
  smallRecognition: 'b8f84f0b80c529de40b4fbb3544b84fa7233a513',
  mediumDetection: '61323801669c338b7891481ec7bac61ce31b576a',
  mediumRecognition: '50c7eacafc52fa7bcf4194e8cd08e46f8558504b'
} as const

type RepositoryKey = keyof typeof repositories

function targets(
  repositoryKey: RepositoryKey,
  file: string
) {
  const repository = repositories[repositoryKey]
  return {
    modelscope: modelScopeTarget(
      repository,
      modelScopeRevisions[repositoryKey],
      file
    ),
    'hugging-face': huggingFaceTarget(
      repository,
      huggingFaceRevisions[repositoryKey],
      file
    )
  }
}

function repositoryUrls(repositoryKey: RepositoryKey) {
  const repository = repositories[repositoryKey]
  return {
    modelscope: `https://modelscope.cn/models/${repository}`,
    'hugging-face': `https://huggingface.co/${repository}`
  }
}

export const DOCUMENT_OCR_MODEL_CATALOG: readonly DocumentOcrModelCatalogEntry[] =
  documentOcrModelCatalogEntrySchema.array().parse([
    {
      id: 'pp-ocrv6-tiny',
      displayName: 'PP-OCRv6 Tiny',
      description:
        'PaddleOCR 官方轻量中文 OCR 模型，适合扫描 PDF 和图片的本地 CPU 识别。',
      languages: ['中文', '英语'],
      runtime: 'onnxruntime-web-wasm',
      quality: 'basic',
      speed: 'fast',
      recommended: false,
      repositoryUrls: repositoryUrls('tinyRecognition'),
      license: {
        name: 'Apache License 2.0',
        notice:
          '检测与识别模型由 PaddlePaddle 官方发布，使用前请阅读模型仓库及 PaddleOCR 的许可证说明。',
        url: 'https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE'
      },
      files: [
        {
          name: 'detection.onnx',
          role: 'detection',
          size: 1_780_590,
          sha256:
            '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8',
          targets: targets('tinyDetection', 'inference.onnx')
        },
        {
          name: 'recognition.onnx',
          role: 'recognition',
          size: 4_462_639,
          sha256:
            '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6',
          targets: targets('tinyRecognition', 'inference.onnx')
        },
        {
          name: 'dictionary.yml',
          role: 'dictionary',
          size: 55_571,
          sha256:
            '66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1',
          targets: targets('tinyRecognition', 'inference.yml')
        }
      ]
    },
    {
      id: 'pp-ocrv6-small',
      displayName: 'PP-OCRv6 Small',
      description:
        'PaddleOCR 官方 50 语言 OCR 模型，在识别质量、速度和本地资源占用之间取得平衡。',
      languages: ['50 种语言'],
      runtime: 'onnxruntime-web-wasm',
      quality: 'balanced',
      speed: 'balanced',
      recommended: true,
      repositoryUrls: repositoryUrls('smallRecognition'),
      license: {
        name: 'Apache License 2.0',
        notice:
          '检测与识别模型由 PaddlePaddle 官方发布，使用前请阅读模型仓库及 PaddleOCR 的许可证说明。',
        url: 'https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE'
      },
      files: [
        {
          name: 'detection.onnx',
          role: 'detection',
          size: 9_880_512,
          sha256:
            'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e',
          targets: targets('smallDetection', 'inference.onnx')
        },
        {
          name: 'recognition.onnx',
          role: 'recognition',
          size: 21_159_378,
          sha256:
            '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634',
          targets: targets('smallRecognition', 'inference.onnx')
        },
        {
          name: 'dictionary.yml',
          role: 'dictionary',
          size: 150_579,
          sha256:
            'ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1',
          targets: targets('smallRecognition', 'inference.yml')
        }
      ]
    },
    {
      id: 'pp-ocrv6-medium',
      displayName: 'PP-OCRv6 Medium',
      description:
        'PaddleOCR 官方 50 语言高质量 OCR 模型，识别较慢，并需要更多内存且具有更高延迟。',
      languages: ['50 种语言'],
      runtime: 'onnxruntime-web-wasm',
      quality: 'high',
      speed: 'slow',
      recommended: false,
      repositoryUrls: repositoryUrls('mediumRecognition'),
      license: {
        name: 'Apache License 2.0',
        notice:
          '检测与识别模型由 PaddlePaddle 官方发布，使用前请阅读模型仓库及 PaddleOCR 的许可证说明。',
        url: 'https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE'
      },
      files: [
        {
          name: 'detection.onnx',
          role: 'detection',
          size: 62_032_837,
          sha256:
            'eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1',
          targets: targets('mediumDetection', 'inference.onnx')
        },
        {
          name: 'recognition.onnx',
          role: 'recognition',
          size: 76_554_979,
          sha256:
            '9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba',
          targets: targets('mediumRecognition', 'inference.onnx')
        },
        {
          name: 'dictionary.yml',
          role: 'dictionary',
          size: 150_580,
          sha256:
            '991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129',
          targets: targets('mediumRecognition', 'inference.yml')
        }
      ]
    }
  ])
