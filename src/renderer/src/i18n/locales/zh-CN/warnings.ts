export const warnings = {
  'application-settings-recovered':
    '应用设置文件已损坏。原文件已隔离，当前使用安全默认设置。',
  'document-parsing-settings-recovered':
    '文档解析设置文件已损坏。原文件已隔离，当前使用安全默认设置。',
  'capability-settings-recovered':
    '能力设置文件已损坏。原文件已隔离，联网搜索、内置浏览器和电脑控制已保持关闭，请检查后手动启用。',
  'runtime-settings-recovered':
    'Runtime 设置文件已损坏。原文件已隔离，当前使用默认设置。',
  'runtime-model-credential-unreadable':
    '模型连接“{{subject}}”的 API Key 无法读取。请重新输入或清除该凭据。',
  'runtime-model-credential-binding-mismatch':
    '模型连接“{{subject}}”的服务地址与已保存 API Key 不匹配。请重新输入或清除该凭据。',
  'runtime-embedding-credential-unreadable':
    '向量模型 API Key 无法读取。请重新输入或清除该凭据。',
  'runtime-embedding-credential-binding-mismatch':
    '向量接口地址与已保存 API Key 不匹配。请重新输入或清除该凭据。',
  'runtime-rerank-credential-unreadable':
    '重排模型 API Key 无法读取。请重新输入或清除该凭据。',
  'runtime-rerank-credential-binding-mismatch':
    '重排接口地址与已保存 API Key 不匹配。请重新输入或清除该凭据。',
  'channel-settings-recovered':
    '通道设置文件已损坏。原文件已隔离，所有通道已恢复为关闭状态。',
  'channel-weixin-credential-unreadable':
    '微信绑定凭据无法读取，通道已临时停用。请重新扫码绑定。',
  'channel-weixin-secure-storage-unavailable':
    '系统安全存储暂不可用，微信绑定已临时停用。恢复安全存储后可重试。',
  'channel-weixin-legacy-binding-invalid':
    '旧版微信绑定无法安全迁移，请重新扫码绑定。',
  'channel-wecom-environment-invalid':
    '企业微信环境变量配置无效或不完整，通道保持关闭。',
  'channel-dingtalk-environment-invalid':
    '钉钉环境变量配置无效或不完整，通道保持关闭。',
  'channel-wecom-credential-unreadable':
    '企业微信 Secret 无法读取。请重新输入或清除该凭据。',
  'channel-dingtalk-credential-unreadable':
    '钉钉 Client Secret 无法读取。请重新输入或清除该凭据。',
  'channel-runtime-selections-repaired':
    '已修复 {{count}} 个无人值守通道的不可用后端选择。请检查各通道项目设置。'
} as const

export default warnings
