export const settings = {
  center: {
    eyebrow: '设置',
    title: '设置中心',
    description: '管理模型连接、Agent Runtime、自动化、扩展能力和本地数据。',
    close: '关闭设置',
    categoriesAriaLabel: '设置分类'
  },
  categories: {
    appearance: {
      label: '外观',
      navigationDescription: '主题与界面语言',
      description: '主题与界面语言'
    },
    platformFeatures: {
      label: '平台功能',
      navigationDescription: '功能入口与工作区能力',
      description: '控制 GoodBuddy 工作区中显示的功能入口'
    },
    model: {
      label: '模型连接',
      navigationDescription: 'LLM、向量模型与凭据',
      description: 'LLM、向量模型与凭据'
    },
    runtime: {
      label: 'Agent Runtime',
      navigationDescription: 'OpenCode、Continue 与工作区',
      description: 'OpenCode、Continue 与工作区'
    },
    security: {
      label: '安全与数据',
      navigationDescription: '工具策略与本地隐私',
      description: '工具策略与本地隐私'
    },
    automation: {
      label: '自动化',
      navigationDescription: '智能心跳与周期回顾',
      description: '智能心跳与周期回顾'
    },
    channels: {
      label: '消息通道',
      navigationDescription: '微信、企业微信与钉钉',
      description: '配置连接、工作目录、消息处理后端与默认模式'
    },
    roles: {
      label: '角色与提示词',
      navigationDescription: '角色、说明与系统提示词',
      description: '角色、说明与系统提示词'
    },
    skills: {
      label: 'Skills',
      navigationDescription: '内置与自定义能力',
      description: '支持直连模型、OpenCode 和 Continue'
    },
    mcp: {
      label: 'MCP',
      navigationDescription: '工具服务与凭据',
      description: '查看内置工具、内置 MCP，并管理外部 MCP Server'
    },
    about: {
      label: '关于与更新',
      navigationDescription: '版本检查与下载页',
      description: '只检查 GoodBuddy 官方 GitHub Release，不自动下载安装'
    }
  },
  actions: {
    testing: '测试中…',
    saveAndTestModel: '保存并测试模型',
    saveAndTestRuntime: '保存并测试 {{runtime}}',
    saving: '保存中…',
    saveSettings: '保存设置',
    select: '选择',
    selectFile: '选择文件',
    clear: '清除',
    openConfigFile: '打开配置文件',
    revealInFolder: '在文件夹中显示',
    openConfigDirectory: '打开 {{runtime}} 配置目录',
    detecting: '检测中…',
    redetectRuntime: '重新检测 {{runtime}}',
    addCustom: '添加自定义',
    deleteConnection: '删除连接',
    clearAfterSave: '保存后清除',
    clearCredential: '清除凭据',
    cancel: '取消',
    clearing: '正在清除…',
    clearLocalData: '清除本地数据'
  },
  errors: {
    readSettings: '读取设置失败',
    detectRuntimes: 'Runtime 自动检测失败',
    readEmbeddingStatus: '读取向量索引状态失败',
    requireModelConnection: '请至少配置一个模型连接',
    refreshEmbeddingAfterSave: '设置已保存，但刷新向量模型状态失败',
    speechModelsUnavailable: '当前版本未提供语音模型服务',
    saveSettings: '保存设置失败',
    testModel: '模型连接测试失败',
    testRuntime: 'Runtime 连接测试失败',
    embeddingDiagnosticUnavailable: '向量诊断服务不可用',
    testEmbedding: '向量模型测试失败',
    embeddingIndexUnavailable: '向量索引服务不可用',
    rebuildEmbeddingIndex: '启动向量索引重建失败',
    embeddingJobFinished: '当前向量索引任务已结束',
    cancelEmbeddingIndex: '取消向量索引重建失败',
    selectFile: '选择文件失败',
    openRuntimeConfig: '打开 Runtime 配置失败',
    selectWorkspace: '选择工作区目录失败',
    retainModelConnection: '请至少保留一个模型连接',
    clearLocalData: '本地数据清除失败'
  },
  notifications: {
    settingsSaved: '设置已保存',
    connectionSucceeded: '连接成功：{{label}}'
  },
  credentials: {
    none: '尚未配置',
    encrypted: '已由系统安全存储加密',
    environment: '由环境变量提供',
    configuredPlaceholder: '已配置，留空保持不变',
    enterApiKey: '输入 API Key',
    noAuthentication: '无需认证',
    noAuthenticationDescription: '无需认证，不会发送 API Key'
  },
  runtime: {
    configCard: {
      title: '{{runtime}} 自有配置',
      fileLabel: '配置文件',
      pathAriaLabel: '{{runtime}} 配置文件路径',
      pathPlaceholder: '选择可信的本地 {{runtime}} 配置文件',
      unsavedHint: '保存设置后可直接打开或定位该文件。'
    },
    detection: {
      ready: '已就绪',
      notReady: '尚未就绪 · {{detail}}',
      detecting: '正在检测…',
      notDetected: '尚未检测'
    },
    workspace: {
      title: '默认工作区',
      description: '当前项目未设置根目录时，Agent 才使用此默认位置',
      directoryLabel: '默认工作区目录'
    },
    selectorDescription:
      'OpenCode 和 Continue 已随 GoodBuddy 内置；配置可兼容的直连文本模型后即可使用。',
    bundledDescription: 'GoodBuddy 内置 Runtime，默认跟随文本模型连接',
    runtimeLabel: 'Runtime：',
    modelConfigurationLabel: '模型配置：',
    bundledRuntime: 'GoodBuddy 内置 {{runtime}}',
    ownConfiguration: '使用 {{runtime}} 自有配置',
    followGoodBuddy: '跟随 GoodBuddy · {{name}}（{{model}}）',
    noCompatibleModel: '尚未配置兼容的文本模型',
    permissions:
      '对话时可选择 Ask 或 Execute。Ask 仅可调用知识库与全局笔记读取工具；Execute 可调用已启用工具及笔记写入工具，调用过程会记录到活动。',
    advanced: '高级设置',
    sourceLegend: '模型配置来源',
    followRecommended: '跟随 GoodBuddy 模型（推荐）',
    goodBuddyConnection: 'GoodBuddy 模型连接',
    pinConnectionDescription: '可固定到其他 GoodBuddy 文本模型连接。',
    incompatibleSuffix: '（不兼容）',
    serverAddress: 'Server 地址',
    bundledProgramPlaceholder: '留空使用 GoodBuddy 内置程序',
    customBinaryWarning:
      '自定义 {{runtime}} 可执行文件将以当前用户权限运行，请仅选择可信文件。',
    opencode: {
      title: 'OpenCode Agent',
      recommendation:
        '推荐直接跟随 GoodBuddy 模型。只有需要复用 OpenCode 原生模型、插件或 MCP 配置时，才切换到 Runtime 自有配置。',
      advancedDescription:
        '普通使用无需修改。这里可以切换模型配置来源、管理 Runtime 自有配置，或覆盖内置程序与服务。',
      followDescription:
        '自动生成安全的运行期配置，无需维护 Runtime 配置文件。',
      ownDescription: '适合需要原生模型、插件或 MCP 配置的专业用户。',
      configDescription:
        'GoodBuddy 不会打开或暴露自动生成的运行期配置；这里只管理你明确选择的本地文件。',
      externalServerWarning:
        '外部 OpenCode Server 的模型、插件与工具由服务端管理，本地配置文件不会传给该服务。按请求授权的本机知识库工具也不会注入外部服务。',
      serverAriaLabel: 'OpenCode Server 地址',
      serverPlaceholder: '留空使用内置本机服务',
      serverDescription:
        '留空时自动启动 GoodBuddy 内置的本机 OpenCode 服务，无需安装或填写地址。',
      binaryPath: 'OpenCode 可执行文件路径'
    },
    continue: {
      title: 'Continue CLI',
      recommendation:
        '推荐直接跟随 GoodBuddy 模型。只有需要复用 Continue 原生模型、规则或 MCP 配置时，才切换到 Runtime 自有配置。',
      advancedDescription:
        '普通使用无需修改。这里可以切换模型配置来源、管理 Runtime 自有配置，或覆盖内置程序。',
      followDescription:
        '自动生成安全的临时运行期配置，任务结束后立即删除。',
      ownDescription: '适合需要原生模型、规则或 MCP 配置的专业用户。',
      configDescription:
        'GoodBuddy 不会打开或暴露含临时凭据的运行期配置；这里只管理你明确选择的本地文件。',
      binaryPath: 'Continue 可执行文件路径',
      missingConfigWarning:
        '未指定配置文件时 Continue 将保持不可用，不会匿名加载远程默认模型。'
    }
  },
  model: {
    typeAriaLabel: '模型类型',
    types: {
      llm: {
        label: 'LLM 模型',
        description: '配置对话、推理和图片生成使用的模型连接。'
      },
      embedding: {
        label: '向量模型',
        description: '配置知识库语义检索与 GraphRAG 使用的向量模型。'
      },
      speech: {
        label: '语音模型',
        description:
          '选择已安装模型后保存设置生效；模型可按需下载或从本地目录导入。'
      }
    },
    profile: {
      generatedName: '模型连接 {{count}}',
      title: 'LLM 模型连接',
      description:
        '支持 OpenAI Responses、Anthropic Messages 和 OpenAI 兼容 Chat Completions；图片模型使用独立的 OpenAI Images Generations 接口类型',
      listAriaLabel: '模型连接列表',
      listTitle: '连接列表',
      editAriaLabel: '编辑模型连接 {{name}}',
      defaultBadge: '默认',
      imageBadge: '图像',
      detail: '连接详情',
      defaultConnection: '默认连接',
      imageGeneration: '图像生成',
      deleteAriaLabel: '删除模型连接 {{name}}',
      name: '名称',
      endpoint: '模型接口 URL',
      model: '模型',
      protocol: '接口协议',
      protocolAriaLabel: '接口协议 {{name}}',
      openAiCompatibleProtocol: 'OpenAI 兼容 Chat Completions',
      imageProtocol: 'OpenAI Images Generations（图像生成）',
      authentication: '认证方式',
      authenticationAriaLabel: '认证方式 {{name}}',
      supportsImageInput: '支持图像输入',
      supportsImageInputDescription:
        '启用后，GoodBuddy 可将图片上下文发送给此模型连接。',
      imageQuality: '图片质量',
      imageQualityAriaLabel: '图片质量 {{name}}',
      quality: {
        auto: '自动',
        low: '低',
        medium: '中',
        high: '高'
      },
      imageQualityDescription: '仅用于 OpenAI 兼容图像生成请求。',
      compatibilitySummary:
        '直连模型：{{directCapability}} · Continue：{{continueCompatibility}} · OpenCode：{{openCodeCompatibility}}',
      textChat: '文本对话',
      compatible: '兼容',
      incompatible: '不兼容',
      incompatibleImageProtocol: '不兼容（不支持图像生成协议）',
      secureStorageWarning:
        '当前系统密钥服务不可用。为了避免明文落盘，请使用环境变量提供 API Key。'
    },
    embedding: {
      title: '向量模型连接',
      description: '使用 OpenAI 兼容 Embeddings 接口，不限定服务提供商',
      enabled: '启用向量模型',
      endpoint: '向量接口 URL',
      endpointDescription: '填写完整的 OpenAI 兼容 Embeddings 端点。',
      modelName: '模型名称',
      optionalApiKey: 'API Key（可选）',
      optionalApiKeyPlaceholder: '本地无认证服务可留空',
      privacyDescription:
        '仅向所填接口发送已启用知识库的分块文本。API Key 由系统安全存储加密；向量服务失败时自动回退到 FTS5 与证据图谱。'
    }
  },
  security: {
    sandbox: {
      label: 'Runtime OS 沙箱',
      options: {
        auto: '自动（Linux 优先启用）',
        strict: '严格（不可用时拒绝运行）',
        off: '关闭'
      },
      description:
        '首期严格隔离适用于安装 bubblewrap 的 Linux 嵌入式 OpenCode。外部 Runtime 与 Continue 不会被误标为已沙箱。'
    },
    toolPolicy: {
      label: '直连模型工具安全策略',
      always: 'Execute 自动授权已启用的工具',
      deny: '禁止所有工具执行',
      description:
        '直连模型的 Execute 模式可使用内置工作区工具及已分配的 MCP 工具；选择 Execute 即授权当前交互运行自动调用这些工具，不再逐次询问。禁止策略会拒绝所有工具调用。OpenCode 与 Continue 继续使用各自的工具系统。'
    },
    localData: {
      title: '本地数据与隐私',
      description:
        '清除本机对话、活动记录和知识库索引。已保存的 Runtime 凭据和原目录文件不会被删除。'
    }
  },
  roles: {
    smartRouting: {
      title: 'Subagent 智能路由',
      description: '按问题内容自动选择最匹配的专家角色',
      enabled: '启用 Subagent 智能路由',
      help:
        '默认关闭。仅在 Ask 或 Plan 模式且未显式选择专家或团队时，自动选择 1 位专家；子专家使用默认文本模型，只读运行且不使用工具。'
    }
  },
  appearance: {
    theme: {
      title: '界面主题',
      description: '选择后立即应用，并保存在此设备',
      ariaLabel: '界面主题',
      options: {
        system: {
          label: '跟随系统',
          description: '随操作系统自动切换'
        },
        light: {
          label: '亮色',
          description: '明亮、清晰的工作界面'
        },
        dark: {
          label: '暗色',
          description: '降低暗光环境下的亮度'
        }
      }
    },
    language: {
      title: '界面语言',
      description: '选择后立即应用，并保存在此设备',
      ariaLabel: '界面语言',
      options: {
        system: {
          label: '跟随系统',
          description: '中文系统使用简体中文，其他系统使用 English'
        },
        chinese: {
          label: '简体中文',
          description: '使用简体中文界面'
        },
        english: {
          label: 'English',
          description: 'Use the English interface'
        }
      }
    }
  }
} as const
