export type BuiltinModelToolSummary = {
  name: string
  displayName: string
  description: string
  access: 'read' | 'write'
}

export const builtinModelTools = [
  {
    name: 'workspace_read_text',
    displayName: '读取工作区文本',
    description: '读取当前工作区内不超过 256KB 的 UTF-8 文本文件。',
    access: 'read'
  },
  {
    name: 'workspace_list_directory',
    displayName: '列出工作区目录',
    description: '列出当前工作区内目录的直属内容，最多返回 200 项。',
    access: 'read'
  },
  {
    name: 'workspace_write_text',
    displayName: '写入工作区文本',
    description:
      '在当前工作区内新建或覆盖不超过 512KB 的 UTF-8 文本文件，父目录必须已存在。',
    access: 'write'
  },
  {
    name: 'browser_navigate',
    displayName: '浏览器导航',
    description: '在隔离浏览器中打开公开的 HTTP(S) 页面。',
    access: 'write'
  },
  {
    name: 'browser_snapshot',
    displayName: '读取浏览器快照',
    description: '读取当前页面的有界可访问性快照；可编辑值会被隐藏。',
    access: 'read'
  },
  {
    name: 'browser_click',
    displayName: '点击浏览器元素',
    description: '点击最近一次浏览器快照中的可见且未受保护元素。',
    access: 'write'
  },
  {
    name: 'browser_type',
    displayName: '输入浏览器文本',
    description: '向可编辑且未受保护的页面元素输入文本；不支持上传文件。',
    access: 'write'
  },
  {
    name: 'browser_select',
    displayName: '选择浏览器选项',
    description: '在最近一次快照标识的原生选择控件中选择值。',
    access: 'write'
  },
  {
    name: 'browser_back',
    displayName: '浏览器返回',
    description: '在隔离浏览器的历史记录中返回上一页。',
    access: 'write'
  },
  {
    name: 'browser_screenshot',
    displayName: '截取浏览器页面',
    description: '截取当前可见页面区域、约 200KB 的有界 JPEG 图片。',
    access: 'read'
  }
] as const satisfies readonly BuiltinModelToolSummary[]
