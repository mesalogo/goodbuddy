import { z } from 'zod'

export const inferenceServiceIdSchema = z.enum(['asr', 'ocr', 'embedding', 'tts'])
export const inferenceActionSchema = z.object({
  serviceId: inferenceServiceIdSchema,
  action: z.enum(['start', 'stop', 'restart']),
  confirmedTaskIds: z.array(z.string().max(200)).max(256).default([])
}).strict()
export const inferenceCancelSchema = z.object({ taskId: z.string().min(1).max(200) }).strict()
export type InferenceServiceId = z.infer<typeof inferenceServiceIdSchema>
export type InferenceAction = z.infer<typeof inferenceActionSchema>
export type InferenceTask = {
  id: string
  serviceId: InferenceServiceId
  source: string
  model?: string
  state: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  startedAt: number
  finishedAt?: number
  error?: string
  cancelUnavailableReason?: string
}
export type InferenceResources =
  | { scope: 'unavailable'; reason: string }
  | {
    scope: 'service-process'
    pid: number
    sampledAt: number
    cpuPercent?: number
    cpuUnavailableReason?: string
    workingSetBytes?: number
    memoryUnavailableReason?: string
  }
export type InferenceService = {
  id: InferenceServiceId
  name: string
  engine: string
  ownership: 'request-worker' | 'renderer-worker' | 'managed-process' | 'unavailable'
  state: 'idle' | 'running' | 'starting' | 'stopping' | 'stopped' | 'error' | 'unavailable' | 'unknown'
  model?: string
  detail: string
  error?: string
  actions: InferenceAction['action'][]
  resources?: InferenceResources
}
export type LocalInferenceSnapshot = {
  services: InferenceService[]
  tasks: InferenceTask[]
  externalConnections?: { id: string; name: string; model: string }[]
}
export type LocalInferenceApi = {
  openSettings: (category?: 'model' | 'document-parsing') => Promise<void>
  getSnapshot: () => Promise<LocalInferenceSnapshot>
  act: (input: InferenceAction) => Promise<void>
  cancel: (taskId: string) => Promise<void>
}
