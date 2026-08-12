import type { RuntimeTarget } from './capability-contracts'

import {
  knowledgeScopedDataTools,
  magicNoteScopedDataTools
} from './scoped-data-tools'

export type BuiltinMcpServerSummary = {
  id: string
  name: string
  description: string
  tools: readonly {
    name: string
    description: string
    access: 'read' | 'write'
  }[]
  assignments: readonly RuntimeTarget[]
  access: 'read' | 'mixed'
  authorization: 'conversation-scoped'
  requiresFeature?: 'magic-notes'
}

export const builtinMcpServers = [
  {
    id: 'knowledge-base',
    name: '知识库',
    description:
      '列出并搜索当前对话明确选择的知识库，返回可核验的来源与证据引用。',
    tools: knowledgeScopedDataTools.map(({ name, summary, access }) => ({
      name,
      description: summary,
      access
    })),
    assignments: ['model', 'opencode', 'continue'],
    access: 'read',
    authorization: 'conversation-scoped'
  },
  {
    id: 'magic-notes',
    name: '笔记',
    description:
      '读取全局魔法笔记，并在 Execute 模式下创建、修改或删除笔记与记录。',
    tools: magicNoteScopedDataTools.map(({ name, summary, access }) => ({
      name,
      description: summary,
      access
    })),
    assignments: ['model', 'opencode', 'continue'],
    access: 'mixed',
    authorization: 'conversation-scoped',
    requiresFeature: 'magic-notes'
  }
] as const satisfies readonly BuiltinMcpServerSummary[]
