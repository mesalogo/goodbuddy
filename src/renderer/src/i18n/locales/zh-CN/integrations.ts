export const integrations = {
  channels: {
    tabs: {
      weixin: '微信 ClawBot',
      wecom: '企业微信',
      dingtalk: '钉钉'
    },
    status: {
      disabled: '未启用',
      stopped: '已停止',
      starting: '正在连接',
      running: '已连接',
      error: '连接失败'
    },
    project: {
      sectionAriaLabel: '{{name}} 通道项目设置',
      identity: '通道项目',
      rootLabel: '默认工作目录',
      rootAriaLabel: '{{name}} 默认工作目录',
      selectRootAriaLabel: '选择 {{name}} 默认工作目录',
      select: '选择',
      rootHelp: '远程 Execute 只能在此项目目录范围内运行。',
      backendLabel: '消息处理后端',
      backendAriaLabel: '{{name}} 消息处理后端',
      directModels: '直连模型',
      unavailableProfile: '{{name}} · {{modelName}}（不可用）',
      missingProfile: '原直连模型已不存在',
      noTextModels: '暂无可用文本模型',
      missingSelection: '所选直连模型已不存在，请重新选择。',
      imageOnlySelection:
        '所选连接仅支持图片生成，请选择文本模型或 Agent Runtime。',
      missingCredential:
        '所选直连模型尚未配置密钥，请先到模型连接中完成配置。',
      directDescription:
        '直接使用 {{name}}（{{modelName}}）处理消息。',
      automaticDescription: '使用模型设置中的默认直连模型处理消息。',
      runtimeDescription:
        '通过 {{runtime}} Agent Runtime 运行，并跟随“Agent Runtime”设置中的全局 {{runtime}} 配置。',
      defaultMode: '默认模式',
      defaultModeAriaLabel: '{{name}} 默认模式',
      modes: {
        ask: '对话',
        execute: '执行'
      },
      overrideHelp:
        '可在消息前加 /ask、/execute、对话：或执行：临时覆盖。',
      executeRisk:
        '执行消息会立即交给所选后端，不再逐次弹窗确认。',
      askRisk:
        '默认对话时，白名单发送者仍可用 /execute 临时发起执行，且不会弹窗确认。',
      riskSuffix: '请只连接可信账号，并将工作目录限制在必要范围。'
    },
    credential: {
      identifiers: {
        wecom: '机器人 ID',
        dingtalk: 'Client ID'
      },
      secrets: {
        wecom: 'Secret',
        dingtalk: 'Client Secret'
      },
      environmentSource: '由环境变量提供',
      secretSaved: 'Secret 已加密保存',
      secretMissing: 'Secret 尚未配置',
      readOnly:
        '当前通道由环境变量管理。请在启动环境中修改配置后重启应用。',
      enable: '启用{{channel}}通道',
      fieldAriaLabel: '{{channel}}{{field}}',
      keepSecret: '留空以保留现有 Secret',
      enterSecret: '请输入 Secret',
      clearSecret: '保存时清除现有 Secret',
      allowedSenders: '允许的发送者 ID',
      allowedSendersAriaLabel: '{{channel}}允许的发送者 ID',
      allowedSendersPlaceholder: '每行一个 ID，最多 100 个',
      allowedSendersHelp:
        '只有白名单内的发送者可以向 GoodBuddy 发消息；留空时不会处理任何发送者。',
      groupMessages: '允许群聊中被提及时响应',
      testing: '正在测试…',
      testConnection: '测试{{channel}}连接'
    },
    qr: {
      title: '绑定微信 ClawBot',
      instructions:
        '请在微信中依次打开“设置 → ClawBot → 开始扫一扫”，扫描下方二维码。二维码不会发送到第三方页面。',
      close: '关闭微信绑定',
      imageAlt: '微信 ClawBot 绑定二维码',
      generating: '正在生成二维码…',
      scanned: '已扫码，正在确认…',
      verificationRequired: '需要输入微信验证码',
      waiting: '等待扫码',
      remaining: '二维码剩余 {{seconds}} 秒',
      verificationCode: '验证码',
      submitVerification: '提交验证码',
      expired: '二维码已过期',
      failed: '绑定失败',
      retryFallback: '请重新生成二维码后再试。',
      regenerate: '重新生成二维码'
    },
    weixin: {
      accountFallback: '微信账号',
      bindingSaved: '{{account}} · 凭据已加密保存',
      unbound: '尚未绑定个人微信',
      enable: '启用微信 ClawBot 通道',
      rebind: '重新绑定',
      bind: '扫码绑定',
      disconnect: '断开本机绑定',
      disconnectHelp:
        '断开会删除本机保存的绑定，不保证解除微信服务端授权。',
      behaviorHelp:
        '处理已绑定账号发给 ClawBot 的私聊文字、图片和文件，不响应群聊；单条消息最多 4 个附件、合计 12MB。'
    },
    sectionAriaLabel: '消息通道配置',
    unavailableService: '当前版本未提供消息通道设置服务',
    loadError: '读取消息通道设置失败',
    projectsLoadingError: '通道项目尚未加载',
    rootRequired: '{{channel}} 必须设置默认工作目录',
    saved: '消息通道设置已保存并应用',
    saveError: '保存消息通道设置失败',
    selectRootError: '选择工作目录失败',
    startBindingError: '启动微信绑定失败',
    verifyBindingError: '提交微信验证码失败',
    disconnected: '已删除本机保存的微信绑定',
    disconnectError: '断开微信绑定失败',
    connectionSuccess: '{{channel}}连接成功',
    testError: '通道连接测试失败',
    loading: '正在读取消息通道设置…',
    saving: '保存中…',
    save: '保存通道设置'
  },
  mcp: {
    runtimeLabels: {
      model: '模型',
      opencode: 'OpenCode',
      continue: 'Continue'
    },
    diagnosticStatuses: {
      available: '可用',
      degraded: '部分可用',
      unavailable: '不可用',
      disabled: '未启用'
    },
    errors: {
      load: '读取 MCP 设置失败',
      operation: '能力设置操作失败',
      unsupportedDiagnostics: '当前版本不支持电脑控制能力诊断',
      diagnostics: '能力诊断失败',
      unsupportedProfiles: '当前版本不支持托管浏览器配置',
      test: 'MCP 连接测试失败',
      unsupportedComputerControl: '当前版本不支持电脑控制能力'
    },
    addServer: '添加 Server',
    sectionAriaLabel: 'MCP 配置',
    customNotice:
      '自定义 MCP 当前仅用于直连模型，新建时默认分配给直连模型，并仅在 Execute 模式加载。内置共享 MCP 提供知识库读取与全局笔记管理，可供直连模型、OpenCode 和 Continue 使用；Ask 只读，笔记写入仅在 Execute 模式开放。Runtime 自有 MCP 配置不在此处管理。',
    securityNotice:
      '内置工具由 GoodBuddy 提供，不属于 MCP Server。自定义 MCP Server 及其工具具有当前用户权限，请仅添加可信服务；远程访问令牌将由系统安全存储加密，工具调用前仍需 GoodBuddy 审批。',
    computer: {
      title: '电脑控制能力',
      subtitle: '默认停用，启用后仍遵循审批',
      supported: '当前设备支持',
      unsupported: '当前设备不支持',
      enabled: '已启用',
      disabled: '已停用',
      enableAriaLabel: '启用 {{name}}',
      browserProfile: '托管浏览器配置',
      profileAriaLabel: '浏览器控制使用的托管配置',
      defaultProfile: '使用默认托管配置',
      diagnoseAriaLabel: '诊断 {{name}}',
      diagnosing: '诊断中…',
      diagnose: '运行诊断',
      result: '诊断结果：{{status}}',
      remedy: ' 处理建议：{{remedy}}'
    },
    profiles: {
      title: '托管浏览器配置',
      count: '{{count}} 个',
      notice:
        '每个配置使用 GoodBuddy 管理的隔离存储；界面不会接收或显示可执行路径、命令参数与环境变量。',
      newName: '新配置名称',
      placeholder: '例如：工作网站',
      create: '创建托管配置',
      empty: '尚未创建托管浏览器配置',
      name: '配置名称',
      nameAriaLabel: '配置名称 {{name}}',
      setDefaultAriaLabel: '设为默认配置 {{name}}',
      default: '默认',
      renameAriaLabel: '重命名配置 {{name}}',
      rename: '重命名',
      deleteAriaLabel: '删除配置 {{name}}',
      delete: '删除',
      inUse: '此配置正被电脑控制能力使用'
    },
    builtin: {
      title: 'GoodBuddy 内置 MCP',
      availableTo: '可用于：模型、OpenCode、Continue',
      notice:
        '内置 MCP 由 GoodBuddy 在主进程按当前对话签发短期权限，不公开服务地址或凭据。',
      serverSummaryMixed: '内置 MCP Server · 按模式读写 · 按对话授权',
      serverSummaryReadOnly: '内置 MCP Server · 只读 · 按对话授权',
      serverSummaryDisabled:
        '内置 MCP Server · 未启用 · 需要开启魔法笔记',
      featureDisabled:
        '魔法笔记功能已关闭，此内置能力当前不会向任何 Runtime 提供工具。',
      collapseServer: '收起服务器 {{name}}',
      expandServer: '展开服务器 {{name}}',
      toolCount: '{{count}} 个工具',
      toolsAriaLabel: '{{name}} 工具',
      tools: '工具',
      write: '写入',
      readOnly: '只读'
    },
    modelTools: {
      title: '直连模型内置工具',
      groupCount: '{{count}} 组',
      collapseGroup: '收起工具组 {{name}}',
      expandGroup: '展开工具组 {{name}}',
      summary: 'GoodBuddy 直连模型内置能力'
    },
    webSearch: {
      title: '联网搜索',
      subtitle: '直连模型工具 · Exa MCP · Ask / Execute',
      description:
        '提供 web_search 和 web_fetch，只允许搜索及读取公开网页；Plan 模式不会加载。',
      privacy:
        '查询词和公开网页地址会发送给第三方 Exa 服务，不会发送模型 API Key、本地文件或知识库内容。',
      enableAriaLabel: '启用直连模型联网搜索',
      enabled: '已启用',
      disabled: '已停用',
      test: '测试真实搜索',
      testing: '正在搜索…',
      unsupported: '当前版本不支持联网搜索设置',
      testFailed: '联网搜索测试失败',
      resultAriaLabel: '联网搜索测试结果',
      result: '真实搜索成功 · {{duration}} 毫秒',
      toolsAriaLabel: '直连模型联网搜索工具'
    },
    editor: {
      editTitle: '编辑 MCP Server',
      addTitle: '添加 MCP Server',
      closeAriaLabel: '关闭 MCP 编辑器',
      name: '名称',
      description: '说明',
      transport: '传输方式',
      stdio: 'stdio（本地进程）',
      sse: 'SSE（兼容旧服务）',
      command: '可执行命令或绝对路径',
      commandAriaLabel: 'MCP 可执行命令',
      commandPlaceholder: '例如 npx 或 C:\\Tools\\server.exe',
      args: '参数（每行一个）',
      argsAriaLabel: 'MCP 命令参数',
      savedTokenPlaceholder: '留空保持已保存令牌',
      optional: '可选',
      clearToken: '保存时清除已保存的 Bearer Token',
      enable: '启用此 MCP Server',
      assignTo: '分配给',
      cancel: '取消',
      saving: '保存中…',
      save: '保存 MCP Server'
    },
    custom: {
      title: '自定义 MCP Servers（高级）',
      count: '{{count}} 个',
      notice:
        '自定义 stdio MCP 会以受限环境启动，不会获得桌面会话变量。需要电脑控制时请使用上方经过诊断的内置能力。',
      empty: '尚未配置 MCP Server',
      collapseServer: '收起服务器 {{name}}',
      expandServer: '展开服务器 {{name}}',
      enabled: '已启用',
      disabled: '已停用',
      encryptedToken: ' · 已加密令牌',
      toolsUndetected: '工具未检测',
      testAriaLabel: '测试 {{name}}',
      test: '测试',
      editAriaLabel: '编辑 {{name}}',
      edit: '编辑',
      deleteAriaLabel: '删除 {{name}}',
      delete: '删除',
      assigned: '已分配：',
      assignmentSeparator: '、',
      none: '无',
      noTools: '服务器未公开可用工具。',
      testHelp: '点击“测试”连接服务器并读取其工具列表。'
    }
  }
} as const
