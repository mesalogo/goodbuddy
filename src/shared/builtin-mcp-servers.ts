import type { RuntimeTarget } from './capability-contracts'

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
    name: '笔记',
    description:
      '读取全局魔法笔记，并在 Execute 模式下创建、修改或删除笔记与记录。',
    tools: [
      {
        name: 'note_list',
        description: '列出全局魔法笔记及其版本信息。',
        access: 'read'
      },
      {
        name: 'note_get',
        description: '读取一篇笔记的记录正文与版本信息。',
        access: 'read'
      },
      {
        name: 'note_search',
        description: '搜索全局魔法笔记中的标题和记录正文。',
        access: 'read'
      },
      {
        name: 'note_create',
        description: '创建一篇全局魔法笔记。',
        access: 'write'
      },
      {
        name: 'note_update',
        description: '修改笔记标题或置顶状态。',
        access: 'write'
      },
      {
        name: 'note_entry_create',
        description: '向指定笔记追加纯文本记录。',
        access: 'write'
      },
      {
        name: 'note_entry_update',
        description: '使用当前版本修改一条笔记记录。',
        access: 'write'
      },
      {
        name: 'note_entry_delete',
        description: '永久删除一条笔记记录及其派生待办。',
        access: 'write'
      },
      {
        name: 'note_delete',
        description: '永久删除整篇笔记、全部记录及派生待办。',
        access: 'write'
      }
    ],
    assignments: ['model', 'opencode', 'continue'],
    access: 'mixed',
    authorization: 'conversation-scoped',
    requiresFeature: 'magic-notes'
  }
] as const satisfies readonly BuiltinMcpServerSummary[]
