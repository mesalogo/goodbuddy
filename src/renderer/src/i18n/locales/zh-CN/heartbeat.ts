export const heartbeat = {
  common: {
    operationFailed: '监督者操作失败',
    unavailable: '暂无',
    unknownTime: '时间未知'
  },
  supervisor: {
    projectScope: '项目：{{names}}',
    canvasTitle: '工作的来路', canvasNote: '沿外圈逆时针阅读 · 选择节点，查看知识与来源', readingGuide: '如何读图',
    visibleCounts: '画布中 {{events}} 个事件 / {{entities}} 个实体', showAll: '显示全部关联', connections: '图谱关联',
    loadingHint: '正在读取已保存的回顾、事件与来源。', unavailableHint: '请重新打开应用后重试；已保存的回顾仍保留在本机。',
    selection: '图谱选择', canvas: '故事图谱画布', inspector: '详情与来源',
    counts: '{{events}} 个事件 · {{entities}} 个实体', canvasCaption: '事件按时间顺序等距排列，不表示时间间隔。画布每批最多显示 8 个事件和 6 个实体；从列表选择可切换批次并查看完整名称，窄屏可横向滚动画布。当前实体状态不随事件浏览还原。',
    legendLabel: '图谱图例', eventImpact: '事件影响', playback: '事件浏览', previousStage: '上一事件', nextStage: '下一事件',
    navigation: '监督者视图', recap: '工作回顾', graph: '故事线图谱', settings: '设置',
    viewInGraph: '在图谱中查看',
    unavailable: '监督者服务暂不可用', loading: '正在读取监督回顾', scope: '关注范围', period: '时间范围', days: '{{count}} 天',
    sourcesHint: '回顾只读取本次明确范围和时间区间内的来源；自动唤醒计划不会改变手动回顾范围。', latest: '最近一次成功回顾', openItems: '未解决事项', history: '历史结果',
    empty: '还没有成功回顾', emptyHint: '即使没有自动唤醒计划，也可以手动回顾当前进展。', run: '回顾当前进展', running: '回顾整理中…', retryRun: '重试回顾', dismiss: '关闭提示',
    graphScope: '图谱范围', graphEmpty: '当前范围没有故事线事件', legend: '实线表示事件影响实体，虚线表示实体关系。时间轴逆时针排列，起止之间保留缺口。', start: '起点', end: '终点',
    events: '时间事件', entities: '知识实体', relations: '实体关系', eventSources: '事件来源', sources: '关联来源', noSources: '没有可用的关联来源。', selectHint: '选择事件、实体或关系查看详情。', sourceSnapshot: '来源详情', sourceMissing: '来源不存在',
    confirm: '确认', revise: '修订', remove: '移除关系', label: '实体名称', save: '保存修订', cancel: '取消', removeHint: '这只改变图谱中的关系组织，原始来源仍然保留。',
    relationTypes: { supports: '支持', 'depends-on': '依赖', contrasts: '对比', related: '相关' },
    states: { automatic: '自动归纳 · 待核对', confirmed: '用户已确认', revised: '用户已修订', revoked: '已移除' }
  },
  center: {
    title: '监督者',
    description: '持续回顾工作进展、追踪知识演变；智能心跳负责按计划唤醒监督者。',
    scope: {
      currentProject: '当前项目',
      global: '全局'
    },
    actions: {
      refreshAriaLabel: '刷新监督者',
      refresh: '刷新',
      running: '自动唤醒中…',
      runOnce: '立即回顾',
      configure: '配置自动唤醒',
      retry: '重试'
    },
    loading: {
      description: '正在读取心跳计划、运行记录和心跳报告。',
      title: '正在加载监督者',
      failedTitle: '监督者加载失败',
      refreshFailedTitle: '监督者刷新失败'
    },
    tabs: {
      ariaLabel: '监督者自动唤醒视图',
      overview: '自动唤醒概览',
      suggestions: '待处理建议',
      history: '报告与记录',
      plans: '自动唤醒设置'
    },
    currentStatus: {
      title: '当前状态',
      activePlans: '{{formattedCount}} 个计划运行中',
      disabled: '尚未启用',
      emptyTitle: '尚未配置心跳计划',
      emptyDescription:
        '创建每日或每周计划，GoodBuddy 将按范围回顾对话和任务并生成建议。',
      createPlan: '创建心跳计划'
    },
    recurrence: {
      daily: '每天 {{time}}',
      weekly: '{{weekday}} {{time}}'
    },
    weekdays: {
      sunday: '周日',
      monday: '周一',
      tuesday: '周二',
      wednesday: '周三',
      thursday: '周四',
      friday: '周五',
      saturday: '周六'
    },
    config: {
      nextHeartbeat: '下次心跳',
      lastStatus: '上次状态',
      neverRun: '尚未运行',
      runNow: '立即心跳',
      pause: '暂停',
      resume: '恢复'
    },
    metrics: {
      ariaLabel: '自动唤醒运行统计',
      health: '心跳健康',
      successfulRuns: '{{completed}}/{{total}} 次成功完成',
      healthRateAriaLabel: '心跳成功率 {{percent}}',
      memory: '记忆确认',
      memoryDescription: '已确认记忆 / 心跳建议',
      memoryRateAriaLabel: '记忆确认率 {{percent}}',
      insights: '报告洞察',
      insightReports: '来自 {{formattedCount}} 份心跳报告',
      latestInsights: '最近一次发现 {{formattedCount}} 条',
      awaitingFirstRun: '等待首次心跳',
      action: '行动转化',
      actionDescription: '已完成任务 / 心跳建议',
      actionRateAriaLabel: '建议任务完成率 {{percent}}'
    },
    trend: {
      title: '报告趋势',
      empty:
        '运行心跳后，这里会显示洞察、记忆和行动建议的数量变化。',
      insight: '洞察',
      memory: '记忆',
      action: '行动',
      rowAriaLabel:
        '{{date}}：{{insights}} 条洞察，{{memories}} 条记忆建议，{{actions}} 个行动建议'
    },
    latest: {
      title: '本次心跳',
      viewHistory: '查看报告与记录',
      handleSuggestions: '处理 {{formattedCount}} 条建议',
      empty:
        '尚无心跳报告。运行一次后，可在这里查看洞察、记忆和行动建议。'
    },
    suggestions: {
      memoryTitle: '待确认记忆',
      memoryCount: '{{formattedCount}} 条',
      memoryEmpty: '当前没有等待确认的记忆建议。',
      confidenceAndSalience:
        '置信度 {{confidence}} · 重要度 {{salience}}',
      collapseContent: '收起内容',
      expandContent: '查看完整内容',
      confirmMemory: '确认记忆',
      ignore: '忽略',
      taskTitle: '行动建议',
      taskCount: '{{formattedCount}} 个',
      taskEmpty: '当前没有由自动唤醒产生的行动建议。',
      useInConversation: '带入对话处理',
      markCompleted: '标记完成',
      ignoreSuggestion: '忽略建议'
    },
    history: {
      timelineTitle: '心跳报告',
      reportCount: '{{formattedCount}} 份报告',
      emptyTimeline: '每次运行生成的心跳报告会显示在这里。',
      reportSummary:
        '{{insights}} 条洞察 · {{memories}} 条记忆 · {{actions}} 个行动',
      collapseReport: '收起报告',
      expandReport: '展开完整报告',
      loadMoreReports: '加载更多心跳报告',
      auditTitle: '运行记录',
      runCount: '{{formattedCount}} 次',
      emptyRuns: '尚无自动唤醒运行记录。',
      manualRun: '手动运行',
      scheduledRun: '周期运行',
      attempt: '第 {{formattedCount}} 次尝试',
      loadMoreRuns: '加载更多运行记录'
    }
  },
  statuses: {
    run: {
      claimed: '运行中',
      completed: '已完成',
      failed: '失败',
      skipped: '已跳过'
    },
    task: {
      queued: '等待中',
      idle: '空闲',
      running: '运行中',
      waitingApproval: '等待审批',
      paused: '待处理',
      completed: '已完成',
      failed: '失败',
      cancelled: '已忽略',
      interrupted: '已中断'
    },
    memory: {
      preference: '偏好',
      fact: '事实',
      summary: '总结',
      procedure: '流程'
    }
  },
  settings: {
    title: '自动唤醒',
    description: '自动唤醒按时只读运行，不调用工具。',
    recurrenceAriaLabel: '心跳重复规则',
    recurrenceLabel: '重复规则',
    daily: '每天',
    weekly: '每周',
    weekdayAriaLabel: '心跳星期',
    weekdayLabel: '星期',
    timeAriaLabel: '心跳时间',
    timeLabel: '时间',
    nameLabel: '计划名称',
    createTitle: '创建心跳计划',
    editTitle: '编辑心跳计划',
    cancelEdit: '取消编辑',
    editAriaLabel: '编辑 {{name}}',
    edit: '编辑',
    saveAriaLabel: '保存自动唤醒计划',
    save: '保存修改',
    lookbackLabel: '回顾范围（小时）',
    lookbackAriaLabel: '心跳回顾小时数',
    retentionLabel: '历史保留（天）',
    retentionAriaLabel: '心跳历史保留天数',
    scope: {
      legend: '回顾范围',
      ariaLabel: '选择心跳回顾范围',
      global: '全局',
      projects: '指定项目',
      globalHelp:
        '回顾所有可用项目中的有界对话与任务，并读取全局记忆。',
      projectsHelp:
        '一次运行共同回顾所选项目，并读取全局记忆与这些项目的记忆。',
      noProjects: '当前没有可选择的项目。',
      archived: '已归档',
      removeArchived: '保存前请移除已归档或不可用的项目。',
      unavailableProject: '不可用项目',
      selectedProjectsSummary: '{{count}} 个项目：{{names}}',
      nameSeparator: '、'
    },
    enableAriaLabel: '启用自动唤醒',
    enabling: '启用中…',
    enable: '启用自动唤醒',
    defaultName: '定期回顾',
    empty: '当前范围尚未配置自动唤醒。',
    running: '运行中',
    paused: '已暂停',
    next: '下次 {{date}}',
    last: '上次 {{status}}',
    pauseAriaLabel: '暂停 {{name}}',
    resumeAriaLabel: '恢复 {{name}}',
    pause: '暂停',
    resume: '恢复',
    runNowAriaLabel: '立即心跳 {{name}}',
    runNow: '立即心跳',
    cancelDeleteAriaLabel: '取消删除 {{name}}',
    confirmDeleteAriaLabel: '确认删除 {{name}}',
    confirmDelete: '确认删除计划',
    deleteMessage:
      '将永久删除此计划、运行历史和关联结果，且无法恢复。',
    deleteAriaLabel: '删除 {{name}}',
    delete: '删除'
  }
} as const
