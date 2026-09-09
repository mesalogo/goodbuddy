export type BuiltinModelToolSummary = {
  name: string
  displayName: string
  description: string
  access: 'read' | 'write'
  group: 'filesystem' | 'browser' | 'web' | 'programming'
}

export const builtinModelTools = [
  {
    name: 'workspace_rg',
    displayName: '搜索工作区',
    description:
      '使用 GoodBuddy 内置 ripgrep 搜索工作区内容或列出文件，返回带路径和行号的紧凑结果。',
    access: 'read',
    group: 'filesystem'
  },
  {
    name: 'workspace_read_text',
    displayName: '读取工作区文本',
    description: '按行分页读取当前工作区内的 UTF-8 文本文件。',
    access: 'read',
    group: 'filesystem'
  },
  {
    name: 'workspace_apply_patch',
    displayName: '应用工作区补丁',
    description:
      '使用 apply_patch 格式在当前工作区内新增、修改或删除 UTF-8 文本文件。',
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
      '使用当前用户权限运行 PowerShell、Bash 或 Sh 命令，可指定工作目录；长输出保留完整内容并支持分页续读。',
    access: 'write',
    group: 'programming'
  },
  {
    name: 'output_read',
    displayName: '续读工具输出',
    description: '按 cursor 分页读取当前会话已保留的进程或 Subagent 输出；会话释放后失效。',
    access: 'read',
    group: 'programming'
  },
  {
    name: 'subagent_delegate',
    displayName: '编程 Subagent',
    description:
      '将聚焦任务委派给同一模型连接，继承当前工作模式和工作区；长输出可分页续读。',
    access: 'read',
    group: 'programming'
  }
] as const satisfies readonly BuiltinModelToolSummary[]

export const builtinModelToolGroups = [
  {
    id: 'filesystem',
    name: '工作区文件',
    description:
      '搜索和分页读取工作区文件；Execute 模式还可通过补丁新增、修改或删除文件。',
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
    name: '开发工具',
    description:
      '直连模型可运行项目命令，或将聚焦的开发任务委派给继承当前模式的 Subagent。',
    tools: builtinModelTools.filter((tool) => tool.group === 'programming')
  }
] as const
