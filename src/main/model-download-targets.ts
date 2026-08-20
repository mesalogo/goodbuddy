import {
  MODEL_DOWNLOAD_REDIRECT_HOSTS,
  type ModelArtifactFingerprint,
  type ModelArtifactTarget
} from '../shared/model-download-contracts'

export function modelScopeTarget(
  repository: string,
  revision: string,
  file: string,
  fingerprint?: ModelArtifactFingerprint
): ModelArtifactTarget {
  const repositoryUrl = `https://modelscope.cn/models/${repository}`
  return {
    ...fingerprint,
    url: `${repositoryUrl}/resolve/${revision}/${file}`,
    repositoryUrl,
    revision,
    redirectHosts: [
      ...MODEL_DOWNLOAD_REDIRECT_HOSTS.modelscope
    ]
  }
}

export function huggingFaceTarget(
  repository: string,
  revision: string,
  file: string,
  fingerprint?: ModelArtifactFingerprint
): ModelArtifactTarget {
  const repositoryUrl = `https://huggingface.co/${repository}`
  return {
    ...fingerprint,
    url: `${repositoryUrl}/resolve/${revision}/${file}`,
    repositoryUrl,
    revision,
    redirectHosts: [
      ...MODEL_DOWNLOAD_REDIRECT_HOSTS['hugging-face']
    ]
  }
}
