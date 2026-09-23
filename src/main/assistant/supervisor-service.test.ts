import { describe, expect, it, vi } from 'vitest'
import type {
  SupervisionEvidence,
  SupervisionRunRequest
} from '../../shared/supervision-contracts'
import { SupervisorService } from './supervisor-service'

const request: SupervisionRunRequest = {
  trigger: 'manual',
  scope: { kind: 'global' },
  timeRange: {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-22T00:00:00.000Z'
  }
}

const evidence: SupervisionEvidence[] = [
  {
    id: 'conversation-1',
    sourceType: 'conversation',
    sourceId: 'conversation-1',
    title: 'Story Graph 讨论',
    content: '确定监督者统一入口。',
    occurredAt: '2026-09-21T10:00:00.000Z'
  }
]

const output = {
  summary: '监督者统一入口已经确定。',
  changeDigest: '新增统一运行领域层。',
  openItems: ['接入 SQLite'],
  events: [
    {
      title: '确定统一入口',
      description: '监督者复用心跳触发。',
      occurredAt: '2026-09-21T10:00:00.000Z',
      eventType: 'decision' as const,
      entityIds: ['supervisor'],
      sourceReferenceIds: ['conversation-1']
    }
  ],
  entities: [
    {
      id: 'supervisor',
      label: '监督者',
      description: '统一的智能 Agent 应用。',
      sourceReferenceIds: ['conversation-1']
    }
  ],
  entityChanges: [],
  relations: []
}

describe('SupervisorService', () => {
  it('rejects invented persisted identities even when a local model id matches', async () => {
    const id = '00000000-0000-4000-8000-000000000001'
    const save = vi.fn()
    const service = new SupervisorService({ collect: async () => evidence },
      { summarize: async () => ({ ...output, events: [], entities: [{ ...output.entities[0], id, persistedId: id }] }) },
      { candidates: async () => [], save })
    await expect(service.run(request)).rejects.toThrow('候选集')
    expect(save).not.toHaveBeenCalled()
  })
  it('shares bounded evidence and stores a validated result', async () => {
    const collect = vi.fn(async () => evidence)
    const summarize = vi.fn(async () => JSON.stringify(output))
    const save = vi.fn(async () => undefined)
    const service = new SupervisorService(
      { collect },
      { summarize },
      { save }
    )

    const result = await service.run(request)

    expect(result.output.summary).toBe(output.summary)
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ evidence, outputContract: expect.stringContaining('local entity id'),
        systemInstruction: expect.stringContaining('Entity IDs are local to this output') })
    )
    expect(save).toHaveBeenCalledWith(result)
  })

  it('rejects references outside the frozen evidence set', async () => {
    const invalidOutput = {
      ...output,
      events: output.events.map((event) => ({
        ...event,
        sourceReferenceIds: ['outside-scope']
      }))
    }
    const service = new SupervisorService(
      { collect: async () => evidence },
      { summarize: async () => invalidOutput },
      { save: async () => undefined }
    )

    await expect(service.run(request)).rejects.toThrow(
      '监督者结果引用了本次范围之外的来源'
    )
  })

  it('rejects relations that point to missing entities', async () => {
    const invalidOutput = {
      ...output,
      relations: [
        {
          fromEntityId: 'supervisor',
          toEntityId: 'missing-entity',
          relationType: 'related' as const,
          reason: '测试',
          sourceReferenceIds: ['conversation-1']
        }
      ]
    }
    const service = new SupervisorService(
      { collect: async () => evidence },
      { summarize: async () => invalidOutput },
      { save: async () => undefined }
    )

    await expect(service.run(request)).rejects.toThrow(
      '监督者结果引用了不存在的知识实体'
    )
  })
})
