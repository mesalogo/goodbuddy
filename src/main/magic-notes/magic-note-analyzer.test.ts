import { describe, expect, it } from 'vitest'
import type { AgentExecutionRequest, AgentRuntime } from '../agent/runtime'
import type {
  MagicNoteEntry,
  MagicTodoItem
} from '../../shared/magic-notes-contracts'
import {
  analyzeMagicNoteEntry,
  analyzeMagicTodo
} from './magic-note-analyzer'

const entry: MagicNoteEntry = {
  id: '00000000-0000-4000-8000-000000000501',
  noteId: '00000000-0000-4000-8000-000000000502',
  content: { version: 1, ops: [{ insert: '周五前整理发布清单\n' }] },
  plainText: '周五前整理发布清单',
  comments: [],
  revision: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
}

describe('magic note analyzer', () => {
  it('uses ask mode and converts bounded JSON into comments only', async () => {
    let request: AgentExecutionRequest | undefined
    const runtime = {
      requiresToolApproval: false,
      supportsToolExecution: false,
      async getStatus() {
        return {
          id: 'model',
          label: 'Test model',
          available: true,
          detail: 'Ready',
          supportsToolExecution: false
        } as const
      },
      async *run(input: AgentExecutionRequest) {
        request = input
        yield {
          requestId: input.requestId,
          type: 'text',
          delta:
            '```json\n{"comments":[{"kind":"suggestion","content":"先列出发布检查项。"}]}\n```'
        } as const
        yield { requestId: input.requestId, type: 'done' } as const
      },
      async dispose() {}
    } as AgentRuntime

    const result = await analyzeMagicNoteEntry(
      runtime,
      entry,
      '00000000-0000-4000-8000-000000000506'
    )

    expect(request).toMatchObject({
      workMode: 'ask',
      knowledgeLibraryIds: []
    })
    expect(request?.trustedInstructions).toContain('禁止工具调用')
    expect(result).toEqual([
      expect.objectContaining({
        kind: 'suggestion',
        content: '先列出发布检查项。'
      })
    ])
    expect(request?.prompt).toContain('不创建待办')
  })

  it('does not analyze image-only records', async () => {
    const runtime = {} as AgentRuntime
    await expect(
      analyzeMagicNoteEntry(
        runtime,
        {
          ...entry,
          plainText: ''
        },
        '00000000-0000-4000-8000-000000000507'
      )
    ).rejects.toThrow('没有可供 AI 分析的文字')
  })

  it('analyzes a magic todo as comments without tool access', async () => {
    let request: AgentExecutionRequest | undefined
    const runtime = {
      requiresToolApproval: false,
      supportsToolExecution: false,
      async getStatus() {
        return {
          id: 'model',
          label: 'Test model',
          available: true,
          detail: 'Ready',
          supportsToolExecution: false
        } as const
      },
      async *run(input: AgentExecutionRequest) {
        request = input
        yield {
          requestId: input.requestId,
          type: 'text',
          delta:
            '{"comments":[{"kind":"warning","content":"验收条件还不够明确。"}]}'
        } as const
        yield { requestId: input.requestId, type: 'done' } as const
      },
      async dispose() {}
    } as AgentRuntime
    const todo: MagicTodoItem = {
      id: '00000000-0000-4000-8000-000000000601',
      noteId: '00000000-0000-4000-8000-000000000602',
      entryId: '00000000-0000-4000-8000-000000000603',
      noteTitle: '发布笔记',
      sourceIndex: 0,
      source: 'note',
      title: '整理发布清单',
      instructions: '核对版本、说明和构建产物。',
      completed: false,
      comments: [],
      revision: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    }

    await expect(
      analyzeMagicTodo(
        runtime,
        todo,
        '00000000-0000-4000-8000-000000000604'
      )
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'warning',
        content: '验收条件还不够明确。'
      })
    ])
    expect(request?.workMode).toBe('ask')
    expect(request?.trustedInstructions).toContain('禁止工具调用')
  })
})
