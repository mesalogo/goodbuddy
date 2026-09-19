import { describe, expect, it } from 'vitest'
import type { AgentExecutionRequest, AgentRuntime, RuntimeModelUsageEvent } from '../agent/runtime'
import type {
  MagicNoteEntry,
  MagicNoteAnalysisOptions,
  MagicTodoItem
} from '../../shared/magic-notes-contracts'
import {
  analyzeMagicNoteEntry,
  analyzeMagicNoteDraft,
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
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
  const canvasEntry = {
    ...entry,
    content: {
      version: 2,
      kind: 'paged-canvas',
      pages: ['first', 'second'].map((id, index) => ({
        id, width: 800, height: 1000,
        background: { type: 'template', template: 'blank' }, objects: [{ text: index === 0 ? '目标' : '验收' }]
      })),
      assets: []
    },
    plainText: '第 1 页：目标\n第 2 页：验收'
  } satisfies MagicNoteEntry
  const options: MagicNoteAnalysisOptions = {
    requestId: '00000000-0000-4000-8000-000000000506',
    direction: 'general', format: 'structured',
    canvasImages: ['second', 'first'].map((pageId) => ({
      pageId, dataUrl: `data:image/png;base64,${png}`
    }))
  }

  function recordingRuntime(error?: string) {
    const requests: AgentExecutionRequest[] = []
    const runtime: AgentRuntime = {
      requiresToolApproval: false,
      supportsToolExecution: false,
      async getStatus() {
        return { id: 'model', label: 'Test model', available: true, detail: 'Ready', supportsToolExecution: false }
      },
      async dispose() {},
      async *run(input: AgentExecutionRequest) {
        requests.push(input)
        if (error) {
          yield { requestId: input.requestId, type: 'error', status: 'failed', message: error } as const
          return
        }
        yield { requestId: input.requestId, type: 'text', delta: '{"comments":[{"kind":"summary","content":"明确目标与验收条件。"}]}' } as const
        yield {
          requestId: input.requestId, type: 'model-usage', callId: 'analysis-call',
          runtime: 'model', provider: 'test', model: 'test', inputTokens: 25,
          outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0
        } as const
        yield { requestId: input.requestId, type: 'done' } as const
      }
    }
    return { runtime, requests }
  }

  const canvasTodo: MagicTodoItem = {
    id: '00000000-0000-4000-8000-000000000601',
    noteId: entry.noteId, entryId: entry.id, noteTitle: 'Canvas',
    sourceIndex: 0, source: 'note', title: 'Review release',
    instructions: 'Check acceptance criteria', completed: false,
    comments: [], revision: 0, createdAt: entry.createdAt, updatedAt: entry.updatedAt
  }

  it.each([true, false])('analyzes canvas todos with task text and source context (vision=%s)', async (supportsImageInput) => {
    const { runtime, requests } = recordingRuntime()
    const comments = await analyzeMagicTodo(
      runtime, canvasTodo, options, undefined, undefined,
      { supportsImageInput, content: canvasEntry.content, canvasPageCount: 2 }
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.prompt).toContain(canvasTodo.title)
    expect(requests[0]?.prompt).toContain(canvasTodo.instructions)
    expect(requests[0]?.prompt).toContain('第 2 页：\\n验收')
    expect(requests[0]?.conversationId).toBe(`magic-todos:${canvasTodo.id}`)
    expect(requests[0]?.workMode).toBe('ask')
    if (supportsImageInput) {
      expect(requests[0]?.images).toHaveLength(2)
    } else {
      expect(requests[0]?.images).toBeUndefined()
      expect(requests[0]?.prompt).toContain('未查看页面图像')
    }
    expect(comments[0]?.inputMode).toBe(supportsImageInput ? 'canvas-images' : 'text-fallback')
  })

  it('rejects missing canvas todo captures instead of pretending to see the source', async () => {
    const { runtime, requests } = recordingRuntime()
    await expect(analyzeMagicTodo(
      runtime, canvasTodo, { ...options, canvasImages: undefined }, undefined, undefined,
      { supportsImageInput: true, content: canvasEntry.content }
    )).rejects.toThrow('截图缺失或与当前页面不匹配')
    expect(requests).toHaveLength(0)
  })

  it('keeps legacy todo analysis limited to its title and instructions', async () => {
    const { runtime, requests } = recordingRuntime()
    const comments = await analyzeMagicTodo(
      runtime, canvasTodo, options, undefined, undefined,
      { supportsImageInput: true, content: entry.content }
    )
    expect(requests[0]?.images).toBeUndefined()
    expect(requests[0]?.prompt).toContain(canvasTodo.instructions)
    expect(requests[0]?.prompt).not.toContain(entry.plainText)
    expect(comments[0]?.inputMode).toBe('text')
  })

  it('passes complete composited pages in document order to AgentRuntime with page labels and text', async () => {
    const { runtime, requests } = recordingRuntime()
    const usage: RuntimeModelUsageEvent[] = []
    const comments = await analyzeMagicNoteEntry(
      runtime, canvasEntry, options, undefined,
      (event) => usage.push(event), { supportsImageInput: true, canvasPageCount: 2 }
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.images).toEqual([
      { name: 'page-1.png', mediaType: 'image/png', data: png },
      { name: 'page-2.png', mediaType: 'image/png', data: png }
    ])
    expect(requests[0]?.prompt).toContain('第 1 页 = page-1.png')
    expect(requests[0]?.prompt).toContain('第 2 页 = page-2.png')
    expect(requests[0]?.prompt).toContain('验收')
    expect(requests[0]?.workMode).toBe('ask')
    expect(comments[0]?.inputMode).toBe('canvas-images')
    expect(usage).toEqual([expect.objectContaining({ callId: 'analysis-call', inputTokens: 25 })])
  })

  it('analyzes a visual-only draft using page images', async () => {
    const { runtime, requests } = recordingRuntime()
    const content = {
      ...canvasEntry.content,
      pages: canvasEntry.content.pages.map((page) => ({ ...page, objects: [] }))
    }
    const comments = await analyzeMagicNoteDraft(runtime, '', options, undefined, undefined, { supportsImageInput: true, content })
    expect(requests[0]?.images).toHaveLength(1)
    expect(comments[0]?.inputMode).toBe('canvas-images')
  })

  it('limits both continuous flow and objects to the first page for a text model', async () => {
    const { runtime, requests } = recordingRuntime()
    const content = {
      ...canvasEntry.content,
      pages: canvasEntry.content.pages.map((page, index) => ({
        ...page, objects: [{ text: index === 0 ? '首页结论' : '最后一页的结论' }]
      })),
      flow: { version: 1 as const, ops: [{ insert: '首页正文\n末页正文\n' }] }
    }
    const comments = await analyzeMagicNoteEntry(runtime, { ...canvasEntry, content }, {
      ...options, canvasPageText: [{ pageId: 'first', text: '首页正文\n' }, { pageId: 'second', text: '末页正文\n' }]
    }, undefined, undefined, { supportsImageInput: false })
    expect(requests[0]?.images).toBeUndefined()
    expect(requests[0]?.prompt).toContain('首页正文')
    expect(requests[0]?.prompt).toContain('首页结论')
    expect(requests[0]?.prompt).not.toContain('最后一页的结论')
    expect(requests[0]?.prompt).not.toContain('末页正文')
    expect(requests[0]?.prompt).toContain('未查看页面图像')
    expect(comments[0]?.inputMode).toBe('text-fallback')
  })

  it('rejects incomplete flow page text without sending the full cross-page body', async () => {
    const { runtime, requests } = recordingRuntime()
    const content = { ...canvasEntry.content, flow: { version: 1 as const, ops: [{ insert: 'First and later pages\n' }] } }
    for (const canvasPageText of [undefined, [], [{ pageId: 'second', text: 'Later' }],
      [{ pageId: 'first', text: 'A' }, { pageId: 'first', text: 'B' }]]) {
      await expect(analyzeMagicNoteDraft(runtime, 'Full text', { ...options, canvasPageText }, undefined, undefined,
        { supportsImageInput: false, content })).rejects.toThrow('分页文字缺失')
    }
    expect(requests).toHaveLength(0)
  })

  it('does not use later-page text when the selected first page is visual-only', async () => {
    const { runtime, requests } = recordingRuntime()
    const content = { ...canvasEntry.content, pages: canvasEntry.content.pages.map((page, index) => ({ ...page,
      objects: index === 0 ? [] : [{ text: 'Later-page text' }] })) }
    await expect(analyzeMagicNoteDraft(runtime, 'Later-page text', options, undefined, undefined,
      { supportsImageInput: false, content })).rejects.toThrow('所选画布页中没有')
    expect(requests).toHaveLength(0)
  })

  it('rejects visual-only text fallback before issuing a request', async () => {
    const { runtime, requests } = recordingRuntime()
    const content = {
      ...canvasEntry.content,
      pages: canvasEntry.content.pages.map((page) => ({ ...page, objects: [] })),
      flow: { version: 1 as const, ops: [{ insert: { image: 'placeholder' } }] }
    }
    await expect(analyzeMagicNoteEntry(runtime, { ...canvasEntry, content, plainText: '  ' }, options, undefined, undefined, { supportsImageInput: false, canvasPageCount: 2 })).rejects.toThrow('请切换支持图像输入的默认模型')
    expect(requests).toHaveLength(0)
  })

  it.each([undefined, [], [options.canvasImages![0]!], [options.canvasImages![0]!, options.canvasImages![0]!]])('rejects missing or incomplete canvas captures (%j)', async (canvasImages) => {
    const { runtime, requests } = recordingRuntime()
    await expect(analyzeMagicNoteEntry(runtime, canvasEntry, { ...options, canvasImages }, undefined, undefined, { supportsImageInput: true })).rejects.toThrow('截图缺失或与当前页面不匹配')
    expect(requests).toHaveLength(0)
  })

  it.each(['401 Unauthorized', 'network connection failed', 'context length exceeded'])('preserves provider errors without retrying text-only: %s', async (error) => {
    const { runtime, requests } = recordingRuntime(error)
    await expect(analyzeMagicNoteEntry(runtime, canvasEntry, options, undefined, undefined, { supportsImageInput: true })).rejects.toThrow(error)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.images).toHaveLength(1)
  })

  it('keeps ordinary notes text-only even when the model supports images', async () => {
    const { runtime, requests } = recordingRuntime()
    const comments = await analyzeMagicNoteEntry(runtime, entry, options, undefined, undefined, { supportsImageInput: true })
    expect(requests[0]?.images).toBeUndefined()
    expect(requests[0]?.prompt).toContain(entry.plainText)
    expect(comments[0]?.inputMode).toBe('text')
  })

  it('includes native PDF text with its canvas page number during text fallback', async () => {
    const { runtime, requests } = recordingRuntime()
    const content = {
      ...canvasEntry.content,
      pages: canvasEntry.content.pages.map((page, index) => ({
        ...page,
        background: {
          type: 'pdf' as const, assetId: 'pdf-source',
          pageNumber: index + 10, text: `PDF 原生文字 ${index + 1}`
        }
      }))
    }
    await analyzeMagicNoteDraft(runtime, '', options, undefined, undefined, {
      supportsImageInput: false, content, canvasPageCount: 2
    })
    expect(requests[0]?.prompt).toContain('第 2 页：\\nPDF 原生文字 2')
    expect(requests[0]?.images).toBeUndefined()
  })

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
      {
        requestId: '00000000-0000-4000-8000-000000000506',
        direction: 'general',
        format: 'structured'
      }
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
        {
          requestId: '00000000-0000-4000-8000-000000000507',
          direction: 'general',
          format: 'structured'
        }
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
        {
          requestId: '00000000-0000-4000-8000-000000000604',
          direction: 'general',
          format: 'structured'
        }
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

  it('streams the narrative and snapshots combined comment options', async () => {
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
        yield {
          requestId: input.requestId,
          type: 'text',
          delta: '可以先扩展目标读者，'
        } as const
        yield {
          requestId: input.requestId,
          type: 'text',
          delta:
            '再补充一个实际例子。\n<<<GOODBUDDY_STRUCTURED_COMMENTS>>>\n'
        } as const
        yield {
          requestId: input.requestId,
          type: 'text',
          delta:
            '{"comments":[{"kind":"suggestion","content":"补充一个读者场景。"}]}'
        } as const
        yield { requestId: input.requestId, type: 'done' } as const
      },
      async dispose() {}
    } as AgentRuntime
    const deltas: string[] = []

    const result = await analyzeMagicNoteEntry(
      runtime,
      entry,
      {
        requestId: '00000000-0000-4000-8000-000000000508',
        direction: 'expand',
        format: 'combined'
      },
      (delta) => deltas.push(delta)
    )

    expect(deltas.join('')).toBe(
      '可以先扩展目标读者，再补充一个实际例子。\n'
    )
    expect(result).toEqual([
      expect.objectContaining({
        kind: 'narrative',
        direction: 'expand',
        format: 'combined'
      }),
      expect.objectContaining({
        kind: 'suggestion',
        content: '补充一个读者场景。',
        direction: 'expand',
        format: 'combined'
      })
    ])
  })
})
