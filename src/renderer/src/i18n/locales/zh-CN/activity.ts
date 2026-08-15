export const activity = {
  header: {
    eyebrow: 'RUN HISTORY',
    title: '运行记录',
    description:
      '按项目、任务与会话查看执行详情，或浏览活动时间线和模型用量。'
  },
  tabs: {
    ariaLabel: '运行记录视图',
    tasks: '任务与会话',
    timeline: '活动时间线',
    usage: '用量统计'
  },
  clear: {
    confirmAriaLabel: '确认清空 {{formattedCount}} 条活动记录',
    confirmLabel: '清空 {{formattedCount}} 条记录',
    message:
      '永久清空 {{formattedCount}} 条活动记录？此操作不可撤销。',
    triggerLabel: '清空记录'
  },
  statuses: {
    pending: '等待中',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    denied: '已拒绝',
    cancelled: '已取消',
    interrupted: '已中断'
  },
  kinds: {
    request: '任务',
    tool: '工具',
    approval: '审批',
    subagent: '子专家',
    result: '结果'
  },
  filters: {
    all: '全部',
    active: '进行中',
    failed: '异常',
    ariaLabel: '筛选活动',
    clear: '清除筛选'
  },
  tokenUsage: {
    title: 'Token 用量',
    groupAriaLabel: 'Token 用量分组',
    statsAriaLabel: 'Token 用量统计',
    groups: {
      project: '按项目',
      conversation: '按会话',
      model: '按模型'
    },
    columns: {
      project: '项目',
      conversation: '会话',
      model: '模型',
      input: '输入',
      output: '输出',
      cacheWrite: '缓存写入',
      cacheRead: '缓存读取',
      total: '总计'
    },
    detailAriaLabel: 'Token 用量{{group}}明细',
    empty: '暂无 Token 用量',
    fallbacks: {
      unassignedProject: '未归属项目',
      deletedConversation: '已删除会话',
      unknownModel: '未知模型'
    }
  },
  stats: {
    ariaLabel: '活动统计',
    all: '全部',
    active: '进行中',
    failed: '异常'
  },
  timeline: {
    ariaLabel: '按项目和会话分组的并行活动轨道',
    description:
      '所有轨道共享同一执行顺序，节点按发生时间依次展开，点击节点查看身份和活动详情。',
    lanes: '项目 / 会话',
    laneAriaLabel: '会话 {{title}} 的活动轨道',
    nodeAriaLabel: '{{actor}}，{{kind}}，{{status}}，{{title}}，{{time}}',
    legendAriaLabel: '活动节点身份图例',
    detailAriaLabel: '选中的活动节点详情',
    closeDetail: '关闭详情',
    actors: {
      user: '用户',
      assistant: 'GoodBuddy',
      subagent: '子专家',
      tool: '工具',
      approval: '审批'
    },
    nodes: {
      user: '用',
      assistant: 'G',
      tool: '工',
      approval: '审',
      subagent: '专'
    }
  },
  empty: {
    active: '当前没有等待中或正在运行的活动。',
    failed: '当前没有失败、取消或中断的活动。',
    all:
      '任务请求、子专家、工具调用和审批决定会显示在这里。',
    noRecordsTitle: '尚无活动记录',
    noMatchesTitle: '没有匹配的活动'
  },
  records: {
    unknownTime: '时间未知',
    interruptedOnRestart: '应用重启时此活动尚未结束。',
    unavailableScope:
      '创建此活动记录时未能确定其归属范围。',
    conversation: '对话：{{title}}',
    activityCount: '{{formattedCount}} 条活动',
    projectSummary:
      '{{conversationCount}} 个任务或会话 · {{activityCount}} 条活动',
    openConversation: '打开所属对话'
  }
} as const
