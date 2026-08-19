import {
  MODEL_DOWNLOAD_REDIRECT_HOSTS,
  type ModelArtifactTarget
} from '../shared/model-download-contracts'

export function modelScopeTarget(
  repository: string,
  revision: string,
  file: string
): ModelArtifactTarget {
  const repositoryUrl = `https://modelscope.cn/models/${repository}`
  return {
    url: `${repositoryUrl}/resolve/${revision}/${file}`,
    repositoryUrl,
    revision,
    redirectHosts: []
  }
}

export function huggingFaceTarget(
  repository: string,
  revision: string,
  file: string
): ModelArtifactTarget {
  const repositoryUrl = `https://huggingface.co/${repository}`
  return {
    url: `${repositoryUrl}/resolve/${revision}/${file}`,
    repositoryUrl,
    revision,
    redirectHosts: [
      ...MODEL_DOWNLOAD_REDIRECT_HOSTS['hugging-face']
    ]
  }
}
