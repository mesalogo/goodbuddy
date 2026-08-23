export const knowledge = {
  page: {
    title: '知识库',
    description: '管理文件、目录和网页来源，并查看索引与图谱。'
  },
  actions: {
    cancel: '取消',
    createLibrary: '创建知识库',
    creating: '创建中…',
    newLibrary: '新建知识库',
    saveChanges: '保存修改',
    saving: '保存中…',
    confirmDelete: '确认删除',
    deleting: '删除中…',
    importFiles: '导入文件',
    importDirectory: '导入目录',
    importUrl: '导入 URL',
    import: '导入',
    pause: '暂停',
    retry: '重试',
    sync: '同步',
    remove: '移除',
    saveEntity: '保存实体',
    addEntity: '新增实体',
    saveRelation: '保存关系',
    addRelation: '新增关系',
    reextract: '重新抽取',
    reextracting: '重新抽取中…',
    edit: '编辑',
    delete: '删除',
    add: '新增',
    viewTasks: '查看任务',
    backToLibraryList: '返回知识库列表',
    goToSettings: '前往设置'
  },
  fields: {
    name: '名称',
    description: '描述',
    storageMode: '存储方式',
    graphGenerationStrategy: '图谱生成策略',
    graphExtractionStrategy: '图谱抽取策略',
    type: '类型',
    aliases: '别名（使用逗号分隔）',
    source: '起点',
    target: '终点',
    relationType: '关系类型',
    notes: '说明'
  },
  storageModes: {
    reference: {
      label: '引用原文件',
      description: '仅记录文件位置；删除知识库不会删除原文件。'
    },
    managed: {
      label: '托管副本',
      description: '将内容复制到应用管理的存储空间。'
    }
  },
  strategies: {
    rules: '规则抽取',
    model: '模型抽取',
    hybrid: '规则与模型',
    ask: '按需询问'
  },
  sourceStatuses: {
    queued: '等待同步',
    syncing: '同步中',
    paused: '已暂停',
    ready: '已同步',
    failed: '同步失败'
  },
  documentStatuses: {
    queued: '等待处理',
    parsing: '解析中',
    indexing: '索引中',
    ready: '索引完成',
    failed: '处理失败'
  },
  taskKinds: {
    sourceSync: '来源同步',
    documentProcess: '文档处理',
    documentRebuild: '文档重建',
    libraryRebuild: '知识库重建',
    embeddingRebuild: '向量索引重建',
    graphRebuild: '知识图谱重建',
    parsing: '文档解析',
    embedding: '向量化',
    graph: '图谱抽取'
  },
  taskStages: {
    queued: '等待调度',
    syncing: '同步来源',
    reading: '读取内容',
    parsing: '解析文档',
    chunking: '生成分块',
    indexing: '建立索引',
    embedding: '生成向量',
    graph: '抽取图谱',
    finalizing: '完成收尾'
  },
  taskStatuses: {
    queued: '等待中',
    running: '进行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    skipped: '已跳过',
    interrupted: '已中断'
  },
  taskScopes: {
    library: '知识库范围',
    source: '来源范围',
    document: '文档范围'
  },
  format: {
    neverSynced: '尚未同步',
    unknownTime: '时间未知',
    unknownSize: '大小未知',
    localFile: '本地文件',
    localFileNamed: '本地文件 · {{filename}}',
    listSeparator: '、'
  },
  validation: {
    libraryNameRequired: '请输入知识库名称。',
    urlRequired: '请输入 URL。',
    urlInvalid: '请输入有效的 URL。',
    urlProtocol: '仅支持 HTTP 或 HTTPS URL。'
  },
  errors: {
    operationFailed: '操作未完成，请重试。',
    refreshTitle: '知识库刷新失败',
    loadTitle: '知识库加载失败'
  },
  create: {
    ariaLabel: '创建知识库',
    eyebrow: '新建知识库',
    title: '创建知识库'
  },
  edit: {
    ariaLabel: '编辑知识库',
    formAriaLabel: '编辑知识库表单',
    title: '编辑知识库',
    description: '修改名称和说明不会改变来源、索引或知识图谱。'
  },
  delete: {
    ariaLabel: '删除知识库确认',
    title: '删除“{{name}}”？',
    managedDescription:
      '此知识库使用托管存储。删除后，应用保存的托管副本、索引和图谱都会被永久删除。',
    referenceDescription:
      '此知识库引用原文件。删除后只会移除索引和图谱，不会删除磁盘上的原文件。',
    triggerAriaLabel: '删除知识库 {{name}}'
  },
  retrieval: {
    eyebrow: '当前知识库：{{libraryName}}',
    title: '检索测试',
    description:
      '临时参数仅用于本次测试；不会创建对话、调用大模型或修改知识内容。',
    close: '关闭检索测试',
    query: {
      title: '测试问题',
      label: '检索问题',
      placeholder: '例如：如何为离线环境配置文档解析？',
      count: '{{count}} / 4000 字'
    },
    settings: {
      title: '本次测试参数',
      temporary: '这些调整只影响本次测试。需要长期使用时，请保存为当前知识库默认值。',
      groups: {
        recall: {
          title: '候选召回'
        },
        output: {
          title: '重排与上下文'
        }
      },
      candidateMultiplier: '召回倍数',
      candidateMultiplierHelp: '范围 2 至 10；当前最多召回 {{count}} 个融合候选',
      channelWeights: '通道融合占比（合计 100%）',
      topK: '最终结果数',
      topKHelp: '重排后保留 1 至 20 个结果',
      vectorSimilarity: '最低向量相似度（%）',
      vectorSimilarityHelp: '范围 0% 至 100%；0% 表示不过滤低相似度结果',
      ftsWeight: '全文占比',
      vectorWeight: '向量占比',
      graphWeight: '图谱占比',
      weightHelp: '按相对占比参与融合；可用通道建议合计 100%',
      graphUnavailable: '当前知识库未启用图谱，此权重暂不生效。',
      contextBudget: '上下文字符预算',
      contextBudgetHelp: '范围 2,000 至 48,000',
      adjacentCount: '相邻分块数',
      adjacentCountHelp: '向前和向后各合并 0 至 2 个分块',
      localRerank: '启用本地重排',
      localRerankHelp:
        '对本次召回的全部融合候选进行确定性重排，不调用额外 AI 模型，因此无需单独设置重排数量。',
      rerankMode: '重排方式',
      rerankModeHelp:
        '学习型重排调用已配置的 Cohere/Jina 兼容模型，并显示安全的降级原因。',
      rerankModes: {
        none: '不重排',
        local: '本地规则',
        learned: '学习型模型'
      }
    },
    validation: {
      queryRequired: '请输入测试问题。',
      queryTooLong: '测试问题不能超过 4,000 字符。',
      topK: 'Top K 必须是 1 至 20 的整数。',
      candidateMultiplier: '召回倍数必须是 2 至 10 的整数。',
      vectorSimilarity: '最低向量相似度必须在 0% 至 100% 之间。',
      weight: '通道融合占比必须在 0% 至 100% 之间。',
      weightTotal: '当前可用检索通道的融合占比合计必须为 100%。',
      activeWeight: '至少一个当前可用的检索通道权重必须大于 0。',
      contextBudget: '上下文预算必须是 2,000 至 48,000 的整数。',
      adjacentCount: '相邻分块数必须是 0 至 2 的整数。'
    },
    actions: {
      test: '测试检索',
      running: '正在检索…',
      saveDefaults: '保存为默认值',
      savingDefaults: '正在保存…',
      viewContext: '查看分块',
      openSource: '打开来源'
    },
    states: {
      runningTitle: '正在检索当前知识库',
      runningDescription: '正在扫描有界候选并拼装上下文，请稍候。',
      errorTitle: '检索测试失败',
      errorDescription: '请检查知识库索引状态或调整参数后重试。'
    },
    channels: {
      fts: '全文',
      cjk: '中文',
      vector: '向量',
      graph: '图谱'
    },
    diagnostics: {
      duration: '总耗时',
      milliseconds: '{{count}} 毫秒',
      requested: '请求通道',
      used: '实际通道',
      none: '无',
      vectorScanned: '已扫描向量',
      channelSummary: '{{candidates}} 个候选 · {{duration}} 毫秒',
      degradedTitle: '本次检索已降级',
      rerank: '重排',
      rerankSummary:
        '请求 {{requested}}，使用 {{used}} · {{status}} · {{count}} 个候选 · {{duration}} 毫秒',
      rerankStatuses: {
        skipped: '已跳过',
        applied: '已应用',
        fallback: '已降级',
        failed: '失败'
      }
    },
    zero: {
      'empty-library': {
        title: '当前知识库没有可检索内容',
        description: '请先导入并完成文档索引，然后再次测试。'
      },
      'index-unavailable': {
        title: '当前索引不可用',
        description: '请检查文档的解析与索引状态，修复失败项后重试。'
      },
      'no-match': {
        title: '未找到相关内容',
        description: '请尝试更换关键词、使用资料中的具体名称或扩大 Top K。'
      },
      filtered: {
        title: '结果已被阈值过滤',
        description: '请降低最低向量相似度或检查各通道权重后重试。'
      }
    },
    results: {
      title: '检索结果（{{count}}）',
      contextSummary: '最终上下文 {{count}} / {{budget}} 字符',
      truncated: '已截断',
      listAriaLabel: '检索结果列表',
      resultAriaLabel: '第 {{rank}} 条结果，{{documentName}}',
      unknownLocator: '定位未知',
      relevance: '相关度',
      fusedScore: '融合分数',
      channelDetail: '排名 {{rank}} · 原始分数 {{score}} · 相似度 {{similarity}}',
      beforeRerank: '重排前排名',
      context: '上下文',
      contextDetail: '{{count}} 字符 · {{truncated}}',
      complete: '完整',
      diagnostics: '结果诊断',
      actualContext: '查看实际上下文'
    }
  },
  chunks: {
    title: '文档分块',
    documentUnavailable: '该检索结果对应的文档当前不可用。',
    description: '搜索、预览和维护该文档的有界分块列表。',
    close: '关闭文档分块',
    listAriaLabel: '文档分块列表',
    syncWarningTitle: '人工修改可能被替换。',
    syncWarning:
      '来源再次同步或重建文档时，可能按原始内容重新创建分块。删除分块不会删除原始文件。',
    search: {
      label: '搜索文档内分块',
      placeholder: '搜索标题、定位或内容',
      action: '搜索'
    },
    loadErrorTitle: '分块操作未完成',
    loadingTitle: '正在加载分块',
    loadingDescription: '正在读取当前页的分块内容。',
    zeroTitle: '没有符合条件的分块',
    zeroDescription: '请修改搜索词，或重建文档以重新生成分块。',
    ordinal: '分块 {{count}}',
    headingSeparator: ' · {{heading}}',
    parentMetadata: ' · 父块 {{parentId}}',
    unknownLocator: '定位未知',
    characterCount: '{{count}} 字符',
    enabled: '参与检索',
    enabledAriaLabel: '启用分块 {{count}}',
    roles: {
      standalone: '独立块',
      parent: '父块',
      child: '子块'
    },
    pagination: {
      ariaLabel: '分块分页',
      previous: '上一页分块',
      next: '下一页分块',
      summary: '第 {{page}} / {{total}} 页，共 {{count}} 个'
    },
    editor: {
      title: '编辑分块 {{count}}',
      metadata: '{{role}} · {{locator}}',
      manuallyEdited: '人工修改',
      role: '分块角色',
      parent: '父块 ID',
      content: '分块内容',
      count: '{{count}} / {{max}} 字符',
      save: '保存分块',
      saving: '正在保存…',
      noSelectionTitle: '选择一个分块',
      noSelectionDescription: '从左侧列表选择分块以查看完整内容和父子关系。'
    },
    validation: {
      contentRequired: '分块内容不能为空。',
      contentTooLong: '分块内容不能超过 {{count}} 字符。'
    },
    delete: {
      trigger: '删除分块',
      triggerAriaLabel: '删除分块 {{count}}',
      confirmAriaLabel: '确认删除分块 {{count}}',
      confirm: '确认删除分块',
      deleting: '正在删除…',
      message:
        '删除分块 {{count}} 会移除其全文、中文、向量和图谱证据。来源同步或重建可能重新创建此分块；原始文件不会被删除。'
    },
    rebuild: {
      action: '重建文档',
      running: '正在重建…',
      description: '重建会重新读取来源；失败时应保留上一版可用索引。'
    }
  },
  graph: {
    title: '知识图谱',
    enable: '启用知识图谱',
    enableDescription: '从文档中提取实体、关系与证据。',
    unknownEntity: '未知实体',
    selectEntity: '选择实体',
    sidebar: {
      ariaLabel: '图谱侧栏',
      topology: '拓扑',
      details: '详情'
    },
    canvasAriaLabel: '知识图谱画布',
    searchAriaLabel: '搜索图谱实体',
    searchPlaceholder: '搜索实体',
    typeFilterAriaLabel: '筛选实体类型',
    allTypes: '全部类型',
    entityPickerAriaLabel: '选择图谱实体',
    zoomOutAriaLabel: '缩小图谱',
    zoomInAriaLabel: '放大图谱',
    fitView: '显示全部',
    interactionHint: '拖动节点调整位置；拖动画布平移，滚轮缩放。',
    empty: '当前知识库尚未生成实体关系。',
    chunk: {
      loading: '正在加载知识图谱…',
      loadFailed: '知识图谱未能加载，请重试。'
    },
    topologyAriaLabel: '图谱拓扑',
    visibleRelations: {
      title: '可见关系',
      description: '仅显示当前筛选结果中的关系。',
      count: '{{count}} 条',
      empty: '当前筛选下没有可见关系。',
      listAriaLabel: '可见关系列表'
    },
    addEntityPanelAriaLabel: '新增实体面板',
    entityDetailsAriaLabel: '实体详情',
    deleteEntityAriaLabel: '删除实体 {{name}}',
    closeEntityDetailsAriaLabel: '关闭实体详情',
    noEntityDescription: '该实体没有附加描述。',
    aliases: '别名：{{aliases}}',
    relations: '关系',
    editRelationAriaLabel: '编辑关系 {{type}}',
    deleteRelationAriaLabel: '删除关系 {{type}}',
    merge: {
      title: '合并实体',
      targetAriaLabel: '选择合并目标',
      targetPlaceholder: '选择保留的实体',
      actionAriaLabel: '合并到目标实体'
    },
    confirm: {
      processing: '处理中…',
      deleteEntity: {
        title: '删除实体“{{name}}”？',
        description:
          '将永久删除实体“{{name}}”及其 {{count}} 条关联关系；相关证据引用也会从图谱中移除，且无法恢复。',
        action: '删除实体'
      },
      deleteRelation: {
        title: '删除关系“{{type}}”？',
        description:
          '将永久删除“{{source}}”到“{{target}}”的“{{type}}”关系及其图谱证据引用，且无法恢复。两个实体本身会保留。',
        action: '删除关系'
      },
      merge: {
        title: '将“{{source}}”合并到“{{target}}”？',
        description:
          '“{{source}}”的关系、别名和证据将并入“{{target}}”，随后删除源实体。此操作无法恢复。',
        action: '合并实体'
      }
    },
    evidence: {
      title: '证据 ({{count}})',
      empty: '此实体和相关关系没有关联证据。'
    },
    detailsAriaLabel: '图谱详情',
    detailsPrompt: '点击图谱节点查看实体详情。',
    workspace: {
      tabsAriaLabel: '知识图谱工作区',
      explore: '图谱探索',
      settings: '图谱设置'
    }
  },
  documents: {
    sources: {
      title: '内容来源',
      emptyTitle: '尚未连接内容来源',
      emptyDescription:
        '可选择文件、目录或 URL；也可以直接将文件拖入上方区域。',
      listAriaLabel: '内容来源列表'
    },
    importStrategy: '本次导入的图谱抽取策略',
    importStrategies: {
      rules: '仅本地规则',
      model: '仅使用模型',
      hybrid: '规则优先并由模型补全'
    },
    urlImport: {
      ariaLabel: '导入 URL',
      addressAriaLabel: 'URL 地址',
      closeAriaLabel: '关闭 URL 导入'
    },
    dropFiles: '将文件拖到这里，加入“{{name}}”',
    sourceMeta: '{{count}} 个文档 · {{time}}',
    syncProgress: '{{name}} 同步进度',
    actions: {
      pauseSource: '暂停 {{name}}',
      retrySource: '重试 {{name}}',
      syncSource: '同步 {{name}}',
      removeSource: '移除来源 {{name}}'
    },
    table: {
      title: '文档与索引',
      empty: '尚无文档。导入内容来源后，处理状态会显示在这里。',
      noResults: '没有与搜索条件匹配的文档。',
      columns: {
        document: '文档',
        status: '状态',
        indexProgress: '索引进度',
        processingStatus: '处理状态',
        chunks: '分块',
        size: '大小',
        actions: '操作'
      }
    },
    search: {
      label: '搜索文档',
      placeholder: '搜索名称或路径'
    },
    indexProgress: '{{name}} 索引进度'
  },
  entityEditor: {
    editAriaLabel: '编辑实体',
    addAriaLabel: '新增实体'
  },
  relationEditor: {
    editAriaLabel: '编辑关系',
    addAriaLabel: '新增关系',
    selectType: '选择关系类型',
    noCompatibleTypes: '当前起点和终点类型之间没有可用的关系类型。'
  },
  settings: {
    description: '控制是否从知识库文档中抽取实体、关系和证据。',
    enableDescription:
      '启用后，新导入和重新同步的文档会按所选策略抽取图谱。',
    strategyAriaLabel: '知识图谱抽取策略',
    askDescription: '“按需询问”不会自动生成图谱，也不能执行重新抽取。',
    graphConfiguration: {
      title: '抽取方式'
    },
    chunking: {
      title: '分块策略',
      description:
        '配置后续导入和重建使用的分块方式。保存设置不会立即改写现有文档。',
      mode: '分块方式',
      modes: {
        fixed: '固定长度',
        structure: '按文档结构',
        parentChild: '父子分块'
      },
      targetCharacters: '目标字符数',
      overlapCharacters: '重叠字符数',
      contextualIndexing: '启用上下文索引',
      contextualIndexingDescription:
        '将文档标题、标题层级、页码和块类型加入检索与向量文本；引用仍只显示原文。',
      parentCharacters: '父块字符数',
      childCharacters: '子块字符数',
      rebuildRequired: '设置已变化，需要重建现有文档后才能全部生效。',
      save: '保存分块设置',
      saving: '正在保存…',
      rebuild: '重建整个知识库',
      rebuilding: '正在重建…',
      cancelRebuild: '取消重建'
    },
    ontology: {
      title: '本体定义',
      description:
        '为当前知识库控制实体类型、关系类型及关系端点约束。标识符使用大写字母、数字和下划线。',
      entityTypes: '实体类型',
      relationTypes: '关系类型',
      id: '规范标识符',
      nameZh: '中文名称',
      nameEn: '英文名称',
      aliases: '别名（使用逗号分隔，最多 32 个）',
      sourceTypes: '允许的起点类型',
      targetTypes: '允许的终点类型',
      anyEndpoint: '允许任意实体类型',
      anyEndpointHelp: '未设置端点限制。',
      save: '保存本体定义',
      saving: '正在保存…',
      validation: '请修正重复标识符、重复别名、空名称或无效端点约束。',
      rebuildRequired:
        '本体定义已变化，需要显式重建现有文档后才能重新规范化已有图谱。',
      noImplicitRebuild: '保存只更新当前知识库设置，不会自动重建文档或图谱。'
    },
    vectorIndex: {
      title: '向量索引',
      description: '范围：当前知识库。',
      rebuild: '重建向量索引',
      rebuilding: '正在重建…',
      cancel: '取消重建',
      cancelAria: '取消当前知识库的向量索引重建',
      loading: '正在读取向量索引状态…',
      disabledTitle: '向量模型未启用',
      disabledDescription:
        '请先在“模型连接”中启用并保存向量模型，再返回此知识库重建索引。',
      currentModel: '当前向量模型',
      coverage: {
        indexed: '已索引',
        missing: '缺失',
        error: '错误',
        total: '文档总数'
      },
      statuses: {
        queued: '等待重建',
        running: '正在重建',
        completed: '最近一次重建成功',
        failed: '最近一次重建失败',
        cancelled: '最近一次重建已取消'
      },
      progressAria: '当前知识库向量索引重建进度',
      progress: '已完成 {{completed}} / {{total}} 篇文档',
      preparing: '正在准备待处理文档…',
      completedAt:
        '已完成 {{completed}} / {{total}} 篇文档。{{date}}',
      atomicNotice:
        '每篇文档会一次性更新；取消后，已完成文档保留新向量，其余文档保持原状。',
      cancelledNotice:
        '已完成 {{completed}} / {{total}} 篇文档，其余文档保持原状。',
      defaultRemedy: '请检查向量模型配置和网络连接后重试。',
      activeTitle: '向量索引任务正在运行',
      activeDescription: '任务中心查看详情、进度以及可用操作。',
      viewTasks: '任务中心查看详情'
    }
  },
  tasks: {
    emptyDescription:
      '导入或同步文档后，可以在这里查看解析、向量化和图谱抽取进度。',
    emptyTitle: '还没有知识任务',
    title: '任务中心',
    recentCount: '最近 {{count}} 个任务',
    totalCount: '共 {{count}} 个任务',
    activeCount: '进行中 {{count}}',
    failedCount: '失败 {{count}}',
    historyCount: '历史 {{count}}',
    progressAriaLabel: '{{name}} {{kind}}进度',
    waiting: '等待处理',
    currentStage: '当前阶段',
    itemProgress: '{{completed}} / {{total}} 项',
    errorTitle: '任务失败',
    defaultRemedy: '请检查相关配置或来源后重试。',
    noResultsTitle: '没有符合条件的任务',
    noResultsDescription: '请选择其他筛选条件或清除当前对象筛选。',
    filters: {
      ariaLabel: '筛选知识任务',
      all: '全部',
      active: '进行中',
      failed: '失败',
      history: '历史'
    },
    context: {
      active: '正在显示当前来源或文档的相关任务',
      clear: '清除对象筛选'
    },
    actionErrors: {
      cancelTitle: '取消任务失败',
      retryTitle: '重试任务失败',
      recovery: '任务和筛选已保留，请检查问题后再次操作。'
    },
    actions: {
      expand: '展开 {{name}} 的阶段任务',
      collapse: '收起 {{name}} 的阶段任务',
      cancel: '取消任务',
      cancelling: '正在取消…',
      retry: '重试任务',
      retrying: '正在重试…'
    }
  },
  tabs: {
    documents: '文档与来源',
    graph: '知识图谱',
    tasks: '任务中心',
    settings: '索引与检索'
  },
  workspace: {
    ariaLabel: '知识工作区',
    libraryList: '知识库列表',
    libraryListEmpty:
      '创建知识库，集中管理可跨项目使用的来源、索引和实体关系。',
    libraryMeta: '{{count}} 个文档 · {{storageMode}}',
    detailsAriaLabel: '知识库详情',
    tabsAriaLabel: '知识库视图',
    scopeGlobal: '全局',
    librarySummary:
      '{{sourceCount}} 个来源，{{indexedCount}}/{{documentCount}} 个文档已完成索引。'
  },
  loading: {
    title: '正在加载知识库',
    description: '正在读取知识库、来源和索引状态。'
  },
  empty: {
    title: '建立第一个知识库',
    description:
      '集中组织文件、目录和网页来源，并生成可追溯、可跨项目使用的索引与图谱。'
  },
  graphChart: {
    ariaLabel: '实体关系图',
    renderError: '图谱渲染失败',
    relation: '关系',
    errorWithContext: '图谱渲染失败：{{error}}'
  }
} as const
