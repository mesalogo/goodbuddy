export const settingsSections = {
  modelDownloadSources: {
    modelscope: 'ModelScope',
    'hugging-face': 'Hugging Face'
  },
  sshHosts: {
    loading: '正在读取 SSH 主机…',
    loadFailedTitle: 'SSH 主机加载失败',
    listLabel: 'SSH 主机列表',
    securityNotice:
      '添加或编辑主机时，GoodBuddy 会先检查 Host Key，再发送认证凭据并执行有界系统探测。只有全部成功后才会保存主机和加密密码。',
    secureStorageUnavailable:
      '系统安全存储当前不可用，不能新增或替换 SSH 密码。系统 SSH Agent 认证仍可使用。',
    empty: {
      title: '尚未配置 SSH 主机',
      description:
        '通过引导流程核对主机身份、验证认证并探测远端系统。取消或验证失败不会保留新主机。'
    },
    fields: {
      name: '主机名称',
      hostname: '主机地址',
      port: '端口',
      username: '用户名',
      authentication: '认证方式',
      passwordAction: '密码处理',
      password: 'SSH 密码'
    },
    authentication: {
      password: '密码',
      'system-agent': '系统 SSH Agent'
    },
    passwordActions: {
      keep: '保留已保存密码',
      replace: '输入新密码'
    },
    passwordHelp:
      '密码仅用于本次认证，并在验证成功后由 Main 进程写入系统安全存储；不会写入命令行、日志或普通设置文件。',
    credentialSources: {
      none: '尚未配置',
      encrypted: '已由系统安全存储加密',
      'system-agent': '使用系统 SSH Agent',
      unreadable: '已保存，但当前无法读取'
    },
    status: {
      credential: '认证凭据',
      validation: '验证状态',
      validated: '已验证并保存',
      needsValidation: '需要重新验证'
    },
    hostKey: {
      title: 'SSH 主机密钥',
      verified: '已固定',
      unverified: '尚未验证',
      firstUse: '这是首次看到该主机密钥。',
      matches: '本次看到的主机密钥与已固定密钥一致。',
      changed: '主机密钥已变化，可能是服务器重装，也可能是中间人攻击。',
      previousFingerprint: '此前固定的指纹',
      observedFingerprint: '本次看到的指纹',
      verifyOutOfBand:
        '请通过管理员或其他可信渠道核对 SHA-256 指纹。不要仅因为地址看起来正确就接受。',
      confirmedOutOfBand: '我已通过可信渠道核对并确认本次指纹'
    },
    testResult:
      '已连接 · {{platform}}/{{architecture}} · {{latency}} 毫秒',
    environment: {
      title: '远程运行环境',
      description:
        '更新 Host 可能替换 Agent 和 Runtime，并中断正在进行的远程工作；Host 配置和项目文件会保留。',
      loading: '正在读取 Agent 和 Runtime 版本…',
      notChecked:
        '尚未检查版本。本页面不会自动连接主机；点击“刷新版本”可检查版本。',
      methodLabel: '安装方式',
      methodSelectorNamed: '{{name}} 的远程环境安装方式',
      actions: {
        install: '安装远程环境',
        installNamed: '为 {{name}} 安装远程环境',
        update: '更新远程环境',
        updateNamed: '为 {{name}} 更新远程环境',
        reinstall: '重新安装',
        reinstallNamed: '为 {{name}} 重新安装远程环境'
      },
      cancelUpdate: '取消更新',
      cancelUpdateNamed: '取消 {{name}} 的远程运行环境更新',
      cancelling: '正在取消…',
      refresh: '刷新版本',
      refreshNamed: '刷新 {{name}} 的远程运行环境版本',
      progress: {
        preparing: '正在准备安装…',
        probing: '正在检查远程主机环境…',
        downloading: '正在传输运行环境包…',
        verifying: '正在校验运行环境包…',
        applying: '正在应用远程运行环境…',
        'installing-agent': '正在安装 GoodBuddy Agent…',
        'installing-runtime': '正在安装 Runtime…',
        'checking-health': '正在检查远程运行环境…',
        finalizing: '正在完成远程运行环境更新…',
        complete: '远程运行环境安装完成',
        cancelling: '正在取消远程运行环境更新…'
      },
      methods: {
        auto: '自动',
        'remote-download': 'Host 下载',
        'goodbuddy-transfer': 'GoodBuddy 传输'
      },
      sources: {
        github: 'GitHub',
        mirror: '镜像节点'
      },
      remoteDownloadUnavailable: {
        'package-unavailable':
          '当前下载源没有适用于此主机的安装包。仍可通过 GoodBuddy 安装。',
        'missing-tools':
          '远程主机缺少直接下载或解包所需的系统工具。仍可通过 GoodBuddy 安装。',
        'home-unwritable':
          '远程主机的用户目录不可写，无法直接下载安装。请修复权限后刷新，或通过 GoodBuddy 安装。',
        'insufficient-disk-space':
          '远程主机没有足够的可用空间下载安装包。请释放空间后刷新，或通过 GoodBuddy 安装。',
        'source-unreachable':
          '远程主机无法连接所选下载源（{{source}}）。请检查网络后刷新，或通过 GoodBuddy 安装。',
        'probe-failed':
          '无法完成远程主机直连能力检查。可直接重试由远程主机安装、刷新检查，或通过 GoodBuddy 重新安装。'
      },
      remoteDownloadPackageSize: '安装包大小：{{size}}',
      errors: {
        updateFailed: '更新远程运行环境失败，请重试',
        cancelled: '远程运行环境更新已取消，可重试',
        cancelFailed: '取消远程运行环境更新失败',
        reinstallFailedSummary:
          '本次重新安装未完成；正在重新检查当前版本。'
      },
      installed: 'Host 已安装',
      expected: 'GoodBuddy 所需',
      notInstalled: '尚未安装',
      versionDetail: 'Linux · {{architecture}}',
      states: {
        current: '版本匹配',
        'update-available': '待更新',
        'not-installed': '未安装'
      }
    },
    wizard: {
      eyebrow: 'SSH 主机验证',
      createTitle: '添加并验证 SSH 主机',
      editTitle: '编辑并重新验证 SSH 主机',
      description:
        '依次确认连接信息、主机身份和认证。此流程只执行固定系统探针，不会安装远程 Agent。',
      progress: '第 {{current}} / {{total}} 步',
      stepsLabel: 'SSH 主机验证步骤',
      steps: {
        details: '连接信息',
        hostKey: '主机身份',
        authentication: '认证探测',
        success: '完成'
      },
      details: {
        title: '填写连接信息',
        description:
          '下一步只建立认证前 SSH 握手并读取 Host Key，不会发送密码或使用 SSH Agent 签名。',
        passwordUnavailable:
          '系统安全存储不可用，因此当前只能选择系统 SSH Agent。'
      },
      authentication: {
        title: '验证认证和远端系统',
        description:
          'GoodBuddy 将只信任刚刚核对的 Host Key，并运行固定、有超时和输出上限的系统探针。',
        agentHelp:
          '将使用当前系统 SSH Agent。GoodBuddy 不启用 Agent Forwarding，也不会把 Agent 转发到远端。',
        testingTitle: '正在认证并探测远端系统…',
        testingDescription:
          '主机尚未保存。认证失败后可修改凭据并重试。'
      },
      success: {
        title: '主机已验证并保存',
        description:
          '“{{name}}”的 Host Key、认证凭据和连接信息已原子保存。',
        system: '远端系统',
        latency: '连接耗时',
        shell: 'Shell',
        home: 'Home 目录'
      }
    },
    removeMessage:
      '删除“{{name}}”会清除本机保存的连接信息和加密凭据。关联项目只删除本地记录，不会连接主机，也不会删除远端目录或内容。',
    removeProjectsHeading: '同时删除以下关联项目记录：',
    actions: {
      add: '添加主机',
      retry: '重试',
      edit: '编辑',
      validate: '验证并保存',
      editNamed: '编辑 {{name}}',
      validateNamed: '验证 {{name}}',
      inspecting: '正在检查…',
      remove: '删除',
      confirmRemove: '确认删除',
      cancel: '取消',
      closeDialog: '关闭 SSH 主机验证',
      inspectAndContinue: '检查 Host Key',
      back: '上一步',
      continueToAuthentication: '确认身份并继续',
      trustChangedAndContinue: '确认替换并继续',
      validateAndSave: '验证并保存',
      validating: '正在验证…',
      done: '完成'
    },
    validation: {
      nameRequired: '请输入主机名称',
      hostnameRequired: '请输入主机地址',
      portInvalid: '端口必须是 1 到 65535 之间的整数',
      usernameRequired: '请输入用户名',
      confirmFingerprint: '请先通过可信渠道核对并确认 Host Key 指纹',
      passwordRequired: '请输入 SSH 密码',
      passwordStorageRequired:
        '系统安全存储不可用，无法为此配置保存 SSH 密码；请选择系统 SSH Agent'
    },
    errors: {
      unavailable: '当前版本未提供 SSH 主机设置服务',
      readFailed: '读取 SSH 主机失败',
      inspectFailed: '检查 SSH 主机密钥失败',
      validationFailed: 'SSH 认证或远端系统探测失败',
      removeFailed: '删除 SSH 主机失败',
      environmentUnavailable: '远程运行环境版本服务不可用',
      environmentReadFailed: '读取远程运行环境版本失败'
    },
    notifications: {
      removed: 'SSH 主机“{{name}}”已删除',
      environmentUpdated: 'SSH 主机“{{name}}”的远程运行环境已更新'
    }
  },
  speech: {
    title: '语音模型',
    description: '应用不内置模型权重，按需下载或通过 ZIP 离线迁移',
    openModelsDirectory: '打开模型目录',
    modelSelector: '当前语音模型',
    modelSelectorDescription:
      '选择已安装模型后，点击“保存设置”切换语音识别模型。',
    modelSelectorDownloadDescription:
      '当前模型尚未安装，可先下载或从 ZIP 导入。',
    pendingSelection: '模型选择尚未生效，点击“保存设置”后切换。',
    catalogUnavailable: '当前没有可用的语音模型目录。',
    loading: '正在读取语音模型…',
    errors: {
      serviceUnavailable: '当前版本未提供语音模型服务',
      readFailed: '读取语音模型失败',
      operationFailed: '语音模型操作失败'
    },
    quality: {
      basic: '基础质量',
      balanced: '均衡质量',
      high: '高质量'
    },
    speed: {
      fast: '快速',
      balanced: '均衡速度',
      slow: '较慢'
    },
    family: {
      sensevoice: 'SenseVoice',
      paraformer: 'Paraformer',
      whisper: 'Whisper'
    },
    operations: {
      installing: '正在校验并安装',
      preparingImport: '正在准备导入',
      preparingDownloadFrom: '正在准备从 {{source}} 下载',
      importing: '正在导入',
      downloadingFrom: '正在从 {{source}} 下载',
      processingFile: '正在处理 {{file}}'
    },
    status: {
      inUse: '正在使用',
      pendingSave: '待保存',
      installed: '已安装',
      manualImport: '手动导入',
      availableToDownload: '可下载',
      sourceUnavailable: '当前来源不可下载',
      unknownSize: '大小未知'
    },
    tags: {
      recommended: '推荐'
    },
    actions: {
      cancel: '取消',
      delete: '删除',
      confirmDelete: '确认删除',
      download: '下载',
      openDownloadSourceSettings: '前往通用设置',
      importZip: '导入 ZIP',
      exportZip: '导出 ZIP'
    },
    accessibility: {
      cancelOperation: '取消 {{name}} 操作',
      deleteModel: '删除 {{name}}',
      downloadModel: '下载 {{name}}',
      importModelZip: '从 ZIP 导入 {{name}}',
      exportModelZip: '将 {{name}} 导出为 ZIP',
      downloadProgress: '{{name}}下载进度',
      openRepository: '打开 {{name}} 的 {{source}} 模型仓库'
    },
    notifications: {
      installed: '{{name}} 已安装',
      importedZip: '{{name}} 已从 ZIP 导入',
      exportedZip: '{{name}} 已导出为 ZIP',
      removed: '语音模型已删除'
    },
    sourceUnavailableDescription:
      '{{source}} 暂不提供此模型的完整已验证文件。你仍可从 ZIP 导入，或前往通用设置明确更换下载源。',
    languages: {
      中文: '中文',
      粤语: '粤语',
      英语: '英语',
      日语: '日语',
      韩语: '韩语',
      多语言: '多语言'
    },
    catalog: {
      'sensevoice-small-int8': {
        displayName: 'SenseVoiceSmall INT8',
        description:
          '快速中文语音识别，兼顾粤语、英语、日语和韩语，适合本地 CPU 使用。'
      },
      'whisper-tiny-multilingual': {
        displayName: 'Whisper Tiny（多语言）',
        description:
          'OpenAI Whisper Tiny 多语言备选，体积较小，支持中文及多种语言。'
      },
      'paraformer-bilingual-zh-en-int8': {
        displayName: 'Paraformer 中英双语 INT8',
        description:
          '面向普通话与英语的快速离线识别，适合以中文为主并夹杂英文的本地听写。'
      },
      'paraformer-trilingual-zh-yue-en-int8': {
        displayName: 'Paraformer 中粤英三语 INT8',
        description:
          '支持普通话、粤语和英语的离线识别，适合多语混合及粤语输入。'
      },
      'whisper-small-multilingual-int8': {
        displayName: 'Whisper Small（多语言）INT8',
        description:
          '多语言均衡模型，识别质量明显高于 Tiny，适合常规多语言听写。'
      },
      'whisper-medium-multilingual-int8': {
        displayName: 'Whisper Medium（多语言）INT8',
        description:
          '高质量多语言模型，适合更重视准确率且能够接受较慢 CPU 推理的场景。'
      }
    }
  },
  embedding: {
    label: '向量模型',
    title: '向量模型连接',
    description:
      '选择并配置用于向量检索的内置本地模型或 OpenAI 兼容服务。',
    enabled: '启用向量检索',
    currentConnection: '当前连接',
    connections: {
      heading: '连接列表',
      listLabel: '向量模型连接列表',
      empty: '尚无可用的向量模型连接。',
      types: {
        builtin: 'GoodBuddy 内置连接',
        'openai-compatible': 'OpenAI 兼容连接'
      },
      current: '当前使用',
      model: '模型：{{model}}',
      endpoint: '服务地址：{{endpoint}}',
      credentialConfigured: '已配置凭据',
      credentialMissing: '未配置凭据',
      status: '状态：{{status}}',
      modelLabel: '模型',
      statusLabel: '状态'
    },
    actions: {
      addCustom: '添加自定义',
      test: '测试',
      delete: '删除',
      download: '下载',
      cancel: '取消',
      importZip: '导入 ZIP',
      openDownloadSourceSettings: '前往通用设置',
      remove: '移除模型',
      clearCredential: '清除凭据',
      clearAfterSave: '保存后清除凭据'
    },
    accessibility: {
      select: '编辑向量模型连接 {{name}}',
      test: '测试向量模型连接 {{name}}',
      delete: '删除向量模型连接 {{name}}',
      download: '下载 {{name}}',
      cancel: '取消下载 {{name}}',
      import: '从 ZIP 导入 {{name}}',
      remove: '移除本地模型 {{name}}',
      downloadProgress: '{{name}}下载进度',
      importProgress: '{{name}}导入进度'
    },
    tags: {
      recommended: '推荐'
    },
    metadata: {
      dimensions: '{{count}} 维',
      contextTokens: '{{count}} Token 上下文'
    },
    status: {
      installed: '已安装',
      availableToDownload: '可下载',
      sourceUnavailable: '当前来源不可下载',
      unknownSize: '大小未知'
    },
    operations: {
      installing: '正在安装',
      preparingImport: '正在准备导入',
      preparingDownloadFrom: '正在准备从 {{source}} 下载',
      importing: '正在导入',
      downloadingFrom: '正在从 {{source}} 下载',
      processingFile: '正在处理 {{file}}'
    },
    notifications: {
      installed: '{{name}} 已安装',
      importedZip: '{{name}} 已从 ZIP 导入',
      removed: '{{name}} 已移除'
    },
    sourceUnavailableDescription:
      '当前下载源 {{source}} 不提供此模型的完整已验证文件；可切换下载源或从 ZIP 导入。',
    fields: {
      name: '名称',
      endpoint: '向量接口 URL',
      model: '模型名称',
      authentication: '认证方式',
      noAuthentication: '无需认证',
      apiKey: 'API Key（可选）',
      apiKeyPlaceholder: '本地无认证服务可留空',
      configuredPlaceholder: '已配置；输入新值可替换'
    },
    endpointDestination: {
      local: '知识分块和查询将发送到此设备上的 {{host}}。',
      network:
        '建立索引时会向 {{host}} 发送知识分块，检索时会发送查询。'
    },
    model: {
      heading: '当前向量模型',
      configured: '已配置模型',
      provider: '服务提供方：{{provider}}',
      credentialConfigured: '已配置凭据',
      credentialMissing: '未配置凭据',
      endpoint: '服务地址：'
    },
    diagnostic: {
      success: '测试成功',
      failed: '测试失败',
      result: '服务返回 {{dimensions}} 维向量，耗时 {{latency}} 毫秒。',
      checkedAt: '测试时间：{{date}}',
      remedy: '处理建议：{{remedy}}',
      testing: '正在测试…',
      test: '测试向量模型',
      notice: '测试会向当前服务发送一次实际请求，不会更改知识索引。'
    }
  },
  roles: {
    title: '角色与提示词',
    description: '管理聊天角色及其受信任系统提示词',
    newRole: '新建角色',
    notice:
      '单个角色可使用指定模型；综合模式和专家团队始终继承默认模型。',
    listLabel: '角色列表',
    listTitle: '角色列表',
    editRole: '编辑角色 {{name}}',
    noDescription: '暂无说明',
    details: '角色详情',
    fields: {
      name: '角色名称',
      description: '角色说明',
      systemPrompt: '系统提示词',
      systemPromptHelp:
        '作为受信任指令发送给文本模型，请勿写入 API Key 或私人数据。已输入 {{count}} / 20,000 字符。',
      modelConnection: '模型连接',
      modelConnectionAria: '角色模型连接',
      inheritDefault: '继承默认模型',
      inheritDefaultNamed: '继承默认模型（{{name}}）',
      unavailableConnection: '原模型连接已失效',
      modelHelp: '继承默认模型会随默认连接变化；指定连接仅用于单个角色。',
      modelFallbackNamed:
        '指定的模型连接已失效，运行时将回退到默认模型“{{name}}”。请选择可用连接或继承默认模型。',
      modelFallback:
        '指定的模型连接已失效，运行时将回退到当前默认模型。请选择可用连接或继承默认模型。',
      routingKeywords: '路由关键词',
      routingSeparator: '、',
      routingPlaceholder: '例如：代码审查、TypeScript、性能分析',
      routingHelp:
        '使用逗号或换行分隔，保存时会去重并规范化。最多 32 个，每个 2 至 48 个字符。'
    },
    validation: {
      tooManyKeywords: '路由关键词最多 32 个。',
      invalidKeyword: '关键词“{{keyword}}”需为 2 至 48 个字符。'
    },
    errors: {
      readFailed: '读取角色失败',
      saveFailed: '保存角色失败',
      deleteFailed: '删除角色失败'
    },
    delete: {
      confirmAria: '确认删除角色 {{name}}',
      label: '删除角色',
      triggerAria: '删除角色 {{name}}',
      message: '删除后，该角色将从聊天选择和专家团队中移除。'
    },
    actions: {
      cancel: '取消',
      saving: '保存中…',
      save: '保存角色',
      create: '创建角色'
    },
    empty: '还没有角色。新建角色后，可以为它配置系统提示词。'
  },
  platformFeatures: {
    loading: '正在读取平台功能设置…',
    errors: {
      serviceUnavailable: '当前版本未提供应用设置服务',
      readFailed: '读取平台功能设置失败',
      saveRemoteProjectsFailed: '保存远程项目设置失败，请重试',
      saveMagicNotesFailed: '保存魔法笔记设置失败，请重试',
      saveIncompleteTodoCountFailed:
        '保存未完成待办数量设置失败，请重试',
      saveCommentModeFailed: '保存 AI 评论方式失败，请重试',
      saveCommentFormatFailed: '保存 AI 评论形式失败，请重试',
      saveModelDownloadSourceFailed: '保存模型下载源失败，请重试'
    },
    label: '平台功能选项',
    tabs: {
      ariaLabel: '平台功能设置',
      general: '通用设置',
      magicNotes: '魔法笔记'
    },
    remoteProjects: {
      title: '远程项目（技术预览）',
      description: '启用 SSH Host 管理和由 GoodBuddy 托管的远程项目。',
      enabled: '启用远程项目',
      agentInventory: {
        title: 'GoodBuddy Agent 包',
        description:
          'Agent 包独立发布，包含 Agent、固定 Node 和桌面版本适配的远端 OpenCode Runtime。打开此页只读取小型签名目录并显示可用更新，不会自动下载 Agent 包；在线操作使用“关于与更新”中选择的更新源。',
        loading: '正在校验本地 Agent 包并检查在线版本…',
        refresh: '刷新包清单',
        import: '导入离线包',
        export: '导出离线包',
        download: '下载',
        update: '检查并更新',
        updateTo: '更新到 {{version}}',
        downloadVersion: '下载 {{version}}',
        listLabel: '本地 Agent 包清单',
        summary: '当前 {{available}} / {{total}} 个 Linux 架构可用。',
        states: {
          verified: '已下载并验证',
          'not-downloaded': '未下载',
          invalid: '校验失败',
          updateAvailable: '有更新',
          upToDate: '已是最新'
        },
        fields: {
          agentVersion: '本地 Agent',
          latestVersion: '在线最新版本',
          architecture: '架构',
          runtimeVersion: '远端 OpenCode',
          protocol: 'Agent 协议'
        },
        catalog: {
          available:
            '在线版本已通过签名目录检查；只有点击下载或更新后才会传输 Agent 包。',
          unavailable:
            '未能检查在线 Agent 版本：{{error}}。本地已验证包和离线导入仍可使用，可刷新重试。'
        },
        progress: {
          catalog: '正在读取签名发布目录…',
          downloading: '正在下载 Agent 包…',
          verifying: '正在校验签名和完整性…',
          installing: '正在写入本地缓存…'
        },
        notifications: {
          downloaded: 'Linux {{architecture}} Agent 包已更新',
          imported: 'Agent 离线包已导入并验证',
          exported: 'Linux {{architecture}} Agent 包已导出'
        },
        errors: {
          unavailable: '当前版本未提供 Agent 包管理服务',
          readFailed: '读取 Agent 包清单失败，请重试',
          downloadFailed: 'Agent 包下载或校验失败',
          importFailed: 'Agent 离线包导入或校验失败',
          exportFailed: 'Agent 离线包导出失败'
        }
      }
    },
    shortcut: {
      title: '全局快捷唤起',
      description: '在其他应用前台时，也可以显示或隐藏 GoodBuddy。',
      enabled: '启用全局快捷键',
      accelerator: '快捷键',
      recorderHelp:
        '聚焦输入框后直接按下组合键，或填写 Electron accelerator（例如 CommandOrControl+Shift+Space）。',
      reset: '恢复默认',
      save: '保存快捷键',
      saving: '保存中…',
      saved: '全局快捷键已更新',
      loading: '正在读取快捷键状态…',
      status: {
        registered: '已注册：{{shortcut}}',
        disabled: '全局快捷键已停用。',
        conflict: '当前快捷键被其他应用占用，请录制其他组合键后保存。',
        failed: '系统未能注册当前快捷键，请录制其他组合键或检查系统快捷键设置。'
      },
      errors: {
        serviceUnavailable: '当前版本未提供快捷键设置服务',
        readFailed: '读取快捷键设置失败，请重试',
        invalidAccelerator: '快捷键无效，请按下包含修饰键的组合键后重试',
        conflict: '该快捷键已被其他应用占用，请录制其他组合键后重试',
        registrationFailed: '系统未能注册该快捷键，请更换组合键或检查系统快捷键设置',
        saveFailed: '快捷键未能保存，原有可用快捷键已保留，请重试'
      }
    },
    modelDownloadSource: {
      title: '模型下载源',
      description:
        '选择 GoodBuddy 托管本地模型后续下载使用的平台。已安装模型、ZIP 导入、Ollama 模型和应用更新不受影响。',
      options: {
        modelscope: '默认，适合优先访问 ModelScope 的网络环境。',
        'hugging-face': '适合可以稳定访问 Hugging Face 的网络环境。'
      },
      notification: '模型下载源已切换为 {{source}}。'
    },
    magicNotes: {
      title: '魔法笔记',
      description: '默认关闭；开启后可记录笔记与待办，并使用 AI 分析内容',
      showEntry: '显示魔法笔记入口',
      showIncompleteTodoCount: '显示未完成待办数量',
      showIncompleteTodoCountHelp:
        '开启后，左侧魔法笔记入口显示未完成待办数量；超过 99 项显示 99+。',
      commentMode: 'AI 评论方式',
      commentModeAria: '魔法笔记 AI 评论方式',
      modes: {
        immediate: '即时',
        afterSaveAuto: '保存后自动',
        afterSaveManual: '保存后手动'
      },
      commentModeHelp:
        '即时模式会在按回车并停止输入 5 秒后评论未保存草稿；自动模式在保存后评论；手动模式仅在点击 AI 分析后评论。',
      commentFormat: 'AI 评论形式',
      commentFormatAria: '魔法笔记 AI 评论形式',
      formats: {
        combined: '长评 + 要点',
        narrative: '长评',
        structured: '要点'
      },
      commentFormatHelp:
        '默认同时生成流式长评和结构化要点；也可以只保留其中一种。'
    }
  },
  skills: {
    title: 'Skills',
    description: '支持直连模型、OpenCode、Continue 和 DeepSeek Harness',
    runtimeLabels: {
      model: '模型',
      opencode: 'OpenCode',
      continue: 'Continue',
      'deepseek-harness': 'DeepSeek Harness'
    },
    errors: {
      readFailed: '读取 Skills 失败',
      operationFailed: 'Skill 操作失败'
    },
    actions: {
      importDirectory: '导入 Skill 目录',
      importZip: '导入 Skill ZIP',
      delete: '删除'
    },
    listLabel: 'Skills 列表',
    notice:
      '新导入的 Skill 默认启用，并分配给直连模型、OpenCode、Continue 和 DeepSeek Harness。',
    loading: '正在读取 Skills…',
    source: {
      builtin: '内置',
      imported: '已导入'
    },
    versionMissing: '未标注版本',
    enableAria: '启用 {{name}}',
    enabled: '已启用',
    disabled: '已停用',
    assignedTo: '分配给',
    deleteAria: '删除 {{name}}'
  },
  toolEnvironment: {
    loading: '正在读取工具执行环境…',
    scope:
      '工具执行环境仅用于本机项目的新建本地 Runtime 进程和 stdio MCP Server；不会改变终端环境，也不会应用到远程 Host。',
    runtimeSourceLegend: '{{runtime}} 执行来源',
    sources: {
      managed: 'GoodBuddy 托管',
      custom: '自定义环境',
      customDescription: '使用你选择的本机可执行文件。'
    },
    runtimes: {
      node: {
        title: 'Node.js',
        description: '用于需要 Node.js、npm 或 npx 的本机工具。',
        managedDescription:
          '使用 GoodBuddy 随应用托管的 Node.js；无需单独安装或移除。'
      },
      python: {
        title: 'Python',
        description: '用于需要 Python 或 pip 的本机工具。',
        managedDescription:
          '使用 GoodBuddy 托管的 Python；可按需安装、更新或移除。'
      }
    },
    downloadSource: {
      title: '工具下载源',
      description:
        '只控制 GoodBuddy 托管的工具执行环境制品下载，不影响模型、应用更新、终端或远程 Host。',
      legend: '选择工具制品下载源',
      noFallback:
        'GoodBuddy 只访问所选来源；失败时不会自动回退到另一个来源。',
      options: {
        native: {
          label: '原生地址',
          description: '使用 GoodBuddy 默认工具制品来源。'
        },
        oss: {
          label: 'OSS 镜像',
          description: '使用面向内网或镜像网络的 OSS 工具制品来源。'
        }
      }
    },
    selectedPath: '当前自定义路径',
    candidateList: '{{runtime}} 可执行文件候选',
    noCandidates:
      '未发现候选文件。可刷新候选，或从系统文件选择器选择可执行文件。',
    toolStatus: '工具状态',
    companionStatus: '工具链/配套工具状态',
    capabilityDependencyStatus: '能力依赖状态',
    capabilityDependenciesUnverified:
      '尚未获得具体能力的依赖验证证据。',
    status: '状态',
    available: '可用',
    unavailable: '不可用',
    version: '版本',
    path: '路径',
    detail: '详情',
    notDiagnosed: '尚未诊断',
    python: {
      installed: 'GoodBuddy 托管的 Python {{version}} 已安装',
      notInstalled: 'GoodBuddy 托管的 Python {{version}} 尚未安装',
      progressLabel: 'Python 安装或更新进度',
      progressSource: '下载源：{{source}}',
      removeConfirmation:
        '移除后，本机 Runtime 和 stdio MCP 将无法使用此受管 Python，直到重新安装。自定义 Python 不受影响。',
      phases: {
        downloading: '正在下载',
        extracting: '正在解压',
        validating: '正在验证',
        publishing: '正在安装'
      }
    },
    actions: {
      retry: '重试',
      diagnose: '诊断',
      diagnosing: '诊断中…',
      diagnoseAll: '诊断全部',
      refreshCandidates: '刷新候选',
      chooseFile: '选择可执行文件',
      installPython: '安装 Python',
      updatePython: '更新 Python',
      cancel: '取消',
      removePython: '移除 Python',
      confirmRemovePython: '确认移除 Python'
    },
    errors: {
      unavailable: '当前版本未提供工具执行环境服务',
      readFailed: '读取工具执行环境失败',
      saveFailed: '保存工具执行环境设置失败；已恢复此前确认的设置',
      refreshFailed: '刷新可执行文件候选失败',
      selectFailed: '选择 {{runtime}} 可执行文件失败',
      diagnoseFailed: '诊断 {{runtime}} 失败',
      diagnoseAllFailed: '诊断工具执行环境失败',
      installPythonFailed: '安装或更新 Python 失败',
      cancelPythonFailed: '取消 Python 操作失败',
      removePythonFailed: '移除 Python 失败'
    },
    notifications: {
      runtimeChanged: '{{runtime}} 执行来源已更新',
      downloadSourceChanged: '工具下载源已更新',
      pythonInstalled: 'GoodBuddy 托管的 Python 已安装或更新',
      pythonRemoved: 'GoodBuddy 托管的 Python 已移除'
    }
  },
  feedback: {
    entry: {
      title: '帮助改进 GoodBuddy',
      description:
        '报告问题、提出建议或反馈使用体验，我们会在独立反馈系统中处理。',
      action: '提交反馈'
    },
    dialog: {
      title: '提交反馈',
      description:
        '告诉我们遇到的问题或希望改进的地方。提交失败时，当前内容会保留以便重试。'
    },
    categories: {
      bug: '问题',
      feature: '功能建议',
      experience: '使用体验',
      other: '其他'
    },
    fields: {
      category: '反馈类型',
      title: '标题',
      titlePlaceholder: '简要概括问题或建议',
      description: '详细描述',
      descriptionPlaceholder:
        '请描述发生了什么、你期望的结果，以及必要的复现步骤。',
      contactEmail: '联系邮箱（可选）',
      emailPlaceholder: 'user@example.com',
      emailHelp: '仅在需要进一步了解情况时用于联系你。',
      characterCount: '已输入 {{count}} / {{maximum}} 个字符'
    },
    diagnostics: {
      label: '附加最近桌面诊断记录',
      description:
        '默认关闭。选中后仅附加最近桌面诊断的时间、组件、阶段、稳定错误码、错误类型和固定短消息；不包含对话、Prompt、凭据、文件内容、路径、Provider 原始响应或远端 Agent 日志。'
    },
    screenshot: {
      title: '截图（可选）',
      help: '选择或粘贴一张 PNG、JPEG 或 WebP 图片，最大 5 MB。',
      fileInput: '选择反馈截图',
      previewAlt: '待发送反馈截图预览',
      privacy:
        '截图可能包含画面中可见的个人信息，请在发送前检查。',
      unsupported: '仅支持 PNG、JPEG 或 WebP 图片。',
      tooLarge: '截图必须小于或等于 5 MB。',
      invalid: '无法读取该截图，或图片尺寸超出限制。'
    },
    environment: {
      title: '将发送的应用信息',
      version: 'GoodBuddy 版本',
      system: '操作系统',
      locale: '界面语言',
      platforms: {
        windows: 'Windows',
        macos: 'macOS',
        linux: 'Linux',
        unknown: '未知系统'
      }
    },
    privacy:
      '将发送反馈类型、标题、描述、可选邮箱、GoodBuddy 版本、操作系统、架构、界面语言，以及你主动添加的截图。默认不会上传桌面诊断；只有勾选后才会把有界诊断摘要追加到描述。不会发送对话、Prompt、凭据、文件内容、路径、Provider 原始响应或远端 Agent 日志。',
    validation: {
      titleRequired: '请输入反馈标题。',
      descriptionMinimum: '详细描述至少需要 10 个字符。',
      descriptionMaximum:
        '详细描述不能超过 {{maximum}} 个字符；草稿已保留，请缩短后重试。',
      descriptionMaximumWithDiagnostics:
        '附加桌面诊断时，详细描述不能超过 {{maximum}} 个字符；草稿已保留，请缩短后重试。',
      emailInvalid: '请输入有效的联系邮箱，或将其留空。'
    },
    actions: {
      close: '关闭反馈对话框',
      cancel: '取消',
      submit: '提交反馈',
      submitting: '正在提交…',
      retry: '重试提交',
      addScreenshot: '添加截图',
      processingScreenshot: '正在读取截图…',
      replaceScreenshot: '替换截图',
      removeScreenshot: '移除截图',
      copyReference: '复制反馈编号',
      copied: '已复制',
      done: '完成'
    },
    success: {
      title: '反馈已提交',
      description:
        '感谢你的反馈。请保存下面的编号，以便后续沟通。'
    },
    errors: {
      title: '未能提交反馈',
      'invalid-submission':
        '提交内容不符合反馈服务要求，请检查字段和截图后重试。',
      'incompatible-client':
        '当前 GoodBuddy 版本与反馈服务配置不匹配，请更新应用后重试。',
      unavailable: '反馈服务暂时不可用，请稍后重试。',
      busy: '已有一条反馈正在提交，请等待完成后再试。',
      'screenshot-too-large':
        '截图或请求内容过大，请移除截图或更换较小图片后重试。',
      'rate-limited': '提交过于频繁，请稍后再试。',
      'service-error': '反馈服务暂时异常，请稍后重试。',
      network: '无法连接反馈服务，请检查网络后重试。',
      timeout: '连接反馈服务超时，请检查网络后重试。',
      'invalid-response':
        '反馈服务返回了无效结果，请稍后重试。',
      'diagnostics-unavailable':
        '无法读取所选的桌面诊断记录，本次没有发送反馈。草稿和选择已保留，请重试或取消附加诊断后提交。'
    }
  },
  updates: {
    label: '更新设置',
    errors: {
      serviceUnavailable: '当前版本未提供版本检查服务',
      readSettingsFailed: '读取应用设置失败',
      saveSettingsFailed: '保存更新设置失败',
      saveSourceFailed: '保存检查更新源失败',
      checkFailed: '版本检查失败',
      openReleasePageFailed: '打开下载页失败',
      network: '{{fallback}}：请检查系统状态后重试',
      sourceNetwork:
        '{{fallback}}：无法连接更新源“{{source}}”，请检查网络或代理后重试'
    },
    loadingAppInfo: '正在读取应用信息…',
    source: {
      label: '检查更新源',
      description: '用于手动检查、启动时检查和打开下载页。',
      options: {
        github: 'GitHub（默认）',
        mirror: '镜像节点'
      },
      names: {
        github: 'GitHub',
        mirror: '镜像节点'
      }
    },
    checkOnStartup: '启动时检查新版本',
    actions: {
      checking: '正在检查…',
      checkNow: '立即检查更新',
      openDownloadPage: '打开下载页'
    },
    result: {
      available: '发现新版本 {{version}}',
      current: '当前已是最新版本',
      target: '当前 {{version}} · {{platform}}/{{arch}}',
      safety:
        '下载前请在发布页核对文件名和 SHA-256。GoodBuddy 不会自动下载或执行安装包。'
    }
  }
} as const
