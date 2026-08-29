export const workspace = {
  builtInDefaultProject: {
    name: '默认项目',
    description: 'GoodBuddy 默认工作区'
  },
  projectSwitcher: {
    workModes: {
      ask: 'Ask · 只读问答',
      execute: 'Execute · 完全权限'
    },
    selector: {
      ariaLabel: '当前项目',
      userProjects: '本地项目',
      remoteProjects: '远程项目',
      channelProjects: '远程通道',
      empty: '未选择项目',
      localDetail: '本地目录 · {{path}}',
      managedSshDetail: '托管 SSH · {{path}}',
      remoteDetail: '{{channel}} · 远程通道 · {{path}}',
      remoteChannel: '远程通道',
      create: '新建项目',
      settings: '项目设置',
      settingsNamed: '管理项目 {{name}}'
    },
    dialog: {
      createTitle: '新建项目',
      settingsTitle: '项目设置',
      closeCreate: '关闭新建项目',
      closeSettings: '关闭项目设置',
      fields: {
        name: '名称',
        description: '说明',
        rootPath: '根目录',
        executionSpace: '执行空间',
        defaultMode: '默认模式',
        defaultRuntime: '新对话默认 Runtime'
      },
      runtimeOptions: {
        direct: '直连模型'
      },
      defaultRuntimeHelp:
        '仅应用于此项目中新建的对话，不会更改已有对话。',
      channelManaged: '通道项目名称由 GoodBuddy 管理。',
      selectRoot: '选择项目根目录',
      danger: {
        title: '危险操作',
        description:
          '删除项目会永久移除 GoodBuddy 中的项目、对话、任务、计划、心跳、记忆和成果，但不会删除磁盘上的项目目录或文件。',
        delete: '删除项目',
        confirmation: '输入“{{projectName}}”确认删除',
        cancel: '取消删除',
        deleting: '删除中',
        permanentlyDelete: '永久删除项目',
        keepOne: '至少需要保留一个可用项目。'
      },
      archive: '归档项目',
      archiving: '归档中',
      cancel: '取消',
      create: '创建',
      creating: '创建中',
      save: '保存项目',
      saving: '保存中'
    },
    errors: {
      save: '保存项目失败',
      create: '创建项目失败',
      selectRoot: '选择项目根目录失败',
      archive: '归档项目失败',
      delete: '删除项目失败'
    },
    remote: {
      executionSpaces: {
        local: '本机',
        ssh: '托管 SSH'
      },
      executionSpaceFixed:
        '已有项目不能在本机与托管 SSH 之间直接切换。',
      fields: {
        host: 'SSH 主机',
        root: '远端工作目录'
      },
      loadingHosts: '正在读取已保存主机…',
      noHosts: '没有已保存的 SSH 主机',
      hostHelp: '主机凭据由设置中心统一管理，不会复制到项目中。',
      readiness: {
        loading: '正在读取主机验证记录…',
        ready:
          '此主机已验证。保存项目时才会连接并检查 Agent、工作区和 Runtime。',
        unready:
          '此主机尚未完成 Host Key 和连接验证。请先前往“设置 > SSH 主机”完成验证。',
        error:
          '无法读取此主机的本地验证记录。请前往“设置 > SSH 主机”检查配置。',
        saveBlocked:
          '所选主机尚未完成验证。请先在“设置 > SSH 主机”验证连接。',
        options: {
          loading: '读取中',
          ready: '已验证',
          unready: '需要验证',
          error: '记录不可用'
        }
      },
      rootHelp: '请输入或选择以 / 开头的规范绝对路径。',
      directoryPicker: {
        browse: '浏览远端工作目录',
        title: '选择远端工作目录',
        close: '关闭远端目录选择器',
        currentPath: '当前目录',
        parent: '返回上级目录',
        refresh: '刷新当前目录',
        directory: '打开目录 {{name}}',
        loading: '正在读取远端目录…',
        empty: '当前目录中没有子目录。',
        loadError: '读取远端目录失败：{{message}}',
        unknownError: '请检查 SSH 主机连接后重试。',
        cancel: '取消',
        select: '选择此目录'
      },
      runtimeHelp:
        '托管 SSH 项目仅使用 OpenCode Runtime。Ask 为只读；Execute 可使用所选 SSH 账户拥有的全部权限。保存时会检查主机、远端 Agent、工作区和 Runtime。',
      actions: {
        save: '保存远程项目',
        saving: '正在保存远程项目…'
      },
      progress: {
        progressLabel: '远程项目保存进度',
        stepsLabel: '远程项目保存阶段'
      },
      phaseStatus: '当前阶段：{{phase}}',
      phases: {
        host: 'SSH 主机',
        agent: '远端 Agent',
        workspace: '远端工作区',
        runtime: 'OpenCode Runtime',
        saving: '项目设置'
      },
      validation: {
        host: '请选择一个已保存的 SSH 主机。',
        root: '远端工作目录必须是以 / 开头的绝对路径。'
      },
      errors: {
        hostsUnavailable: 'SSH 主机服务不可用。',
        loadHosts: '读取 SSH 主机失败。',
        save: '保存远程项目失败。'
      }
    }
  },
  sidebar: {
    ariaLabel: '助手工作栏',
    resizeAriaLabel: '调整助手工作栏宽度',
    resizeValue: '{{width}} 像素',
    categoriesAriaLabel: '工作栏分类',
    tabs: {
      tasks: {
        label: '任务中心',
        description: '处理待审批操作并管理自动化'
      },
      workspace: {
        label: '工作区',
        description: '浏览项目文件、Git 变更与文件内容'
      },
      browser: {
        label: '浏览器',
        description: '查看 Agent 操作网页时的实时画面'
      },
      results: {
        label: '成果',
        description: '查看生成或手动导入的独立成果'
      }
    },
    tasks: {
      approvalsTitle: '等待审批',
      noApprovals: '当前没有等待审批的操作。',
      deny: '拒绝',
      allowOnce: '仅此次允许',
      taskIndexTitle: '任务索引',
      empty: '明确创建的任务会显示在这里。',
      noFilterResults: '当前筛选条件下没有任务。',
      conversationUnavailable: '关联会话不可用',
      projectScope: '项目：{{project}}',
      globalScope: '全局',
      startedAt: '{{time}} 开始',
      nextRunAt: '下次运行：{{time}}',
      notStarted: '尚未运行',
      filters: {
        ariaLabel: '筛选任务',
        attention: '待关注',
        active: '进行中',
        paused: '已暂停',
        finished: '已完成'
      },
      schedule: {
        recurrence: {
          once: '仅一次',
          daily: '每天',
          weekly: '每周'
        },
        runNow: '立即运行',
        delete: '删除计划',
        cancelDelete: '取消删除计划',
        confirmDelete: '确认删除“{{title}}”的计划',
        confirmDeleteAction: '停止后续运行',
        deleteMessage: '这会停止后续自动运行，但保留任务、会话和既有结果。'
      }
    },
    workspace: {
      back: '返回工作区',
      title: '工作区',
      projectTitle: '项目工作区',
      fileSize: '{{formattedSize}} 字节',
      fileFallback: '项目工作区文件',
      reading: '正在读取文件…',
      refreshAriaLabel: '刷新工作区文件',
      refresh: '刷新',
      gitUnavailable: 'Git 状态不可用：{{error}}',
      fullDiff: '查看完整 Git diff',
      truncatedDiff: '\n\n[输出超过安全限制，已截断]'
    },
    results: {
      back: '返回成果列表',
      title: '成果',
      sectionTitle: '生成与导入成果',
      loadingImage: '正在加载图片…',
      import: '导入 PDF、图片或网页',
      empty: '生成的文件、图片、报告和手动导入内容会显示在这里。'
    },
    browser: {
      title: '实时浏览器',
      interact: '交互',
      interacting: '交互中',
      stop: '停止浏览器',
      empty: 'Agent 打开网页后，实时画面会显示在这里。',
      statuses: {
        creating: '正在启动浏览器…',
        loading: '正在加载页面…',
        acting: 'Agent 正在操作页面…',
        interactive: '用户正在辅助操作页面…',
        ready: '浏览器已就绪',
        failed: '浏览器操作失败',
        stopped: '浏览器已停止'
      },
      frameAlt: 'Agent 实时浏览器画面',
      noFrame: '未能获取页面画面',
      waitingFrame: '等待首个页面画面…'
    },
    errors: {
      workspacePreview: '工作区文件预览失败',
      runSchedule: '运行定时任务失败',
      deleteSchedule: '删除定时任务失败',
      updateSchedule: '更新定时任务失败',
      refreshWorkspace: '刷新工作区文件失败',
      importResult: '导入成果失败',
      loadResult: '加载成果失败',
      interactBrowser: '打开浏览器交互窗口失败',
      stopBrowser: '停止浏览器失败'
    }
  },
  task: {
    status: {
      queued: '空闲',
      idle: '空闲',
      running: '运行中',
      waiting_approval: '等待审批',
      paused: '已暂停',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已中断'
    },
    mode: {
      ask: 'Ask',
      execute: 'Execute',
      unavailable: '模式不可用'
    },
    fields: {
      mode: '模式',
      schedule: '计划',
      nextRun: '下次运行',
      outcome: '最近结果'
    },
    schedule: {
      none: '无计划'
    },
    actions: {
      pause: '暂停',
      resume: '恢复'
    },
    notAvailable: '不可用',
    completedAt: '{{time}} 完成',
    noOutcome: '尚无运行结果'
  },
  taskStrip: {
    ariaLabel: '当前会话的任务',
    title: '会话任务',
    count: '{{count}} 个',
    create: '新建任务',
    taskList: '任务列表'
  },
  files: {
    statuses: {
      added: '新增',
      deleted: '删除',
      renamed: '重命名',
      modified: '修改'
    },
    errors: {
      read: '工作区文件读取失败',
      openFolder: '打开文件夹失败',
      openFile: '打开文件失败'
    },
    openFolderAriaLabel: '在系统资源管理器中打开文件夹 {{name}}',
    openFolder: '打开文件夹',
    openFileAriaLabel: '使用默认应用打开文件 {{name}}',
    openFile: '打开文件',
    reading: '正在读取…',
    directoryTruncated: '目录项目超过 500 项，仅显示前 500 项。',
    selectProject: '选择项目后可浏览项目工作区。',
    changedTitle: '未提交更改',
    changesTruncated: '仅显示前 50 个未提交更改。',
    currentWorkspace: '当前工作区',
    readingWorkspace: '正在读取工作区…',
    rootTruncated: '根目录项目超过 500 项，仅显示前 500 项。',
    empty: '工作区为空。'
  },
  question: {
    title: 'OpenCode 需要补充信息',
    otherAnswer: '其他回答',
    answerPlaceholder: '输入你的回答',
    skip: '跳过',
    submitting: '提交中…',
    submit: '提交回答',
    error: '回答提交失败，请重试'
  },
  primitives: {
    scope: {
      global: '全局',
      allProjects: '全部项目',
      project: '项目：{{projectName}}',
      projects: '{{count}} 个项目',
      mixedProject: '项目：{{projectName}} + 全局',
      mixedCurrent: '项目 + 全局',
      unavailable: '范围不可用'
    },
    destructive: {
      defaultMessage: '确认{{triggerLabel}}操作。',
      cancel: '取消'
    }
  }
} as const
