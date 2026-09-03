import type {
  BuiltinMcpServerId,
  RuntimeTarget
} from './capability-contracts'

import {
  knowledgeScopedDataTools,
  magicNoteScopedDataTools
} from './scoped-data-tools'
import { goodbuddyConfigTools } from './goodbuddy-config-tools'
import { builtinModelTools } from './builtin-model-tools'

export type BuiltinMcpServerSummary = {
  id: BuiltinMcpServerId
  name: string
  description: string
  tools: readonly {
    name: string
    description: string
    access: 'read' | 'write'
  }[]
  supportedAssignments: readonly RuntimeTarget[]
  access: 'read' | 'mixed'
  authorization: 'conversation-scoped'
  requiresFeature?: 'magic-notes'
  computerCapabilityId?: 'host-browser-control'
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
    supportedAssignments: ['model', 'opencode', 'continue'],
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
    supportedAssignments: ['model', 'opencode', 'continue'],
    access: 'mixed',
    authorization: 'conversation-scoped',
    requiresFeature: 'magic-notes'
  },
  {
    id: 'goodbuddy-config',
    name: 'GoodBuddy 配置',
    description:
      '发现常见配置示例，读取脱敏配置，并通过计划和原生确认管理应用偏好、Skills 与 MCP。',
    tools: goodbuddyConfigTools.map(({ name, summary, access }) => ({
      name,
      description: summary,
      access
    })),
    supportedAssignments: ['model', 'opencode', 'continue'],
    access: 'mixed',
    authorization: 'conversation-scoped'
  },
  {
    id: 'builtin-browser',
    name: '内置浏览器',
    description:
      '允许已分配的 Runtime 使用 GoodBuddy 临时隔离浏览器，不会控制客户端已安装的浏览器；关闭此能力不影响你在浏览器工作栏中手动操作。',
    tools: builtinModelTools
      .filter((tool) => tool.group === 'browser')
      .map(({ name, description, access }) => ({
        name,
        description,
        access
      })),
    supportedAssignments: ['model', 'opencode', 'continue'],
    access: 'mixed',
    authorization: 'conversation-scoped',
    computerCapabilityId: 'host-browser-control'
  }
] as const satisfies readonly BuiltinMcpServerSummary[]
