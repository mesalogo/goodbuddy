import { describe, expect, it, vi } from 'vitest'
import { LocalInferenceService } from './local-inference-service'
import type { InferenceService } from '../shared/local-inference-contracts'

const service: InferenceService = { id: 'embedding', name: 'Embedding', engine: 'ONNX', ownership: 'managed-process', state: 'running', detail: '', actions: ['stop', 'restart'] }

describe('local inference management', () => {
  it('does not infer service readiness from an active ASR request', async () => {
    const registry = new LocalInferenceService()
    registry.register('asr', { snapshot: () => ({ ...service, id: 'asr', state: 'unknown', actions: [] }) })
    let finish!: () => void
    const work = registry.run('asr', 'speech', () => new Promise<void>((resolve) => { finish = resolve }))
    expect((await registry.snapshot()).services.find((entry) => entry.id === 'asr')?.state).toBe('unknown')
    finish()
    await work
  })

  it('requires confirmation of every current task and blocks new work during stop', async () => {
    const registry = new LocalInferenceService()
    let finish!: () => void
    const work = registry.run('embedding', 'index', () => new Promise<void>((resolve) => { finish = resolve }))
    const act = vi.fn(async () => {
      await expect(registry.run('embedding', 'new query', async () => [])).rejects.toThrow('切换')
      finish()
    })
    registry.register('embedding', { snapshot: () => service, act })
    await expect(registry.act({ serviceId: 'embedding', action: 'stop', confirmedTaskIds: [] })).rejects.toThrow('重新确认')
    expect(act).not.toHaveBeenCalled()
    const task = (await registry.snapshot()).tasks[0]!
    await registry.act({ serviceId: 'embedding', action: 'stop', confirmedTaskIds: [task.id] })
    await work
    expect(act).toHaveBeenCalledOnce()
  })

  it('waits for cancellation acknowledgement and preserves natural completion', async () => {
    const registry = new LocalInferenceService()
    let finish!: () => void
    const cancel = vi.fn()
    const work = registry.run('asr', 'speech', () => new Promise<void>((resolve) => { finish = resolve }), { cancel })
    const id = (await registry.snapshot()).tasks[0]!.id
    registry.cancel(id)
    registry.cancel(id)
    expect(cancel).toHaveBeenCalledOnce()
    expect((await registry.snapshot()).tasks[0]!.state).toBe('cancelling')
    finish()
    await work
    expect((await registry.snapshot()).tasks[0]!.state).toBe('completed')
  })

  it('records real failures, bounds history, and isolates unavailable engines', async () => {
    const registry = new LocalInferenceService()
    registry.register('asr', { snapshot: () => { throw new Error('missing model') } })
    for (let index = 0; index < 103; index++) await registry.run('embedding', 'query', async () => [])
    await expect(registry.run('ocr', 'document', async () => { throw new Error('OCR failed') })).rejects.toThrow('OCR failed')
    const snapshot = await registry.snapshot()
    expect(snapshot.tasks).toHaveLength(100)
    expect(snapshot.tasks[0]).toMatchObject({ state: 'failed', error: 'OCR failed' })
    expect(snapshot.services.find((entry) => entry.id === 'asr')).toMatchObject({ state: 'error', error: 'Error: missing model' })
    expect(snapshot.services.find((entry) => entry.id === 'tts')).toMatchObject({ state: 'unavailable', actions: [] })
  })
})
