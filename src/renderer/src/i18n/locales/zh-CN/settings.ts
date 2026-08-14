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
      navigationDescription: 'LLM、向量、重排模型与凭据',
      description: 'LLM、向量、重排模型与凭据'
    },
    documentParsing: {
      label: '文档解析',
      navigationDescription: '附件、知识库与本地 OCR',
      description: '统一配置聊天附件和知识库使用的提取、转换与 OCR 策略'
    },
    runtime: {
      label: 'Agent Runtime',
      navigationDescription: 'OpenCode、Continue、DeepSeek Harness 与工作区',
      description: 'OpenCode、Continue、DeepSeek Harness 与工作区'
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
    readEmbeddingStatus: '读取向量模型状态失败',
    requireModelConnection: '请至少配置一个模型连接',
    refreshEmbeddingAfterSave: '设置已保存，但刷新向量模型状态失败',
    speechModelsUnavailable: '当前版本未提供语音模型服务',
    saveSettings: '保存设置失败',
    testModel: '模型连接测试失败',
    testRuntime: 'Runtime 连接测试失败',
    embeddingDiagnosticUnavailable: '向量诊断服务不可用',
    testEmbedding: '向量模型测试失败',
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
    unreadable: '已保存，但当前无法读取',
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
      unavailable: '尚未就绪',
      detecting: '正在检测…',
      notDetected: '尚未检测',
      statusLabel: '状态：',
      pathLabel: '路径：',
      versionLabel: '版本：',
      detailLabel: '检测详情：',
      details: {
        bundled: '内置 {{runtime}}{{versionSuffix}} 已就绪',
        configured: '自定义 {{runtime}}{{versionSuffix}} 已就绪',
        automatic: '已自动检测到 {{runtime}}{{versionSuffix}}'
      }
    },
    workspace: {
      title: '默认工作区',
      description: '当前项目未设置根目录时，Agent 才使用此默认位置',
      directoryLabel: '默认工作区目录'
    },
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
    },
    deepseekHarness: {
      selectorLabel: 'DeepSeek Harness（预览）',
      title: 'DeepSeek Harness',
      previewDescription: '开发者预览 · OpenAI 兼容',
      description:
        '由 GoodBuddy 内部维护固定 Host 与控制协议，复用锁定的 Harness 底层库；Execute 工具调用自动单次授权，Ask 保持只读，并保留取消和工作区安全边界；不接入 DSH 插件或市场机制。',
      managedSource: '管理员预置的 OpenAI 兼容连接',
      connection: 'OpenAI 兼容模型连接',
      connectionPlaceholder: '选择 OpenAI 兼容模型连接',
      connectionDescription:
        '从 GoodBuddy 模型连接中选择；协议必须为 OpenAI Chat Completions，并使用 API Key。',
      advancedDescription:
        '该 Runtime 始终使用 GoodBuddy 内置并固定版本的 Host，不加载外部 DSH 插件、市场包、用户 profile 或自定义 Host。'
    }
  },
  documentParsing: {
    loading: '正在加载…',
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
      localOcrModel: '当前 OCR：{{name}}',
      ocrReady: '模型已安装并通过 SHA-256 校验，可离线使用',
      ocrUnavailable: '模型尚未安装或校验失败，请从 ModelScope 下载',
      partialNotice:
        '基础文档解析可用。旧版 Office 转换尚未实现；扫描 PDF 可按场景模式使用本地 OCR。'
    },
    workflows: {
      title: 'PDF 解析模式',
      description: '直接选择各场景处理 PDF 文本层与扫描页面的方式',
      chat: '聊天与成果文件',
      knowledge: '知识库导入',
      testChat: '测试聊天与成果模式',
      testKnowledge: '测试知识库模式',
      unsavedNotice: '当前有未保存修改；保存后可测试实际生效的模式。',
      chatOptions: {
        auto: '自动识别（推荐）',
        fastText: '仅使用文本层',
        highFidelity: '全页 OCR'
      },
      chatDescriptions: {
        auto:
          '聊天附件和成果 PDF 优先使用文本层，仅对无有效文本的页面使用 OCR。',
        fastText:
          '聊天附件和成果 PDF 仅使用文本层，不运行 OCR；扫描件可能无法读取。',
        highFidelity: '对 PDF 的每一页运行 OCR，速度较慢。'
      },
      knowledgeOptions: {
        completeIndex: '自动识别（推荐）',
        fastIndex: '仅使用文本层',
        highFidelity: '全页 OCR'
      },
      knowledgeDescriptions: {
        'complete-index':
          '优先使用 PDF 文本层，仅对无有效文本的页面使用 OCR。',
        'fast-index':
          '仅使用 PDF 文本层，不运行 OCR；扫描页面不会进入索引。',
        'high-fidelity':
          '对 PDF 的每一页运行 OCR 后再分块和建立索引，速度较慢。'
      }
    },
    ocr: {
      title: 'OCR 识别',
      description: '按需安装本地模型，在设备上识别扫描 PDF',
      modelSelector: '当前 OCR 模型',
      modelSelectorDescription: '选择已保存，聊天附件和知识库将使用此模型。',
      pendingSelection: '模型选择尚未生效，点击“保存设置”后切换。',
      installedOption: '已安装',
      downloadableOption: '可下载',
      unavailableOption: '当前版本不可用',
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
      languages: {
        中文: '中文',
        英语: '英语',
        '50 种语言': '50 种语言'
      },
      catalog: {
        'pp-ocrv6-tiny': {
          displayName: 'PP-OCRv6 Tiny',
          description:
            'PaddleOCR 官方轻量中文 OCR 模型，适合扫描 PDF 和图片的本地 CPU 识别。'
        },
        'pp-ocrv6-small': {
          displayName: 'PP-OCRv6 Small',
          description:
            'PaddleOCR 官方 50 语言 OCR 模型，在识别质量、速度和本地资源占用之间取得平衡。'
        },
        'pp-ocrv6-medium': {
          displayName: 'PP-OCRv6 Medium',
          description:
            'PaddleOCR 官方 50 语言高质量 OCR 模型，识别较慢，并需要更多内存且具有更高延迟。'
        }
      },
      installed: '已安装并校验',
      download: '下载',
      downloadAndSelect: '下载并启用',
      importZip: '导入 ZIP',
      exportZip: '导出 ZIP',
      delete: '删除',
      confirmDelete: '确认删除',
      cancel: '取消',
      openRepository: '打开 ModelScope',
      catalogUnavailable: '当前版本没有可用的 OCR 模型目录。',
      selectedModelUnavailable:
        '已保存的 OCR 模型在当前版本不可用，请从上方选择并安装其他模型。',
      installBeforeSelecting: '请先下载该模型；下载完成后会自动设为当前模型。',
      privacyNotice:
        'OCR 只在需要时由上方场景模式启用，并始终在本机通过 ONNX Runtime WebAssembly 运行，不会上传文档。',
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
        installedAndSelected: '{{name}} 已安装并设为当前模型',
        importedZip: '{{name}} 已从 ZIP 导入',
        importedAndSelected: '{{name}} 已导入并设为当前模型',
        exportedZip: '{{name}} 已导出为 ZIP',
        removed: 'OCR 模型已删除'
      }
    },
    advanced: {
      title: '高级解析设置',
      maximumPages: '单文档最大 OCR 页数',
      timeout: '每页 OCR 时间预算（秒）',
      description:
        '页数限制只计算实际进入 OCR 的页面；单页超过时间预算时会终止本次解析。'
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
      rerank: {
        label: '重排模型',
        description: '配置知识检索候选结果的学习型相关性重排模型。'
      },
      speech: {
        label: '语音模型',
        description:
          '选择已安装模型后保存设置生效；模型可按需下载或通过 ZIP 离线迁移。'
      }
    },
    profile: {
      seededDefaultName: '默认模型',
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
        '直连模型：{{directCapability}} · Continue：{{continueCompatibility}} · OpenCode：{{openCodeCompatibility}} · DeepSeek Harness：{{deepseekHarnessCompatibility}}',
      textChat: '文本对话',
      compatible: '兼容',
      incompatible: '不兼容',
      incompatibleImageProtocol: '不兼容（不支持图像生成协议）',
      incompatibleHarnessProtocol:
        '不兼容（需 Chat Completions、API Key 和安全地址）',
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
    },
    rerank: {
      title: '重排模型连接',
      description: '使用 Cohere 兼容 Rerank 接口提升知识检索排序质量',
      enabled: '启用学习型重排',
      endpoint: '重排接口 URL',
      endpointDescription: '填写完整的 Cohere 兼容 Rerank 端点。',
      modelName: '模型名称',
      optionalApiKey: 'API Key（可选）',
      optionalApiKeyPlaceholder: '本地无认证服务可留空',
      privacyDescription:
        '仅向所填接口发送检索查询和候选知识片段。API Key 由系统安全存储加密；重排服务失败时保留原始检索排序。'
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
        '默认关闭。仅在 Ask 模式且未显式选择专家或团队时，自动选择 1 位专家；子专家使用默认文本模型，只读运行且不使用工具。'
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
