export type Language = 'zh' | 'en'

export type Chapter = {
  slug: string
  title: { zh: string; en: string }
}

export const chapters: Chapter[] = [
  { slug: 'start', title: { zh: '开始使用', en: 'Get started' } },
  { slug: 'concepts', title: { zh: '核心概念', en: 'Core concepts' } },
  { slug: 'connections', title: { zh: '配置模型连接', en: 'Configure model connections' } },
  { slug: 'runtimes', title: { zh: '选择 Runtime', en: 'Choose a Runtime' } },
  { slug: 'workbar', title: { zh: '助手工作栏', en: 'Assistant workbar' } },
  { slug: 'knowledge', title: { zh: '建立知识库', en: 'Build a knowledge base' } },
  { slug: 'notes', title: { zh: '使用魔法笔记', en: 'Use Magic Notes' } },
  { slug: 'tasks', title: { zh: '任务', en: 'Tasks' } },
  { slug: 'supervision', title: { zh: '监督工作', en: 'Supervision' } },
  { slug: 'remote', title: { zh: '远程项目', en: 'Remote projects' } },
  { slug: 'privacy', title: { zh: '数据与隐私', en: 'Data and privacy' } },
  { slug: 'troubleshooting', title: { zh: '问题排查', en: 'Troubleshooting' } },
]
