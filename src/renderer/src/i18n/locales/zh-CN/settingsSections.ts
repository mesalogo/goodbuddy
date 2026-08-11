export const settingsSections = {
  speech: {
    title: '语音模型',
    description: '应用不内置模型权重，按需下载或从本地目录导入',
    openModelsDirectory: '打开模型目录',
    storagePrefix: '模型保存在',
    storageSuffix:
      '。自动下载会固定来源版本，并校验文件大小和 SHA-256；也可以从模型仓库手动下载后导入。',
    availableModels: '可用语音模型',
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
      preparingDownload: '正在准备下载',
      importing: '正在导入',
      downloading: '正在下载',
      processingFile: '正在处理 {{file}}'
    },
    status: {
      inUse: '正在使用',
      pendingSave: '待保存',
      installed: '已安装',
      manualImport: '手动导入',
      availableToDownload: '可下载',
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
      import: '导入',
      modelDetails: '模型详情',
      openRepository: '打开模型仓库'
    },
    accessibility: {
      selectModel: '选择 {{name}}',
      notInstalled: '{{name}} 尚未安装',
      cancelOperation: '取消 {{name}} 操作',
      deleteModel: '删除 {{name}}',
      downloadModel: '下载 {{name}}',
      importModel: '从本地目录导入 {{name}}',
      downloadProgress: '{{name}}下载进度',
      openRepository: '打开 {{name}} 模型仓库'
    },
    notifications: {
      installed: '{{name}} 已安装',
      imported: '{{name}} 已从本地目录导入',
      removed: '语音模型已删除'
    },
    details: {
      license: '许可证：',
      licenseSeparator: '。'
    },
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
    title: '向量与知识检索',
    description: '确认模型可用，并管理知识检索使用的向量索引',
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
    },
    index: {
      heading: '知识向量索引',
      rebuildRunning: '重建进行中…',
      rebuild: '重建向量索引',
      emptyTitle: '还没有重建记录',
      emptyDescription:
        '点击“重建向量索引”，为知识文档生成可用于检索的向量。',
      statuses: {
        queued: '重建等待开始',
        running: '正在重建',
        completed: '最近一次重建成功',
        failed: '最近一次重建失败',
        cancelled: '最近一次重建已取消'
      },
      cancelAria: '取消向量索引重建',
      cancel: '取消重建',
      progressAria: '向量索引重建进度',
      completed: '已完成 {{completed}} / {{total}} 篇文档',
      completedWithPeriod: '已完成 {{completed}} / {{total}} 篇文档。',
      completedAt:
        '已完成 {{completed}} / {{total}} 篇文档，完成于 {{date}}。',
      preparing: '正在准备待处理文档…',
      atomicNotice:
        '每篇文档会一次性更新，处理完成后立即可用于检索。取消后，已完成文档会保留，其余文档的原有或缺失状态不变。',
      cancelledNotice:
        '已完成文档保留新向量；其余文档保留原有向量，原本没有向量的仍保持缺失。',
      failedNotice:
        '已完成 {{completed}} / {{total}} 篇文档。发生错误的文档已标记为错误，已完成文档仍可用于检索。',
      remedyPrefix: '处理建议：',
      defaultRemedy: '请检查向量模型配置和网络连接。',
      retrySuffix: '修复后点击“重建向量索引”重试。'
    }
  },
  roles: {
    title: '角色与提示词',
    description: '管理聊天角色及其受信任系统提示词',
    newRole: '新建角色',
    notice:
      '选中的角色会把系统提示词加入本次文本对话。专家团队会并行使用最多 3 个已启用角色；综合模式和专家团队始终继承默认模型，只有单个角色会使用指定连接。图像生成连接不使用角色提示词。',
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
    errors: {
      serviceUnavailable: '当前版本未提供应用设置服务',
      readFailed: '读取平台功能设置失败',
      saveMagicNotesFailed: '保存魔法笔记设置失败，请重试',
      saveCommentModeFailed: '保存 AI 评论方式失败，请重试',
      saveCommentFormatFailed: '保存 AI 评论形式失败，请重试'
    },
    label: '平台功能选项',
    magicNotes: {
      title: '魔法笔记',
      description: '默认关闭；开启后可记录笔记与待办，并使用 AI 分析内容',
      showEntry: '显示魔法笔记入口',
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
    runtimeLabels: {
      model: '模型',
      opencode: 'OpenCode',
      continue: 'Continue'
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
      'Skill 以本地能力说明注入所选目标，不会写入 Runtime 自有配置。新导入的 Skill 默认启用，并分配给直连模型、OpenCode 和 Continue。',
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
  updates: {
    label: '更新设置',
    errors: {
      serviceUnavailable: '当前版本未提供版本检查服务',
      readSettingsFailed: '读取应用设置失败',
      saveSettingsFailed: '保存更新设置失败',
      checkFailed: '版本检查失败',
      network:
        '{{fallback}}：无法连接 GoodBuddy 官方 GitHub Release，请检查网络或代理后重试'
    },
    loadingAppInfo: '正在读取应用信息…',
    checkOnStartup: '启动时检查新版本',
    actions: {
      checking: '正在检查…',
      checkNow: '立即检查更新',
      openDownloadPage: '打开官方下载页'
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
