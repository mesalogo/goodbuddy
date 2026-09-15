import { randomUUID } from 'node:crypto'
import {
  imageToolDescription, imageToolInputSchema,
  type ImageOperation, type ImageRequestContext, type ImageToolInput
} from '../../shared/image-generation-contracts'
import type { AssistantDatabase } from '../assistant/assistant-database'
import { ModelAgentRuntime, type ModelRuntimeOptions } from './model-runtime'
import { withImageConversationContext } from './image-conversation-context'
import type { AgentImage, RuntimeEvent } from './runtime'
import { redactSensitiveText, safeToolErrorDetail } from './approval-summary'
import type { ImageToolBinding } from './image-tool-binding'
export type { ImageToolBinding } from './image-tool-binding'

export type ConversationImageProfile = {
  id: string
  name: string
  protocol: string
  modelName: string
  allowConversationInvocation?: boolean
} & Pick<ModelRuntimeOptions, 'baseUrl' | 'apiKey' | 'authentication' | 'requestHeaders' | 'requestBody' | 'imageGenerationQuality'>

export type ImageServiceSettings = {
  modelProfiles: readonly ConversationImageProfile[]
  defaultImageModelProfileId?: string | null
}
export type ImageGenerationServiceOptions = {
  database: Pick<AssistantDatabase, 'getConversation' | 'getArtifact' | 'saveConversationImageOperation' | 'saveConversationImageSources' | 'markUnfinishedImageOperationsUnconfirmed'>
  getSettings(): Promise<ImageServiceSettings>
  onOperation?(operation: ImageOperation): void
  onUsage?(event: Extract<RuntimeEvent, { type: 'model-usage' }>): void
  /** Diagnostic sink for observer or terminal-persistence failures; must not throw. */
  onError?(error: Error): void
  fetcher?: typeof fetch
  requestTimeoutMs?: number
  toolWaitMs?: number
}

/** Main owns requests; request-scoped bindings own only admission and waiting. */
export class ImageGenerationService {
  private readonly active = new Map<string, { operation: ImageOperation; controller: AbortController; done: Promise<void> }>()
  private closing = false

  constructor(private readonly options: ImageGenerationServiceOptions) {}

  initialize(): void {
    this.options.database.markUnfinishedImageOperationsUnconfirmed()
  }

