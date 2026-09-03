export type BuiltinModelToolSummary = {
  name: string
  displayName: string
  description: string
  access: 'read' | 'write'
  group: 'filesystem' | 'browser' | 'web' | 'programming'
}

export const builtinModelTools = [
  {
    name: 'workspace_read_text',
    displayName: '读取工作区文本',
    description: '读取当前工作区内不超过 256KB 的 UTF-8 文本文件。',
    access: 'read',
    group: 'filesystem'
  },
  {
    name: 'workspace_list_directory',
    displayName: '列出工作区目录',
    description: '列出当前工作区内目录的直属内容，最多返回 200 项。',
    access: 'read',
    group: 'filesystem'
  },
  {
    name: 'workspace_write_text',
    displayName: '写入工作区文本',
    description:
      '在当前工作区内新建或覆盖不超过 512KB 的 UTF-8 文本文件，父目录必须已存在。',
    access: 'write',
    group: 'filesystem'
  },
  {
    name: 'browser_navigate',
    displayName: '浏览器导航',
    description: '在隔离浏览器中打开当前设备可连接的 HTTP 或 HTTPS 页面。',
    access: 'write',
    group: 'browser'
  },
  {
    name: 'browser_snapshot',
    displayName: '读取浏览器快照',
    description: '读取当前页面的有界可访问性快照；可编辑值会被隐藏。',
    access: 'read',
    group: 'browser'
  },
  {
    name: 'browser_click',
    displayName: '点击浏览器元素',
    description: '点击最近一次浏览器快照中的可见元素。',
    access: 'write',
    group: 'browser'
  },
  {
    name: 'browser_type',
    displayName: '输入浏览器文本',
    description: '向可编辑页面元素（包括密码框）输入文本；不支持上传文件。',
    access: 'write',
    group: 'browser'
  },
  {
    name: 'browser_select',
    displayName: '选择浏览器选项',
    description: '在最近一次快照标识的原生选择控件中选择值。',
    access: 'write',
    group: 'browser'
  },
  {
    name: 'browser_back',
    displayName: '浏览器返回',
    description: '在隔离浏览器的历史记录中返回上一页。',
    access: 'write',
    group: 'browser'
  },
  {
    name: 'browser_screenshot',
    displayName: '截取浏览器页面',
    description: '截取当前可见页面区域、约 200KB 的有界 JPEG 图片。',
    access: 'read',
    group: 'browser'
  },
  {
    name: 'web_search',
    displayName: '联网搜索',
    description:
      '通过 Exa 托管 MCP 搜索公开网页，查询词会发送给第三方服务。',
    access: 'read',
    group: 'web'
  },
  {
    name: 'web_fetch',
    displayName: '读取网页',
    description:
      '通过 Exa 托管 MCP 读取公开 HTTP 或 HTTPS 网页的有界正文。',
    access: 'read',
    group: 'web'
  },
  {
    name: 'process_execute',
    displayName: '进程执行',
    description:
      '使用当前工作区和当前用户权限运行 PowerShell、Bash 或 Sh 命令。',
    access: 'write',
    group: 'programming'
  },
  {
    name: 'subagent_delegate',
    displayName: '编程 Subagent',
    description:
      '将聚焦任务委派给同一模型连接；继承当前工作模式和工作区。',
    access: 'read',
    group: 'programming'
  }
] as const satisfies readonly BuiltinModelToolSummary[]

export const builtinModelToolGroups = [
  {
    id: 'filesystem',
    name: '文件系统操作',
    description:
      '在 Execute 模式下读取、列出或写入当前工作区范围内的文件。',
    tools: builtinModelTools.filter((tool) => tool.group === 'filesystem')
  },
  {
    id: 'web',
    name: '联网搜索',
    description:
      '启用后，直连模型可在 Ask 和 Execute 模式搜索并读取公开网页。',
    tools: builtinModelTools.filter((tool) => tool.group === 'web')
  },
  {
    id: 'programming',
    name: '编程能力',
    description:
      '直连模型可运行项目命令，或将聚焦任务委派给继承当前模式的 Subagent。',
    tools: builtinModelTools.filter((tool) => tool.group === 'programming')
  }
] as const
