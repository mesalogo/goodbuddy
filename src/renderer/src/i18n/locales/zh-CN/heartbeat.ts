export const heartbeat = {
  common: {
    operationFailed: '智能心跳操作失败',
    unavailable: '暂无',
    unknownTime: '时间未知'
  },
  center: {
    eyebrow: 'SMART HEARTBEAT',
    title: '智能心跳',
    description:
      '定期回顾经历、沉淀记忆、发现问题，并把每次变化转化为可处理的成长建议。',
    scope: {
      currentProject: '当前项目',
      global: '全局'
    },
    actions: {
      refreshAriaLabel: '刷新智能心跳',
      refresh: '刷新',
      running: '心跳中…',
      runOnce: '运行一次心跳',
      configure: '配置智能心跳',
      retry: '重试'
    },
    loading: {
      description: '正在读取心跳计划、运行记录和成长报告。',
      title: '正在加载智能心跳',
      failedTitle: '智能心跳加载失败',
      refreshFailedTitle: '智能心跳刷新失败'
    },
    tabs: {
      ariaLabel: '智能心跳视图',
      overview: '成长概览',
      suggestions: '待处理建议',
      history: '心跳轨迹',
      plans: '心跳计划'
    },
    currentStatus: {
      eyebrow: 'CURRENT PULSE',
      title: '当前状态',
      activePlans: '{{formattedCount}} 个计划运行中',
      disabled: '尚未启用',
      emptyTitle: '尚未建立成长节奏',
      emptyDescription:
        '配置每日或每周心跳，让 GoodBuddy 持续回顾和学习。',
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
      ariaLabel: '智能心跳成长维度',
      health: '心跳健康',
      successfulRuns: '{{completed}}/{{total}} 次成功完成',
      healthRateAriaLabel: '心跳成功率 {{percent}}',
      memory: '记忆沉淀',
      memoryDescription: '已确认记忆 / 心跳建议',
      memoryRateAriaLabel: '记忆确认率 {{percent}}',
      insights: '洞察发现',
      insightReports: '来自 {{formattedCount}} 份心跳报告',
      latestInsights: '最近一次发现 {{formattedCount}} 条',
      awaitingFirstRun: '等待首次心跳',
      action: '行动转化',
      actionDescription: '已完成任务 / 心跳建议',
      actionRateAriaLabel: '建议任务完成率 {{percent}}'
    },
    trend: {
      eyebrow: 'GROWTH TREND',
      title: '成长趋势',
      empty:
        '完成心跳后，这里会显示洞察、记忆与行动建议的变化。',
      insight: '洞察',
      memory: '记忆',
      action: '行动',
      rowAriaLabel:
        '{{date}}：{{insights}} 条洞察，{{memories}} 条记忆建议，{{actions}} 个行动建议'
    },
    latest: {
      eyebrow: 'LATEST REPORT',
      title: '本次心跳',
      viewHistory: '查看心跳轨迹',
      handleSuggestions: '处理 {{formattedCount}} 条建议',
      empty:
        '尚无心跳报告。运行一次心跳后，你会在这里看到本次学到了什么。'
    },
    suggestions: {
      memoryEyebrow: 'MEMORY GROWTH',
      memoryTitle: '待确认记忆',
      memoryCount: '{{formattedCount}} 条',
      memoryEmpty: '当前没有等待确认的记忆建议。',
      confidenceAndSalience:
        '置信度 {{confidence}} · 重要度 {{salience}}',
      collapseContent: '收起内容',
      expandContent: '查看完整内容',
      confirmMemory: '确认记忆',
      ignore: '忽略',
      taskEyebrow: 'NEXT ACTIONS',
      taskTitle: '行动建议',
      taskCount: '{{formattedCount}} 个',
      taskEmpty: '当前没有由智能心跳产生的行动建议。',
      useInConversation: '带入对话处理',
      markCompleted: '标记完成',
      ignoreSuggestion: '忽略建议'
    },
    history: {
      timelineEyebrow: 'HEARTBEAT TIMELINE',
      timelineTitle: '成长轨迹',
      reportCount: '{{formattedCount}} 份报告',
      emptyTimeline: '完成心跳后，每次学习和变化都会沉淀在这里。',
      reportSummary:
        '{{insights}} 条洞察 · {{memories}} 条记忆 · {{actions}} 个行动',
      collapseReport: '收起报告',
      expandReport: '展开完整报告',
      loadMoreReports: '加载更多心跳报告',
      auditEyebrow: 'RUN AUDIT',
      auditTitle: '运行记录',
      runCount: '{{formattedCount}} 次',
      emptyRuns: '尚无智能心跳运行记录。',
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
    title: '智能心跳',
    description:
      '定期回顾经历、沉淀记忆、发现问题，并把变化转化为可处理的成长建议。智能心跳只读且不调用工具。',
    recurrenceAriaLabel: '心跳重复规则',
    daily: '每天',
    weekly: '每周',
    weekdayAriaLabel: '心跳星期',
    timeAriaLabel: '心跳时间',
    enableAriaLabel: '启用智能心跳',
    enabling: '启用中…',
    enable: '启用智能心跳',
    defaultName: '智能成长回顾',
    empty: '当前范围尚未配置智能心跳。',
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