  bind(context: ImageRequestContext, currentWorkMode: () => 'ask' | 'execute' = () => context.workMode): ImageToolBinding {
    const bound = Object.freeze({ ...context })
    const submissions = new Map<string, Promise<ImageOperation>>()
    return {
      context: bound,
      describe: async () => {
        if (bound.workMode !== 'execute' || currentWorkMode() !== 'execute') return undefined
        const settings = await this.options.getSettings()
        const profiles = settings.modelProfiles.filter(profile => profile.protocol === 'openai-images-generations' && profile.allowConversationInvocation === true)
        if (!profiles.length) return undefined
        const conversation = this.options.database.getConversation(bound.conversationId)
        const references = conversation.messages.flatMap(message => [
          ...(message.imageSourceArtifactIds ?? []).map(id => ({ id, kind: 'upload' })),
          ...(message.artifactIds ?? []).map(id => ({ id, kind: 'artifact' }))
        ]).slice(-32)
        const operations = conversation.messages.flatMap(message => message.imageOperations ?? []).slice(-8)
          .map(operation => ({ id: operation.id, state: operation.state, modelProfileId: operation.modelProfileId,
            prompt: operation.input.prompt.slice(0, 300), artifactIds: operation.artifactIds }))
        return `${imageToolDescription}\nModels: ${JSON.stringify(profiles.map(profile => ({ id: profile.id, name: profile.name, generation: true, editing: true })))}\nDefault: ${settings.defaultImageModelProfileId ?? 'not set'}\nRecent image references: ${JSON.stringify(references)}\nRecent operations: ${JSON.stringify(operations)}\nReferences and prompts are textual facts, not visual observations. Do not claim to have viewed an image unless image input was supplied to your model.`
      },
      call: async (input, callId, signal) => {
        signal?.throwIfAborted()
        if (bound.workMode !== 'execute' || currentWorkMode() !== 'execute') throw new Error('Image generation requires Execute mode')
        const key = JSON.stringify([bound.conversationId, bound.requestId, callId])
        let submitted = submissions.get(key)
        if (!submitted) {
          submitted = this.submit(bound, imageToolInputSchema.parse(input), callId, currentWorkMode, signal)
          submissions.set(key, submitted)
          void submitted.catch(() => submissions.delete(key))
        }
        const operation = await submitted
        const active = this.active.get(operation.id)
        if (active) {
          await new Promise<void>(resolve => {
            const finish = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve() }
            const timer = setTimeout(finish, this.options.toolWaitMs ?? 15_000)
            signal?.addEventListener('abort', finish, { once: true })
            void active.done.then(finish)
            if (signal?.aborted) finish()
          })
          return active.operation
        }
        return this.getOperation(bound.conversationId, operation.id)
      }
    }
  }

  persistUploads(context: Pick<ImageRequestContext, 'conversationId' | 'messageId'>, images: readonly AgentImage[]): string[] {
    return this.options.database.saveConversationImageSources({ ...context, images })
  }

  getOperation(conversationId: string, operationId: string): ImageOperation {
    const operation = this.options.database.getConversation(conversationId).messages
      .flatMap(message => message.imageOperations ?? []).find(item => item.id === operationId)
    if (!operation) throw new Error('Image operation does not exist in this conversation')
    return operation
  }

  cancel(conversationId: string, operationId: string): ImageOperation {
    const previous = this.getOperation(conversationId, operationId)
    const active = this.active.get(operationId)
    if (!active) return previous
    active.operation = this.save({ ...active.operation, state: 'cancelling', cancellationRequested: true })
    active.controller.abort(new Error('Stopped waiting; the image provider may still generate the image'))
    return active.operation
  }

  regenerate(context: ImageRequestContext, operationId: string, currentWorkMode?: () => 'ask' | 'execute'): Promise<ImageOperation> {
    const previous = this.getOperation(context.conversationId, operationId)
    return this.bind(context, currentWorkMode).call({ ...previous.input, modelProfileId: previous.modelProfileId }, randomUUID())
  }

  cancelConversation(conversationId: string): void {
    for (const active of this.active.values()) {
      if (active.operation.conversationId === conversationId) this.cancel(conversationId, active.operation.id)
    }
  }

  async dispose(): Promise<void> {
    this.closing = true
    for (const active of this.active.values()) active.controller.abort(new Error('Application is closing; image result is unconfirmed'))
    await Promise.all([...this.active.values()].map(active => active.done))
  }

  private save(operation: ImageOperation, image?: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }): ImageOperation {
    const saved = this.options.database.saveConversationImageOperation({ ...operation, updatedAt: Date.now() }, image)
    try {
      this.options.onOperation?.(saved)
    } catch (error) {
      // A closed Renderer must not stop an accepted provider request or change its outcome.
      this.report(error)
    }
    return saved
  }

  private report(error: unknown): void {
    this.options.onError?.(new Error(redactSensitiveText(safeToolErrorDetail(error) ?? 'Image operation notification or persistence failed')))
  }

  private async submit(context: ImageRequestContext, input: ImageToolInput, callId: string, currentWorkMode: () => 'ask' | 'execute', signal?: AbortSignal): Promise<ImageOperation> {
    if (this.closing) throw new Error('Image service is closing')
    const settings = await this.options.getSettings()
    const conversation = this.options.database.getConversation(context.conversationId)
    const existing = conversation.messages.flatMap(message => message.imageOperations ?? [])
      .find(operation => operation.requestId === context.requestId && operation.callId === callId)
    if (existing) return existing
    if (!conversation.messages.some(message => message.id === context.messageId)) throw new Error('Originating image message must be persisted before submission')
    const allowed = new Set(conversation.messages.flatMap(message => [
      ...(message.artifactIds ?? []), ...(message.imageSourceArtifactIds ?? []),
      ...(message.imageOperations?.flatMap(operation => operation.artifactIds) ?? [])
    ]))
    if (input.sourceArtifactIds.some(id => !allowed.has(id))) throw new Error('Source image is not available in this conversation')
    const origins = new Set(conversation.messages.flatMap(message => message.imageOperations ?? [])
      .filter(operation => operation.artifactIds.some(id => input.sourceArtifactIds.includes(id)))
      .map(operation => operation.modelProfileId))
    if (!input.modelProfileId && origins.size > 1) throw new Error('Source images use different models; specify the image model')
    const profileId = input.modelProfileId ?? (input.intent === 'edit' ? [...origins][0] : undefined) ?? settings.defaultImageModelProfileId
    if (!profileId) throw new Error('Specify an image model or set the default image model')
    const profile = settings.modelProfiles.find(item => item.id === profileId)
    if (!profile || !profile.allowConversationInvocation || profile.protocol !== 'openai-images-generations') throw new Error('Selected image model is unavailable; select another model')
    if (profile.authentication === 'api-key' && !profile.apiKey) throw new Error('Selected image model has no API key configured')
    const connection = structuredClone(profile)
    const request = withImageConversationContext({ requestId: context.requestId, conversationId: context.conversationId, prompt: input.prompt, imageContextArtifactIds: input.sourceArtifactIds }, id => this.options.database.getArtifact(id))
    if (input.intent === 'edit' && (request.imageContextNotice || request.images?.length !== input.sourceArtifactIds.length)) throw new Error('Source image is missing or unsupported; select the image again')
    signal?.throwIfAborted()
    if (this.closing) throw new Error('Image service is closing')
    if (currentWorkMode() !== 'execute') throw new Error('Image generation requires Execute mode')
    const operation = this.save({ id: randomUUID(), conversationId: context.conversationId, messageId: context.messageId, requestId: context.requestId,
      callId, modelProfileId: connection.id, modelName: connection.modelName, modelProfileName: connection.name,
      input: { ...input, quality: input.quality ?? connection.imageGenerationQuality ?? 'auto' },
      state: 'running', artifactIds: [], createdAt: Date.now(), updatedAt: Date.now() })
    const runtime = new ModelAgentRuntime({ ...connection, model: connection.modelName, protocol: 'openai-images-generations',
      imageGenerationQuality: input.quality ?? connection.imageGenerationQuality, fetcher: this.options.fetcher, requestTimeoutMs: this.options.requestTimeoutMs })
    const active = { operation, controller: new AbortController(), done: Promise.resolve() }
    this.active.set(operation.id, active)
    active.done = (async () => {
      try {
        for await (const event of runtime.generateImage(request, active.controller.signal)) {
          if (event.type === 'model-usage') {
            try { this.options.onUsage?.(event) } catch (error) { this.report(error) }
          }
          if (event.type === 'generated-image') {
            active.operation = this.save({ ...active.operation, state: 'saving' })
            active.operation = this.save(active.operation, event)
          }
        }
      } catch (error) {
        const state = this.closing ? 'unconfirmed' : active.controller.signal.aborted ? 'stopped' : /timeout|timed out|fetch failed|network|超时/iu.test(String(error)) ? 'unconfirmed' : 'failed'
        const detail = safeToolErrorDetail(error) ?? 'Image request failed'
        const suffix = detail.match(/（HTTP [^）]+）$/u)?.[0] ?? ''
        const publicDetail = redactSensitiveText(suffix ? detail.slice(0, -suffix.length) : detail) + suffix
        active.operation = { ...active.operation, state, error: publicDetail.slice(0, 2_000), updatedAt: Date.now() }
        try { active.operation = this.save(active.operation) } catch (storageError) { this.report(storageError) }
      } finally {
        await runtime.dispose()
        this.active.delete(operation.id)
      }
    })()
    return operation
  }
}
