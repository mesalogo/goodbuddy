import { describe, expect, it } from 'vitest'
import {
  knowledgeTaskActionInputSchema,
  knowledgeTaskItemSchema
} from './knowledge-task-contracts'

const task = {
  id: '11111111-1111-4111-8111-111111111111',
  libraryId: 'library-1',
  documentName: '产品手册',
  scope: 'source',
  kind: 'source-sync',
  stage: 'parsing',
  status: 'running',
  progress: 40,
  completedItems: 2,
  totalItems: 5,
  attempt: 1,
  canCancel: true,
  canRetry: false,
  createdAt: '2026-08-12T08:00:00.000Z',
  startedAt: '2026-08-12T08:00:01.000Z',
  updatedAt: '2026-08-12T08:00:02.000Z'
} as const

describe('knowledge task contracts', () => {
  it('accepts an active scoped processing task', () => {
    expect(knowledgeTaskItemSchema.parse(task)).toEqual(task)
  })

  it('requires terminal and failed task details', () => {
    expect(() =>
      knowledgeTaskItemSchema.parse({
        ...task,
        status: 'failed',
        canCancel: false,
        canRetry: true
      })
    ).toThrow()
    expect(
      knowledgeTaskItemSchema.parse({
        ...task,
        status: 'failed',
        progress: 75,
        error: {
          message: '文档解析失败',
          remedy: '检查文件后重试'
        },
        canCancel: false,
        canRetry: true,
        completedAt: '2026-08-12T08:01:00.000Z',
        updatedAt: '2026-08-12T08:01:00.000Z'
      }).error
    ).toEqual({
      message: '文档解析失败',
      remedy: '检查文件后重试'
    })
  })

  it('validates bounded task action identifiers', () => {
    expect(
      knowledgeTaskActionInputSchema.parse({
        taskId: '22222222-2222-4222-8222-222222222222'
      })
    ).toEqual({
      taskId: '22222222-2222-4222-8222-222222222222'
    })
    expect(() =>
      knowledgeTaskActionInputSchema.parse({ taskId: 'not-a-uuid' })
    ).toThrow()
  })
})
