import { nativeImage } from 'electron'
import type { AssistantArtifact } from '../../shared/assistant-contracts'
import type { AgentExecutionRequest, AgentImage } from './runtime'

export function withImageConversationContext(
  request: AgentExecutionRequest,
  getArtifact: (id: string) => AssistantArtifact
): AgentExecutionRequest {
  if (request.images?.length || !request.imageContextArtifactIds?.length) {
    return request
  }
  const images: AgentImage[] = []
  let missing = false
  for (const id of request.imageContextArtifactIds) {
    let artifact: AssistantArtifact
    try {
      artifact = getArtifact(id)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '成果不存在') {
        throw error
      }
      missing = true
      continue
    }
    const match = artifact.kind === 'image'
      ? artifact.content?.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/u)
      : undefined
    if (!match) {
      missing = true
      continue
    }
    if (match[1] === 'image/webp') {
      const image = nativeImage.createFromBuffer(Buffer.from(match[2]!, 'base64'))
      if (image.isEmpty()) {
        missing = true
        continue
      }
      images.push({
        name: `${artifact.id}.png`,
        mediaType: 'image/png',
        data: image.toPNG().toString('base64')
      })
    } else {
      images.push({
        name: `${artifact.id}.${match[1] === 'image/png' ? 'png' : 'jpg'}`,
        mediaType: match[1] as AgentImage['mediaType'],
        data: match[2]!
      })
    }
  }
  return {
    ...request,
    images: images.length ? images : undefined,
    ...(missing ? { imageContextNotice: 'reference-unavailable' as const } : {})
  }
}
