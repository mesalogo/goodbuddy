import type { WebSearchTestResult } from '../../shared/capability-contracts'
import {
  ModelToolProvider,
  type ModelToolResultPart
} from '../agent/model-tool-provider'

const TEST_QUERY = 'GoodBuddy desktop assistant'

export async function testWebSearch(
  signal?: AbortSignal
): Promise<WebSearchTestResult> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('联网搜索测试超时')),
    20_000
  )
  const abortFromCaller = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (signal?.aborted) {
    abortFromCaller()
  }
  const provider = new ModelToolProvider(
    process.cwd(),
    [],
    undefined,
    undefined,
    true
  )
  const startedAt = Date.now()
  try {
    const context = {
      conversationId: 'web-search-diagnostic',
      workMode: 'ask' as const
    }
    const tools = await provider.listTools(context, controller.signal)
    if (
      !tools.some((tool) => tool.name === 'web_search') ||
      !tools.some((tool) => tool.name === 'web_fetch')
    ) {
      throw new Error('Exa MCP 未提供所需的联网工具')
    }
    const result = await provider.callTool(
      'web_search',
      { query: TEST_QUERY, numResults: 1 },
      controller.signal,
      context
    )
    const preview = result.parts
      .filter(
        (
          part
        ): part is Extract<ModelToolResultPart, { type: 'text' }> =>
          part.type === 'text'
      )
      .map((part) => part.text)
      .join('\n')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 500)
    if (!preview) {
      throw new Error('联网搜索测试未返回文本结果')
    }
    return {
      provider: 'exa',
      query: TEST_QUERY,
      durationMs: Date.now() - startedAt,
      preview
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new Error('联网搜索测试已取消', { cause: error })
    }
    throw new Error('联网搜索测试失败，请检查网络连接或稍后重试', {
      cause: error
    })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromCaller)
    await provider.dispose()
  }
}
