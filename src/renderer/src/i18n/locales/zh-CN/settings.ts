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
    documentParsing: {
      label: '文档解析',
      navigationDescription: '附件、知识库与本地 OCR',
      description: '统一配置聊天附件和知识库使用的提取、转换与 OCR 策略'
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
    testParsing: '测试解析',
    testingParsing: '正在解析…',
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
    clearLocalData: '本地数据清除失败',
    documentParsingUnavailable: '文档解析服务不可用',
    readDocumentParsing: '读取文档解析设置失败',
    saveDocumentParsing: '保存文档解析设置失败',
    testDocumentParsing: '测试文档解析失败',
    manageDocumentOcrModel: 'OCR 模型操作失败'
  },
  notifications: {
    settingsSaved: '设置已保存',
    connectionSucceeded: '连接成功：{{label}}',
    documentParsingSaved: '文档解析设置已保存',
    documentParsingTestSucceeded: '文档解析测试完成'
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
  documentParsing: {
    status: {
      title: '运行状态',
      description: '显示当前设备实际可用的解析能力',
      available: '可用',
      unavailable: '不可用',
      verified: '已校验',
      native: '原生文档解析',
      nativeDetail: '文本、HTML、文本型 PDF 和新式 Office 文档',
      conversion: '旧版 Office 转换',
      conversionUnavailable: '尚未实现，DOC、XLS、PPT 暂不可用',
      localOcr: '本地 OCR',
      ocrReady: '模型已安装并通过 SHA-256 校验，可离线使用',
      ocrUnavailable: '模型尚未安装或校验失败，请从 ModelScope 下载',
      partialNotice:
        '基础文档解析可用。旧版 Office 转换尚未实现；扫描 PDF 使用本地 OCR。'
    },
    workflows: {
      title: '使用场景',
      description: '为聊天附件和知识库选择不同的解析深度',
      chat: '聊天附件',
      chatDescription: '控制附件加入当前请求前的解析方式',
      knowledge: '知识库导入',
      knowledgeDescription: '控制文档分块、索引和来源定位前的解析方式',
      chatOptions: {
        auto: '自动解析（推荐）',
        fastText: '快速文本',
        highFidelity: '高保真解析'
      },
      knowledgeOptions: {
        completeIndex: '完整索引（推荐）',
        fastIndex: '快速索引',
        highFidelity: '高保真索引'
      }
    },
    ocr: {
      title: 'OCR 识别',
      description: '按需安装本地模型，在设备上识别扫描 PDF',
      enabled: '启用本地 OCR',
      enabledDescription:
        '模型安装后仅在本机通过 ONNX Runtime WebAssembly 运行，识别时不会上传文档。',
      model: '本地模型',
      runtime: '运行时',
      provider: {
        title: 'OCR 来源',
        description: '本地模型与远程服务二选一，切换后保存设置生效。',
        local: '本地模型',
        remote: '远程服务（即将支持）',
        remoteDescription:
          '远程服务将支持 MinerU、PaddleOCR-VL 等接口，当前版本暂不可选。'
      },
      modelSelector: '当前 OCR 模型',
      modelSelectorDescription: '选择已保存，聊天附件和知识库将使用此模型。',
      pendingSelection: '模型选择尚未生效，点击“保存设置”后切换。',
      installedOption: '已安装',
      downloadableOption: '可下载',
      openModelsDirectory: '打开模型目录',
      storagePrefix: '模型按需安装到',
      storageSuffix: '。可导出 ZIP，并在内网设备直接导入。',
      recommended: '推荐',
      quality: {
        label: '质量：{{value}}',
        values: {
          basic: '基础',
          balanced: '均衡',
          high: '高'
        }
      },
      speed: {
        label: '速度：{{value}}',
        values: {
          fast: '快',
          balanced: '均衡',
          slow: '慢'
        }
      },
      installed: '已安装并校验',
      availableToDownload: '可从 ModelScope 下载',
      download: '下载',
      importZip: '导入 ZIP',
      exportZip: '导出 ZIP',
      delete: '删除',
      confirmDelete: '确认删除',
      cancel: '取消',
      openRepository: '打开 ModelScope',
      catalogUnavailable: '当前版本没有可用的 OCR 模型目录。',
      mode: 'PDF OCR 策略',
      modes: {
        auto: '自动，仅识别无有效文本的页面',
        always: '始终识别所有页面',
        disabled: '仅使用 PDF 文本层'
      },
      modelLicense:
        '模型采用 Apache License 2.0，并在加载前校验 SHA-256。',
      operations: {
        preparing: '正在准备模型文件',
        downloading: '正在从 ModelScope 下载',
        importing: '正在导入模型 ZIP',
        installing: '正在校验并安装'
      },
      accessibility: {
        downloadModel: '下载 {{name}}',
        importModelZip: '从 ZIP 导入 {{name}}',
        exportModelZip: '将 {{name}} 导出为 ZIP',
        deleteModel: '删除 {{name}}',
        cancelOperation: '取消 {{name}} 操作',
        downloadProgress: '{{name}} 下载进度',
        openRepository: '打开 {{name}} 的 ModelScope 页面'
      },
      notifications: {
        installed: '{{name}} 已安装',
        importedZip: '{{name}} 已从 ZIP 导入',
        exportedZip: '{{name}} 已导出为 ZIP',
        removed: 'OCR 模型已删除'
      }
    },
    advanced: {
      title: '高级解析设置',
      maximumPages: '单文档最大 OCR 页数',
      concurrency: 'OCR 并发数',
      timeout: '每页 OCR 时间预算（秒）',
      concurrencyHint:
        '当前 WASM 基线按页串行执行；该值为后续批处理和硬件加速保留。'
    },
    diagnostic: {
      title: '解析测试结果',
      file: '文件',
      format: '格式',
      method: '处理方式',
      pages: '页数',
      ocrPages: 'OCR 页数',
      characters: '提取字符',
      duration: '耗时',
      preview: '文本预览',
      warnings: '警告',
      methods: {
        native: '原生解析',
        ocr: '本地 OCR',
        mixed: '原生解析与 OCR'
      },
      close: '关闭结果'
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
          '选择已安装模型后保存设置生效；模型可按需下载或通过 ZIP 离线迁移。'
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
