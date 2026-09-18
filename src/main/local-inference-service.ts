import { randomUUID } from 'node:crypto'
import {
  inferenceActionSchema,
  type InferenceAction,
  type InferenceService,
  type InferenceServiceId,
  type InferenceTask,
  type LocalInferenceSnapshot
} from '../shared/local-inference-contracts'

type Adapter = {
  snapshot: () => InferenceService | Promise<InferenceService>
  act?: (action: InferenceAction['action']) => Promise<void>
}

const inventory: InferenceService[] = [
  { id: 'asr', name: '语音识别', engine: 'sherpa-onnx', ownership: 'request-worker', state: 'unavailable', detail: '语音服务尚未初始化。', actions: [] },
  { id: 'ocr', name: '文字识别', engine: 'PaddleOCR / ONNX Web', ownership: 'renderer-worker', state: 'unknown', detail: '模型由文档解析按需加载，空闲 60 秒自动释放。', actions: [] },
  { id: 'embedding', name: '向量生成', engine: 'Granite / ONNX', ownership: 'managed-process', state: 'unavailable', detail: '内置向量提供方尚未初始化；请在设置中安装内置模型并启用内置向量连接。外部向量端点由外部管理，本页不控制其进程。', actions: [] },
  { id: 'tts', name: '语音合成', engine: '未接入', ownership: 'unavailable', state: 'unavailable', detail: '当前版本没有语音合成执行服务。', actions: [] }
]

export class LocalInferenceService {
  private readonly adapters = new Map<InferenceServiceId, Adapter>()
  private readonly tasks = new Map<string, InferenceTask>()
  private readonly cancellations = new Map<string, () => void>()
  private readonly operations = new Set<InferenceServiceId>()

  register(id: InferenceServiceId, adapter: Adapter): () => void {
    this.adapters.set(id, adapter)
    return () => { if (this.adapters.get(id) === adapter) this.adapters.delete(id) }
  }

  async snapshot(): Promise<LocalInferenceSnapshot> {
    const services = await Promise.all(inventory.map(async (fallback) => {
      try {
        return await this.adapters.get(fallback.id)?.snapshot() ?? {
          ...fallback, resources: { scope: 'unavailable' as const, reason: fallback.id === 'tts' ? '尚未接入执行服务' : '服务尚未初始化' }
        }
      } catch (error) {
        return { ...fallback, state: 'error' as const, error: String(error), actions: [] }
      }
    }))
    return { services, tasks: [...this.tasks.values()].map((task) => ({ ...task })).reverse() }
  }

  async run<T>(
    serviceId: InferenceServiceId,
    source: string,
    work: (markCancelling: () => void) => Promise<T>,
    options: { cancel?: () => void; model?: string; cancelUnavailableReason?: string } = {}
  ): Promise<T> {
    if (this.operations.has(serviceId)) throw new Error('服务正在切换状态，请稍后重试')
    const id = randomUUID()
    const task: InferenceTask = {
      id, serviceId, source, model: options.model, state: 'running', startedAt: Date.now(),
      cancelUnavailableReason: options.cancel ? undefined : options.cancelUnavailableReason ?? '该引擎未提供独立任务取消接口。'
    }
    this.tasks.set(id, task)
    if (options.cancel) this.cancellations.set(id, options.cancel)
    try {
      const result = await work(() => {
        if (task.finishedAt === undefined) task.state = 'cancelling'
      })
      task.state = 'completed'
      return result
    } catch (error) {
      task.state = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed'
      task.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      task.finishedAt = Date.now()
      this.cancellations.delete(id)
      const finished = [...this.tasks.values()].filter((entry) => entry.finishedAt !== undefined)
      for (const entry of finished.slice(0, Math.max(0, finished.length - 100))) this.tasks.delete(entry.id)
    }
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task || task.finishedAt !== undefined) return
    if (task.state === 'cancelling') return
    const cancel = this.cancellations.get(taskId)
    if (!cancel) throw new Error(task.cancelUnavailableReason)
    cancel()
    task.state = 'cancelling'
  }

  async act(input: InferenceAction): Promise<void> {
    const request = inferenceActionSchema.parse(input)
    const adapter = this.adapters.get(request.serviceId)
    if (!adapter?.act) throw new Error('该服务不支持手动进程控制')
    if (this.operations.has(request.serviceId)) throw new Error('服务操作正在进行')
    this.operations.add(request.serviceId)
    try {
      const state = await adapter.snapshot()
      if (!state.actions.includes(request.action)) throw new Error('当前状态不支持此操作')
      const active = [...this.tasks.values()].filter((task) => task.serviceId === request.serviceId && task.finishedAt === undefined)
      if (request.action !== 'start' && active.some((task) => !request.confirmedTaskIds.includes(task.id))) {
        throw new Error('使用此服务的任务已变化，请刷新并重新确认影响')
      }
      await adapter.act(request.action)
    } finally {
      this.operations.delete(request.serviceId)
    }
  }
}

export const localInferenceService = new LocalInferenceService()
