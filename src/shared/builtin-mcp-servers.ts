import type { RuntimeTarget } from './capability-contracts'

export type BuiltinMcpServerSummary = {
  id: string
  name: string
  description: string
  tools: readonly string[]
  assignments: readonly RuntimeTarget[]
  access: 'read'
  authorization: 'conversation-scoped'
}

export const builtinMcpServers = [
  {
    id: 'knowledge-base',
    name: '知识库 MCP',
    description:
      '搜索当前对话明确选择的知识库，并返回可核验的来源与证据引用。',
    tools: ['knowledge_search'],
    assignments: ['model', 'opencode', 'continue'],
    access: 'read',
    authorization: 'conversation-scoped'
  }
] as const satisfies readonly BuiltinMcpServerSummary[]
