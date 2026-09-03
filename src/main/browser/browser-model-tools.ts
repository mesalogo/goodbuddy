import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { builtinModelTools } from '../../shared/builtin-model-tools'
import type {
  ModelToolDefinition,
  ModelToolResult
} from '../agent/model-tool-provider'
import type { RuntimeApprovalRequest } from '../agent/runtime'
import { canonicalizeBrowserUrl } from './browser-url-policy'
import type { BrowserService } from './browser-service'
import {
  MAX_BROWSER_INPUT_LENGTH as MAX_INPUT_LENGTH,
  MAX_BROWSER_SELECT_LENGTH as MAX_SELECT_LENGTH
} from './browser-limits'

const MAX_REF_LENGTH = 64

const refSchema = z
  .string()
  .min(1)
  .max(MAX_REF_LENGTH)
  .regex(/^b_[A-Za-z0-9_-]{1,61}$/u, '元素引用格式无效')

export const browserNavigateInputSchema = z
  .object({
    url: z.string().min(1).max(8_192)
  })
  .strict()

export const browserSnapshotInputSchema = z.object({}).strict()

export const browserClickInputSchema = z
  .object({
    ref: refSchema
  })
  .strict()

export const browserTypeInputSchema = z
  .object({
    ref: refSchema,
    text: z.string().min(1).max(MAX_INPUT_LENGTH)
  })
  .strict()

export const browserSelectInputSchema = z
  .object({
    ref: refSchema,
    value: z.string().min(1).max(MAX_SELECT_LENGTH)
  })
  .strict()

export const browserBackInputSchema = z.object({}).strict()
export const browserScreenshotInputSchema = z.object({}).strict()

export type BrowserToolName =
  | 'browser_navigate'
  | 'browser_snapshot'
  | 'browser_click'
  | 'browser_type'
  | 'browser_select'
  | 'browser_back'
  | 'browser_screenshot'

export const browserToolNames = Object.freeze(
  builtinModelTools
    .filter((tool) => tool.group === 'browser')
    .map((tool) => tool.name as BrowserToolName)
)

function getBrowserToolMetadata(name: BrowserToolName) {
  const summary = builtinModelTools.find((tool) => tool.name === name)
  if (!summary) {
    throw new Error(`缺少内置浏览器工具定义：${name}`)
  }
  return {
    name,
    displayName: summary.displayName,
    description: summary.description,
    source: 'builtin' as const
  }
}

const definitions = [
  {
    ...getBrowserToolMetadata('browser_navigate'),
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          minLength: 1,
          maxLength: 8_192,
          description: '当前设备可连接的完整 HTTP 或 HTTPS URL'
        }
      },
      required: ['url'],
      additionalProperties: false
    },
  },
  {
    ...getBrowserToolMetadata('browser_snapshot'),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    ...getBrowserToolMetadata('browser_click'),
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          pattern: '^b_[A-Za-z0-9_-]{1,61}$',
          maxLength: MAX_REF_LENGTH
        }
      },
      required: ['ref'],
      additionalProperties: false
    }
  },
  {
    ...getBrowserToolMetadata('browser_type'),
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          pattern: '^b_[A-Za-z0-9_-]{1,61}$',
          maxLength: MAX_REF_LENGTH
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_INPUT_LENGTH,
          description: '要输入的文本（审批界面不会显示内容）'
        }
      },
      required: ['ref', 'text'],
      additionalProperties: false
    }
  },
  {
    ...getBrowserToolMetadata('browser_select'),
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          pattern: '^b_[A-Za-z0-9_-]{1,61}$',
          maxLength: MAX_REF_LENGTH
        },
        value: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SELECT_LENGTH
        }
      },
      required: ['ref', 'value'],
      additionalProperties: false
    }
  },
  {
    ...getBrowserToolMetadata('browser_back'),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    ...getBrowserToolMetadata('browser_screenshot'),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
] as const satisfies readonly ModelToolDefinition[]

export type BrowserToolService = Pick<
  BrowserService,
  | 'getOrigin'
  | 'navigate'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'select'
  | 'back'
  | 'screenshot'
  | 'releaseConversation'
>

export type BrowserModelToolsOptions = {
  service: BrowserToolService
  conversationId: string
}

function createTextResult(value: unknown): ModelToolResult {
  const text = JSON.stringify(value)
  return {
    parts: [{ type: 'text', text }],
    contextBytes: Buffer.byteLength(text)
  }
}

function safeOrigin(value: string | undefined): string {
  return value ?? '尚未导航'
}

function navigationLabel(url: URL): string {
  const pathname =
    url.pathname.length > 500 ? `${url.pathname.slice(0, 500)}…` : url.pathname
  return `${url.origin}${pathname}${url.search ? '?[查询参数已隐藏]' : ''}`
}

export class BrowserModelTools {
  private readonly service: BrowserToolService
  private readonly conversationId: string

  constructor(options: BrowserModelToolsOptions) {
    this.service = options.service
    this.conversationId = options.conversationId
    if (!this.conversationId || this.conversationId.length > 500) {
      throw new Error('浏览器对话标识无效')
    }
  }

  listTools(): ModelToolDefinition[] {
    return definitions.map((definition) => ({
      ...definition,
      inputSchema: { ...definition.inputSchema }
    }))
  }

  ownsTool(name: string): name is BrowserToolName {
    return definitions.some((definition) => definition.name === name)
  }

