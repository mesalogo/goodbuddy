export const app = {
  notifications: {
    success: '成功',
    error: '错误',
    info: '提示',
    close: '关闭通知',
    viewport: '应用通知'
  },
  releaseNotes: {
    eyebrow: '版本更新',
    title: 'GoodBuddy {{version}} 更新内容',
    description: '查看本次版本的主要更新与使用提示。',
    highlights: '本次亮点',
    features: '功能更新',
    fixes: '问题修复',
    notices: '使用前请留意',
    close: '关闭版本更新说明',
    start: '开始使用',
    closing: '正在关闭…',
    acknowledgeFailed: '无法保存已读状态，请重试。'
  },
  window: {
    minimizeAria: '最小化窗口',
    minimize: '最小化',
    maximizeAria: '最大化窗口',
    maximize: '最大化',
    restoreAria: '还原窗口',
    restore: '还原',
    closeAria: '关闭窗口',
    close: '关闭',
    errors: {
      readState: '窗口状态读取失败',
      minimize: '窗口最小化失败',
      resize: '窗口大小切换失败',
      close: '窗口关闭失败'
    }
  },
  navigation: {
    label: '主导航',
    chat: '对话',
    magicNotes: '魔法笔记',
    knowledge: '知识库',
    heartbeat: '智能心跳',
    activity: '运行记录',
    incompleteTodos: '{{count}} 个未完成待办',
    pendingSuggestions: '{{count}} 条待处理建议'
  },
  route: {
    loading: '正在加载页面…',
    loadFailed: '页面组件加载失败，请重新加载应用',
    reload: '重新加载'
  },
  sidebar: {
    label: '主侧栏',
    newConversation: '新建对话',
    searchLabel: '搜索对话',
    searchPlaceholder: '搜索标题或消息',
    recent: '最近会话',
    localWorkspace: '本地工作区',
    loading: '加载中',
    close: '关闭侧栏',
    toggle: '切换侧栏'
  },
  topbar: {
    toggleAssistantSidebar: '切换助手工作栏',
    switchLight: '切换浅色主题',
    switchDark: '切换深色主题'
  },
  conversation: {
    defaultTitle: '新对话',
    remoteTitle: '远程会话',
    greeting:
      '你好，我是 GoodBuddy。你可以直接向我提问、添加本地文件，或使用知识库整理和检索信息。需要我操作文件或调用工具时，请选择合适的 Agent Runtime 和工作模式。',
    interrupted: '上次运行意外中断，可以重新发送问题',
    active: '会话正在活动',
    unread: '未读',
    unreadRemote: '未读远程消息',
    noRemote: '尚无远程会话',
    noMatches: '没有匹配的对话',
    renameAria: '重命名会话 {{title}}',
    saveName: '保存会话名称',
    cancelRename: '取消重命名',
    exportFallbackName: 'GoodBuddy 对话',
    branch: {
      badge: '分支会话，来源：{{title}}',
      suffix: '分支',
      creating: '正在创建分支',
      anotherCreating: '另一条分支正在创建，请稍候',
      storageUnavailable: '会话存储尚未就绪，请稍候',
      unavailable: '会话运行或待发送内容处理完后才能创建分支'
    },
    actions: {
      more: '更多会话操作 {{title}}',
      region: '{{title}} 的会话操作',
      branch: '在新会话中继续',
      rename: '重命名会话',
      copy: '复制完整会话',
      export: '导出 Markdown'
    },
    tasks: {
      toggle: '展开或折叠“{{title}}”中的 {{count}} 个任务',
      list: '“{{title}}”中的任务',
      viewAll: '查看全部 {{count}} 个任务'
    },
    delete: {
      cancelAria: '取消删除对话 {{title}}',
      confirmAria: '确认永久删除对话 {{title}}',
      confirm: '永久删除对话',
      message:
        '将永久删除此会话的全部内容；如果此会话有正在运行的任务，也会同时停止。此操作不可恢复。',
      triggerAria: '删除对话 {{title}}',
      trigger: '删除对话'
    }
  },
  customTask: {
    eyebrow: '定制任务',
    title: '新建定制任务',
    description: '创建一个按计划自动运行，并持续记录在会话中的任务。',
    close: '关闭新建定制任务',
    fields: {
      name: '任务名称',
      instructions: '任务要求',
      destination: '关联会话',
      mode: '执行模式',
      recurrence: '运行频率',
      time: '首次运行'
    },
    destination: {
      current: '当前会话',
      new: '新建会话',
      currentHelp: '把任务关联到当前会话，不更改会话名称或普通聊天能力。',
      newHelp: '为任务创建一条新会话，默认使用任务名称作为标题。',
      currentUnavailable: '当前会话不能关联此任务，请选择新建会话。'
    },
    mode: {
      execute: 'Execute',
      ask: 'Ask',
      executeUnavailable: '当前 Runtime 不支持工具执行，已使用只读 Ask。'
    },
    recurrence: {
      once: '单次',
      daily: '每日',
      weekly: '每周'
    },
    scope: {
      title: '执行范围',
      project: '项目',
      runtime: 'Runtime',
      workspace: '工作目录',
      tools: '工具与审批',
      executeApproval: '使用已授权工具；高风险操作仍需审批',
      askReadOnly: '只读运行，不允许执行变更',
      noWorkspace: '未设置工作目录'
    },
    errors: {
      title: '请输入任务名称。',
      instructions: '请输入任务要求。',
      destination: '请选择可用的关联会话。',
      time: '请选择有效的首次运行时间。',
      futureTime: '首次运行时间必须晚于当前时间。',
      create: '创建任务失败，请重试。',
      projectUnavailable: '请先选择一个可用的普通项目。'
    },
    cancel: '取消',
    create: '创建任务',
    creating: '创建中…'
  },
  runtime: {
    unavailable: 'Runtime 不可用',
    detecting: '正在检测运行时',
    imageGeneration: '生图',
    directModel: '直连模型',
    automatic: '自动',
    automaticSelection: '自动选择',
    modelUnavailable: '模型配置不可用',
    selectModel: '请在设置中重新选择模型',
    ownConfiguration: '自身配置',
    useOwnConfiguration: '使用 {{runtime}} 自身配置',
    switched: '当前对话已切换到 {{label}}',
    selectionUnavailable: '{{label}} 当前不可用：{{detail}}',
    loadingRetry: 'Agent Runtime 正在加载，请稍后重试',
    updatingRetry: 'Agent Runtime 状态正在更新，请稍后重试',
    notSelected: '当前对话尚未选择 Runtime',
    connecting: '正在连接 Agent Runtime',
    pickerTitle: 'Runtime 和模型：{{label}}',
    switching: '切换中…',
    picker: 'Runtime 和模型',
    directModels: '直连模型',
    deepseekHarnessGroup:
      'DeepSeek Harness（开发者预览 · OpenAI 兼容）',
    manage: '管理 Runtime 和模型连接',
    errors: {
      readStatus: 'Agent Runtime 状态读取失败',
      readSettings: 'Runtime 设置读取失败',
      switch: 'Runtime 切换失败'
    }
  },
  chat: {
    heading: '对话内容',
    user: '用户',
    taskResult: '任务结果：{{title}}',
    welcome: {
      title: '今天想一起完成什么？'
    },
    quickActions: {
      summarize: {
        title: '总结一段内容',
        description: '提炼重点并输出行动项',
        prompt: '请帮我总结下面的内容，并列出重点和行动项：\n'
      },
      analyzeError: {
        title: '分析错误信息',
        description: '定位原因并给出排查步骤',
        prompt: '请分析下面的错误信息，给出可能原因和排查步骤：\n'
      },
      write: {
        title: '编写工作内容',
        description: '起草邮件、周报或方案',
        prompt: '请帮我起草一份清晰、专业的工作内容：\n'
      }
    },
    remote: {
      title: '远程通道会话',
      openSettings: '打开设置',
      emptyDescription:
        '请先连接{{project}}，远程用户发送第一条消息后，会话会自动出现在这里。',
      continueInClient:
        '请在 {{client}} 客户端继续发送消息。本窗口用于查看历史、任务与执行结果。',
      waiting: '远程用户发送消息后，会话会自动出现在这里。'
    },
    attachments: {
      label: '附件',
      region: '消息附件',
      exportHeading: '附件：',
      exportItem: '- {{name}}（{{size}}）'
    },
    exportSpeaker: '{{speaker}}：\n{{content}}',
    images: {
      view: '查看',
      download: '下载',
      viewNamed: '查看图片 {{title}}',
      downloadNamed: '下载图片 {{title}}',
      downloadImage: '下载图片',
      closeViewer: '关闭图片查看器',
      fallbackTitle: 'GoodBuddy 图片'
    },
    reasoning: {
      streaming: '正在推理',
      complete: '推理过程'
    },
    contextCompression: {
      compressing: '正在压缩较早对话…',
      completed:
        '已压缩较早对话（估算） · ≈{{before}} → ≈{{after}}',
      failed: '较早对话压缩失败',
      agentCompressing: '正在整理 Agent 执行上下文…',
      agentCompleted:
        'Agent 执行期间已压缩上下文 {{count}} 次（估算） · ≈{{before}} → ≈{{after}}',
      agentFailed: 'Agent 执行上下文压缩失败'
    },
    sources: '来源：{{sources}}',
    citations: {
      view: '查看 {{count}} 条证据引用',
      retrieval: '检索：',
      fullText: '全文',
      cjk: '中文词组',
      vector: '向量',
      graph: '图谱',
      viewContext: '查看上下文',
      openSource: '打开来源',
      openFailed: '无法打开引用来源',
      contextTitle: '引用上下文',
      contextDescription: '查看本次命中的分块及其相邻内容。',
      contextLoading: '正在读取引用上下文…',
      contextUnavailable: '引用上下文不可用',
      contextTruncated: '上下文超过安全展示上限，已截断。',
      closeContext: '关闭引用上下文',
      matchedChunk: '命中分块',
      surroundingContext: '完整上下文',
      score: '相关度 {{score}}'
    },
    knowledgeRetrieval: {
      searching: '正在检索已启用的知识库',
      states: {
        searching: '正在检索知识库',
        succeeded: '知识检索完成',
        zero: '未找到相关知识',
        degraded: '知识检索已降级',
        failed: '知识检索失败',
        cancelled: '知识检索已取消'
      },
      summary:
        '已检索 {{libraries}} 个知识库，获得 {{results}} 条结果，用时 {{duration}} 毫秒',
      channels: '使用通道：{{channels}}',
      channelNames: {
        fts: '全文',
        cjk: '中文词组',
        vector: '向量',
        graph: '图谱'
      }
    },
    retry: '重新编辑并发送',
    loadEarlierMessages: '加载更早的消息（还剩 {{count}} 条）',
    scrollToBottom: '到底部',
    status: {
      responseTruncated: '回答过长，已在本地截断显示',
      savingImage: '图片已生成，正在保存结果',
      taskCompleted: '任务执行完成',
      taskFailed: '任务执行失败',
      runtimeCompleted: 'Agent Runtime 已完成响应',
      answerSubmitted: '回答已提交，OpenCode 正在继续执行',
      questionSkipped: '已跳过问题'
    },
    tools: {
      region: '工具执行，共 {{count}} 项',
      title: '工具执行',
      count: '{{count}} 项',
      input: '调用参数',
      output: '执行结果',
      error: '错误详情',
      noDetails: '暂时没有可显示的执行详情。',
      states: {
        pending: '等待中',
        running: '进行中',
        completed: '已完成',
        failed: '失败',
        recoverable: '可重试',
        cancelled: '已取消',
        interrupted: '已中断'
      }
    },
    subagents: {
      region: '子专家状态',
      smart: '智能路由',
      manual: '手动指定',
      fallbackTask: '{{name}} 子专家任务',
      output: '专家输出',
      error: '执行说明',
      noOutput: '该专家暂时没有可显示的输出。',
      states: {
        queued: '等待中',
        running: '进行中',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消'
      }
    },
    approval: {
      deny: '拒绝',
      once: '仅此次',
      session: '此会话',
      permanent: '永久允许',
      decisionDeny: '拒绝',
      decisionOnce: '仅此次允许',
      decisionSession: '此会话允许',
      decisionPermanent: '永久允许',
      executing: '{{decision}}，Agent 正在执行',
      denied: '已拒绝工具执行',
      responseFailed: '审批响应失败，请重试'
    }
  },
  composer: {
    menuSelection: '{{label}}：{{selection}}',
    inputLabel: '向 GoodBuddy 提问',
    placeholder: '给 GoodBuddy 发消息…',
    imagePlaceholder: '描述你想生成的图片…',
    keyboardHint:
      'Enter 发送，Shift+Enter 换行，Ctrl+V 粘贴图片或文本',
    addContent: '添加内容',
    addAttachment: '添加附件',
    attachmentProgress: {
      selecting: '正在选择附件…',
      reading: '正在读取 {{name}}',
      parsing: '正在解析 {{name}}',
      waiting: '选择文件后将自动读取并解析',
      fileCount: '第 {{current}} / {{total}} 个文件',
      progressLabel: '附件读取与解析进度',
      waitBeforeSending: '附件仍在解析，请等待完成后再发送'
    },
    removeAttachment: '移除 {{name}}',
    settings: '对话设置',
    expertLabel: '专家角色',
    modeLabel: '工作模式',
    runtimeControls: {
      groupLabel: '{{runtime}} 专属功能',
      agentLabel: 'OpenCode Runtime Agent',
      presetLabel: 'Continue 配置预设',
      actionLabel: 'Runtime 快捷操作',
      configuredAgent: '默认 · {{name}}',
      runtimeDefaultAgent: 'OpenCode 默认 Agent',
      runtimeDefaultAgentDescription: '使用设置中保存的默认 Runtime Agent',
      agentDescription: 'OpenCode 原生 Runtime Agent',
      noPreset: '使用设置默认预设',
      noPresetDescription: '按 Runtime 设置应用默认 Continue 预设',
      presetDescription:
        '{{rules}} 条启用 Rule · {{prompts}} 个 Prompt',
      noAction: 'Runtime 快捷操作',
      noActionDescription: '直接发送输入内容',
      commandDescription: '执行 OpenCode Command',
      promptDescription: '填入 Prompt 后可继续编辑'
    },
    stop: '停止生成',
    send: '发送',
    sendTitle: '发送消息',
    queueMessage: '加入待发送队列',
    queueMessageTitle: '当前回复结束后按顺序发送',
    queue: {
      ariaLabel: '对话待发送队列',
      scheduledTask: '定时任务',
      message: '消息',
      interrupt: '立即中断并插入',
      runNow: '立即运行',
      interruptAria: '中断当前回复并优先执行“{{title}}”',
      runNowAria: '立即运行“{{title}}”',
      remove: '删除',
      removeAria: '从待发送队列删除“{{title}}”',
      actionFailed: '待发送队列操作失败'
    },
    shortcut: '快捷唤起：',
    context: {
      confirmedTokenCount: '本次调用 {{used}}',
      tokenCount: '本次调用估算 ≈{{used}}',
      confirmedWindowUsage:
        '本次调用 {{used}} / {{total}} · {{percentage}}%',
      windowUsage:
        '本次调用估算 ≈{{used}} / {{total}} · {{percentage}}%',
      confirmedThresholdUsage:
        '本次调用 {{used}} · 压缩线 {{total}}',
      thresholdUsage:
        '本次调用估算 ≈{{used}} · 压缩线 {{total}}',
      conversationTokenCount: '压缩后对话估算 ≈{{used}}',
      conversationWindowUsage:
        '压缩后对话估算 ≈{{used}} / {{total}} · {{percentage}}%',
      conversationThresholdUsage:
        '压缩后对话估算 ≈{{used}} · 压缩线 {{total}}',
      progressLabel: '当前上下文使用量',
      compressionTrigger: '自动压缩线：≈{{tokens}}',
      compact: '压缩上下文',
      compacting: '正在压缩…',
      nothingToCompact: '当前没有可压缩的较早对话历史',
      compactFailed: '上下文压缩失败'
    },
    experts: {
      general: '通用助手',
      generalDescription: '默认单助手',
      team: '专家团队（并行）',
      teamDescription: '多个专家并行协作',
      customDescription: '自定义专家角色'
    },
    modes: {
      ask: {
        label: 'Ask · 只读问答',
        description: '只读问答，不修改文件'
      },
      execute: {
        label: 'Execute · 完全权限',
        description: '使用当前账号的完整权限执行工具操作'
      }
    },
    voice: {
      stopRecording: '停止录音',
      cancel: '取消语音识别',
      input: '语音输入',
      stopAndRecognize: '停止录音并开始识别',
      description: '语音转文字，转写后可编辑再发送',
      unsupported: '当前系统不支持内置语音识别，可继续使用键盘输入',
      downloadingPack: '正在下载中文离线语音包，完成后将自动开始听写',
      transcribed: '语音已转为文字，可编辑后发送',
      localListening: '正在使用本地语音识别听写',
      systemListening: '正在使用系统语音服务听写',
      startFailed: '无法启动语音识别，请检查系统语音设置',
      microphoneUnavailable:
        '当前系统无法访问麦克风，请检查系统录音设备和权限',
      recording: '正在录音，再次点击语音按钮即可结束并识别',
      localRecognizing: '正在使用本地语音模型识别',
      noSpeech: '没有识别到语音，请靠近麦克风后重试',
      cancelled: '语音识别已取消',
      localFailed: '本地语音识别失败',
      permissionDenied:
        '麦克风权限被拒绝，请在系统隐私设置中允许 GoodBuddy 使用麦克风',
      recordingStartFailed: '无法开始录音',
      preparing: '录音完成，正在准备本地识别',
      serviceNotLoaded:
        '本地语音识别服务未加载，请重启 GoodBuddy 后重试',
      availabilityTimeout: '检查中文离线语音包超时，请确认网络后重试',
      downloadTimeout: '中文离线语音包下载超时，请检查网络后重试',
      packDownloading: '中文离线语音包正在下载，请稍后重试',
      recordingCancelled: '语音录音已取消',
      noRecording: '没有录到声音，请检查麦克风后重试',
      errors: {
        aborted: '语音识别已取消',
        audioCapture: '未检测到可用麦克风，请检查设备连接和系统输入设置',
        languageNotSupported: '当前系统没有可用的中文语音识别包',
        network: 'Electron 在线语音服务不可用，请安装中文离线语音包后重试',
        noSpeech: '没有检测到语音，请靠近麦克风后重试',
        permission:
          '麦克风权限被拒绝，请在系统隐私设置中允许 GoodBuddy 使用麦克风',
        phrasesNotSupported: '当前语音识别服务不支持短语增强',
        badGrammar: '当前语音识别服务无法处理语法配置',
        generic: '语音识别失败，请检查麦克风和系统语音设置'
      }
    },
    knowledge: {
      select: '选择知识库，本次已启用 {{count}} 个',
      title: '选择本次对话检索的知识库',
      scope: '本次对话检索范围',
      documents: '{{count}} 个文档',
      modeLabel: '知识检索方式',
      auto: '模型决定',
      always: '每次先检索',
      autoDescription: '由模型判断当前问题是否需要查询知识库。',
      alwaysDescription: '在模型回答前，由 GoodBuddy 先查询一次已启用知识库。'
    },
    hints: {
      configureRuntime: '请先配置可用的模型或 Agent Runtime。',
      imageGeneration:
        '图像生成模型：输入画面描述后，生成结果会直接显示并保存到成果。',
      agentAsk:
        '{{runtime}} Ask 模式：只允许搜索当前启用的知识库，不会修改文件。',
      agentExecute:
        '{{runtime}} Execute 模式：工具调用不会弹出 GoodBuddy 审批，并会记录到活动。',
      ask: 'Ask 模式：只读问答，不会调用工具或修改文件。',
      execute: 'Execute 模式：已启用工具自动授权，调用仍会记录到活动。'
    },
    errors: {
      pasteImageType: '仅支持粘贴 JPEG、PNG 或 WebP 图片',
      pasteImageSize: '粘贴图片不能超过 12MB',
      attachmentLimit: '单次消息最多添加 8 个附件',
      addContext: '添加上下文失败'
    }
  },
  notices: {
    updateAvailable: '发现 GoodBuddy {{version}}，可在“关于与更新”中查看',
    remoteProjectActivated: '远程项目 Agent 和 Runtime 已就绪',
    remoteProjectActivationFailed:
      '远程项目更新失败：{{message}}。请检查 Host 后重试',
    remoteProjectActivationUnknownError: '未知错误',
    remoteProjectReactivating: '远程项目正在重新连接，请稍候',
    remoteProjectReconnectRequired:
      '远程项目需要重新连接，请重新选择当前项目后再发送',
    remoteProjectActivationCancelled: '已取消远程项目连接',
    remoteProjectActivationCancelFailed:
      '取消远程项目连接失败：{{message}}',
    remoteProjectActivationCancelUnknownError:
      '取消远程项目连接失败，请重试',
    channelConversationAutomatic:
      '通道项目的会话由客户端收到新消息后自动创建',
    deleteConversationCancelFailed:
      '停止会话中的运行任务失败，尚未删除对话',
    deleteConversationPersistenceFailed:
      '删除本地会话失败，已保留当前对话',
    deletedConversationBrowserCloseFailed: '关闭已删除对话的浏览器失败',
    conversationCopied: '对话已复制到剪贴板',
    clipboardUnavailable: '无法访问剪贴板，请检查系统权限',
    conversationExported: '对话已导出',
    conversationBranched: '已创建并打开分支会话',
    conversationBranchFailed: '创建分支会话失败，请重试',
    imageUnavailable: '图片内容不可用',
    imageDownloadStarted: '图片下载已开始',
    remoteConversationReadOnly: '远程通道会话只能从对应消息应用继续发起',
    sendFailed: '发送失败',
    stopFailed: '停止生成失败，请重试',
    projectNotLoaded: '当前项目尚未加载。',
    browserControlUnavailable: '内置浏览器组件尚未加载，请重启 GoodBuddy',
    browserStopFailed: '停止浏览器失败，请重试',
    scheduleStarted: '定时任务已加入待执行队列',
    conversationQueueReadFailed: '待发送队列读取失败',
    conversationQueueReleaseFailed:
      '消息执行失败，且无法恢复到待发送队列',
    conversationQueueResumeFailed:
      '无法继续执行当前对话的待发送队列',
    conversationPersistenceFailed: '会话持久化失败，请检查本地存储',
    remoteConversationRefreshFailed: '远程通道会话刷新失败',
    projectReadFailed: '项目读取失败',
    expertsReadFailed: '专家角色读取失败',
    appInfoReadFailed: '应用信息读取失败',
    workspaceChangesReadFailed: '工作区文件更改读取失败',
    tokenUsageReadFailed: 'Token 用量读取失败',
    resultsRefreshFailed: '成果列表刷新失败',
    generatedImageReadFailed: '生成图片读取失败',
    remoteMessage: '{{channel}} 收到新消息',
    memoryReadFailed: '长期记忆读取失败',
    schedulesReadFailed: '定时任务读取失败',
    taskHistoryReadFailed: '历史任务读取失败',
    resultHistoryReadFailed: '历史成果读取失败',
    knowledgeReadFailed: '本地知识库读取失败',
    selectProject: '请先选择项目',
    heartbeatReadFailed: '智能心跳读取失败',
    heartbeatRefreshFailed: '智能心跳刷新失败',
    heartbeatTaskPrompt: '请根据以下智能心跳建议制定可执行方案：',
    heartbeatTaskAdded: '已将“{{title}}”带入对话，请确认后发送',
    userStartedTask: '用户发起对话任务',
    userDecision: '用户选择了{{decision}}',
    conversationDeleted: '对应对话已被删除',
    localDataCleared:
      '本地对话、任务、记忆、心跳、自动化和知识库索引已清除',
    selectKnowledgeBase: '请先选择知识库',
    knowledgeGraphRebuilt: '知识图谱已重新抽取',
    knowledgeSettingsUpdated: '知识库设置已更新',
    knowledgeRebuildCompleted: '已重建 {{count}} 个文档',
    knowledgeRebuildPartial:
      '知识库重建未全部完成：成功 {{rebuilt}} 个，失败 {{failed}} 个',
    knowledgeRebuildNotRunning: '当前没有可取消的知识库重建任务',
    knowledgeTaskNotRunning: '该任务已结束或当前无法取消',
    evidenceExcerpt: '{{source}}：{{excerpt}}'
  },
  markdown: {
    scrollableTable: '表格，可横向滚动',
    mermaidDiagram: 'Mermaid 图表，可横向滚动',
    mermaidLoading: '正在绘制 Mermaid 图表…',
    mermaidError: '无法绘制 Mermaid 图表，已保留原始图表代码。',
    mermaidActions: 'Mermaid 图表操作',
    mermaidViewSource: '查看源码',
    mermaidHideSource: '隐藏源码',
    mermaidOpenViewer: '打开大图',
    mermaidViewerTitle: 'Mermaid 大图',
    mermaidViewerHint: '使用滚轮或按钮缩放，拖动画布浏览。',
    mermaidViewerCanvas: '可缩放、可拖动的 Mermaid 图表',
    mermaidZoomOut: '缩小图表',
    mermaidZoomIn: '放大图表',
    mermaidResetZoom: '重置缩放',
    mermaidZoomLevel: '当前缩放比例',
    mermaidCloseViewer: '关闭 Mermaid 大图'
  }
} as const
