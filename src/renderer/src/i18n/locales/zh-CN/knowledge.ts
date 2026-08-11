export const knowledge = {
  page: {
    eyebrow: '知识',
    title: '知识库',
    description:
      '集中组织文件、目录和网页来源，建立可追溯、可跨项目使用的索引与图谱。'
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
    parsing: '文档解析',
    embedding: '向量化',
    graph: '图谱抽取'
  },
  taskStatuses: {
    queued: '等待中',
    running: '进行中',
    succeeded: '已完成',
    failed: '失败',
    skipped: '已跳过'
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
    empty: '当前知识库尚未生成实体关系。',
    topologyAriaLabel: '图谱拓扑',
    visibleRelations: {
      title: '可见关系',
      description: '随当前搜索和类型筛选更新。',
      count: '{{count}} 条',
      empty: '当前筛选下没有可见关系。',
      listAriaLabel: '可见关系列表'
    },
    addEntityPanelAriaLabel: '新增实体面板',
    entityDetailsAriaLabel: '实体详情',
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
    evidence: {
      title: '证据 ({{count}})',
      empty: '此实体和相关关系没有关联证据。'
    },
    detailsAriaLabel: '图谱详情',
    detailsPrompt: '点击图谱节点查看实体详情。',
    disabledTitle: '知识图谱未启用',
    disabledDescription:
      '在“设置”中启用知识图谱后，可以查看实体关系并重新抽取。'
  },
  documents: {
    sources: {
      title: '内容来源',
      description: '导入内容后会自动解析、建立索引并更新图谱。',
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
        chunks: '分块',
        size: '大小'
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
    addAriaLabel: '新增关系'
  },
  settings: {
    description: '控制是否从知识库文档中抽取实体、关系和证据。',
    enableDescription:
      '启用后，新导入和重新同步的文档会按所选策略抽取图谱。',
    strategyAriaLabel: '知识图谱抽取策略',
    askDescription: '“按需询问”不会自动生成图谱，也不能执行重新抽取。'
  },
  tasks: {
    emptyDescription:
      '导入或同步文档后，可以在这里查看解析、向量化和图谱抽取进度。',
    emptyTitle: '还没有知识任务',
    title: '任务中心',
    recentCount: '最近 {{count}} 个任务',
    activeCount: '进行中 {{count}}',
    failedCount: '失败 {{count}}',
    progressAriaLabel: '{{name}} {{kind}}进度',
    waiting: '等待处理'
  },
  tabs: {
    documents: '文档与来源',
    graph: '知识图谱',
    tasks: '任务中心',
    settings: '设置'
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