  getApproval(
    tool: ModelToolDefinition | BrowserToolName,
    argumentsValue: Record<string, unknown>,
    argumentSummaryFromRuntime?: string
  ): RuntimeApprovalRequest {
    void argumentSummaryFromRuntime
    const name = typeof tool === 'string' ? tool : tool.name
    if (!this.ownsTool(name)) {
      throw new Error(`未知浏览器工具：${name}`)
    }
    const currentOrigin = safeOrigin(
      this.service.getOrigin(this.conversationId)
    )
    let description: string
    let argumentSummary: string
    let scopeKey: string
    if (name === 'browser_navigate') {
      const input = browserNavigateInputSchema.parse(argumentsValue)
      const target = canonicalizeBrowserUrl(input.url)
      const label = navigationLabel(target)
      description = `将在隔离浏览器中访问 ${label}。支持可由当前设备连接的 HTTP(S) 地址。`
      argumentSummary = label
      scopeKey = `model:browser:navigate:${target.origin}`
    } else if (name === 'browser_snapshot') {
      browserSnapshotInputSchema.parse(argumentsValue)
      description = `读取 ${currentOrigin} 的页面结构；可编辑字段值会被隐藏。`
      argumentSummary = `来源：${currentOrigin}`
      scopeKey = `model:browser:snapshot:${currentOrigin}`
    } else if (name === 'browser_click') {
      const input = browserClickInputSchema.parse(argumentsValue)
      description = `点击 ${currentOrigin} 页面中的元素 ${input.ref}。`
      argumentSummary = `元素：${input.ref}；来源：${currentOrigin}`
      scopeKey = `model:browser:click:${currentOrigin}:${input.ref}`
    } else if (name === 'browser_type') {
      const input = browserTypeInputSchema.parse(argumentsValue)
      description = `向 ${currentOrigin} 页面中的元素 ${input.ref} 输入已隐藏的文本，包括密码字段；文件、隐藏、禁用和只读字段不支持输入。`
      argumentSummary = `元素：${input.ref}；内容：[已隐藏，${input.text.length} 个字符]`
      // A session approval must never authorize a later value, even for the
      // same element. The nonce intentionally makes this invocation-only.
      scopeKey = `model:browser:type:${randomUUID()}`
    } else if (name === 'browser_select') {
      const input = browserSelectInputSchema.parse(argumentsValue)
      description = `在 ${currentOrigin} 页面中的选择控件 ${input.ref} 选择已隐藏的值。`
      argumentSummary = `元素：${input.ref}；选项值：[已隐藏，${input.value.length} 个字符]`
      scopeKey = `model:browser:select:${randomUUID()}`
    } else if (name === 'browser_back') {
      browserBackInputSchema.parse(argumentsValue)
      description = `从 ${currentOrigin} 返回浏览器历史记录中的上一页。`
      argumentSummary = `当前来源：${currentOrigin}`
      scopeKey = `model:browser:back:${randomUUID()}`
    } else {
      browserScreenshotInputSchema.parse(argumentsValue)
      description = `截取 ${currentOrigin} 当前可见页面区域。`
      argumentSummary = `来源：${currentOrigin}`
      scopeKey = `model:browser:screenshot:${currentOrigin}`
    }
    const definition = definitions.find((item) => item.name === name)
    if (!definition) {
      throw new Error(`未知浏览器工具：${name}`)
    }
    return {
      scopeKey,
      title: `允许${definition.displayName}？`,
      description,
      toolName: definition.displayName,
      argumentSummary,
      allowPermanent: false
    }
  }

  async callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ModelToolResult> {
    signal.throwIfAborted()
    if (!this.ownsTool(name)) {
      throw new Error(`未知浏览器工具：${name}`)
    }
    if (name === 'browser_navigate') {
      const input = browserNavigateInputSchema.parse(argumentsValue)
      return createTextResult(
        await this.service.navigate(this.conversationId, input.url, signal)
      )
    }
    if (name === 'browser_snapshot') {
      browserSnapshotInputSchema.parse(argumentsValue)
      return createTextResult(
        await this.service.snapshot(this.conversationId, signal)
      )
    }
    if (name === 'browser_click') {
      const input = browserClickInputSchema.parse(argumentsValue)
      await this.service.click(this.conversationId, input.ref, signal)
      return createTextResult({ clicked: input.ref })
    }
    if (name === 'browser_type') {
      const input = browserTypeInputSchema.parse(argumentsValue)
      await this.service.type(
        this.conversationId,
        input.ref,
        input.text,
        signal
      )
      return createTextResult({
        typed: input.ref,
        text: '[已隐藏]',
        characters: input.text.length
      })
    }
    if (name === 'browser_select') {
      const input = browserSelectInputSchema.parse(argumentsValue)
      await this.service.select(
        this.conversationId,
        input.ref,
        input.value,
        signal
      )
      return createTextResult({ selected: input.ref, value: '[已隐藏]' })
    }
    if (name === 'browser_back') {
      browserBackInputSchema.parse(argumentsValue)
      return createTextResult(
        await this.service.back(this.conversationId, signal)
      )
    }
    browserScreenshotInputSchema.parse(argumentsValue)
    const screenshot = await this.service.screenshot(
      this.conversationId,
      signal
    )
    return {
      parts: [
        {
          type: 'image',
          mimeType: screenshot.mimeType,
          data: screenshot.data
        }
      ],
      contextBytes: Buffer.byteLength(screenshot.data)
    }
  }

  async release(): Promise<void> {
    await this.service.releaseConversation(this.conversationId)
  }
}
