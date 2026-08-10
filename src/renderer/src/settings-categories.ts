export const settingsCategoryList = [
  {
    id: 'appearance',
    label: '外观',
    navigationDescription: '亮色、暗色与系统主题',
    description: '亮色、暗色与系统主题'
  },
  {
    id: 'platform-features',
    label: '平台功能',
    navigationDescription: '功能入口与工作区能力',
    description: '控制 GoodBuddy 工作区中显示的功能入口'
  },
  {
    id: 'model',
    label: '模型连接',
    navigationDescription: 'LLM、向量模型与凭据',
    description: 'LLM、向量模型与凭据'
  },
  {
    id: 'runtime',
    label: 'Agent Runtime',
    navigationDescription: 'OpenCode、Continue 与工作区',
    description: 'OpenCode、Continue 与工作区'
  },
  {
    id: 'security',
    label: '安全与数据',
    navigationDescription: '工具策略与本地隐私',
    description: '工具策略与本地隐私'
  },
  {
    id: 'automation',
    label: '自动化',
    navigationDescription: '智能心跳与周期回顾',
    description: '智能心跳与周期回顾'
  },
  {
    id: 'channels',
    label: '消息通道',
    navigationDescription: '微信、企业微信与钉钉',
    description: '配置连接、工作目录、消息处理后端与默认模式'
  },
  {
    id: 'roles',
    label: '角色与提示词',
    navigationDescription: '角色、说明与系统提示词',
    description: '角色、说明与系统提示词'
  },
  {
    id: 'skills',
    label: 'Skills',
    navigationDescription: '内置与自定义能力',
    description: '支持直连模型、OpenCode 和 Continue'
  },
  {
    id: 'mcp',
    label: 'MCP',
    navigationDescription: '工具服务与凭据',
    description: '查看内置工具、内置 MCP，并管理外部 MCP Server'
  },
  {
    id: 'about',
    label: '关于与更新',
    navigationDescription: '版本检查与下载页',
    description: '只检查 GoodBuddy 官方 GitHub Release，不自动下载安装'
  }
] as const

export type SettingsCategoryDefinition =
  (typeof settingsCategoryList)[number]
export type SettingsCategoryId = SettingsCategoryDefinition['id']

export const settingsCategories = Object.fromEntries(
  settingsCategoryList.map((category) => [category.id, category])
) as Record<SettingsCategoryId, SettingsCategoryDefinition>
