import type { RuntimeTarget } from './capability-contracts'

export type BuiltinMcpServerSummary = {
  id: string
  name: string
  description: string
  tools: readonly {
    name: string
    description: string
    access: 'read'
  }[]
  assignments: readonly RuntimeTarget[]
  access: 'read'
  authorization: 'conversation-scoped'
}

export const builtinMcpServers = [
  {
    id: 'knowledge-base',
    name: '知识库 MCP',
    description:
      '列出并搜索当前对话明确选择的知识库，返回可核验的来源与证据引用。',
    tools: [
      {
        name: 'knowledge_list',
        description: '列出当前对话已授权的知识库及其说明。',
        access: 'read'
      },
      {
        name: 'knowledge_search',
        description: '搜索当前对话已授权的知识库并返回来源引用。',
        access: 'read'
      }
    ],
    assignments: ['model', 'opencode', 'continue'],
    access: 'read',
    authorization: 'conversation-scoped'
  },
  {
    id: 'magic-notes',
    name: '笔记 MCP',
    description:
      '搜索全局魔法笔记，返回匹配的笔记、记录正文与更新时间。',
    tools: [
      {
        name: 'note_search',
        description: '搜索全局魔法笔记中的标题和记录正文。',
        access: 'read'
      }
    ],
    assignments: ['model', 'opencode', 'continue'],
    access: 'read',
    authorization: 'conversation-scoped'
  }
] as const satisfies readonly BuiltinMcpServerSummary[]
