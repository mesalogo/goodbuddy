export type PrototypeRole = 'admin' | 'member'

export type Metric = {
  label: string
  value: string
  detail: string
  tone: 'cyan' | 'violet' | 'amber' | 'rose'
  target: string
}

export type PrototypeRecord = {
  id: string
  primary: string
  secondary: string
  status: string
  statusTone: 'online' | 'warning' | 'offline' | 'danger' | 'neutral'
  meta: string[]
  detail: Record<string, string>
}

export type PrototypeSnapshot = {
  instance: {
    name: string
    organization: string
    protocol: string
    region: string
    generatedAt: string
  }
  metrics: Metric[]
  activity: Array<{ time: string; label: string; value: number }>
  pages: Record<string, PrototypeRecord[]>
}

const record = (
  id: string,
  primary: string,
  secondary: string,
  status: string,
  statusTone: PrototypeRecord['statusTone'],
  meta: string[],
  detail: Record<string, string>
): PrototypeRecord => ({ id, primary, secondary, status, statusTone, meta, detail })

export const prototypeSnapshot: PrototypeSnapshot = {
  instance: {
    name: 'Nebula ShareServer',
    organization: 'MesaLab',
    protocol: 'Share Protocol 1.0',
    region: '上海 · 私有云',
    generatedAt: '2026-09-05T09:42:00+08:00'
  },
  metrics: [
    { label: '待处理审批', value: '6', detail: '最旧等待 42 分钟', tone: 'amber', target: '/approvals' },
    { label: '在线设备', value: '18 / 24', detail: '2 台需要关注', tone: 'cyan', target: '/devices' },
    { label: '可用能力', value: '37', detail: '来自 21 个 Provider', tone: 'violet', target: '/capabilities' },
    { label: '活动任务', value: '12', detail: '过去 24 小时成功率 98.2%', tone: 'rose', target: '/tasks' }
  ],
  activity: [
    { time: '08:00', label: '任务', value: 12 },
    { time: '09:00', label: '任务', value: 19 },
    { time: '10:00', label: '任务', value: 15 },
    { time: '11:00', label: '任务', value: 26 },
    { time: '12:00', label: '任务', value: 21 },
    { time: '13:00', label: '任务', value: 33 },
    { time: '14:00', label: '任务', value: 28 },
    { time: '15:00', label: '任务', value: 42 },
    { time: '16:00', label: '任务', value: 36 },
    { time: '17:00', label: '任务', value: 48 },
    { time: '18:00', label: '任务', value: 39 },
    { time: '19:00', label: '任务', value: 51 }
  ],
  pages: {
    members: [
      record('m-1', '林江', 'jiang@mesalab.internal', '活跃', 'online', ['系统管理员', '3 台设备', '刚刚'], {
        身份源: '本地账号',
        用户组: '平台工程、审批人',
        有效授权: '12 项 Grant',
        最近活动: '批准图像生成能力发布'
      }),
      record('m-2', '陈汐', 'xi.chen@mesalab.internal', '活跃', 'online', ['组织管理员', '2 台设备', '8 分钟前'], {
        身份源: '企业 OIDC',
        用户组: '设计中心',
        有效授权: '8 项 Grant',
        最近活动: '调用文档转换能力'
      }),
      record('m-3', '王简', 'jian.wang@partner.example', '待接受邀请', 'warning', ['成员', '0 台设备', '2 小时前'], {
        身份源: '邀请待确认',
        用户组: '法务协作',
        有效授权: '邀请生效后 2 项',
        最近活动: '尚未登录'
      })
    ],
    groups: [
      record('g-1', '平台工程', '维护内部 Agent 与能力节点', '12 名成员', 'online', ['8 个 Grant', '4 个设备组', '今天更新'], {
        成员: '12',
        设备组: 'GPU 节点、开发工作站',
        角色: '发布者、审批人',
        范围: 'MesaLab'
      }),
      record('g-2', '设计中心', '使用视觉与内容能力', '28 名成员', 'online', ['5 个 Grant', '2 个设备组', '昨天更新'], {
        成员: '28',
        设备组: '设计工作站',
        角色: '成员',
        范围: 'MesaLab'
      })
    ],
    roles: [
      record('r-1', '组织管理员', '管理成员、设备、策略与联邦', '6 人', 'online', ['系统内置', '高权限', '全组织'], {
        权限: '组织范围管理',
        绑定人数: '6',
        可委托: '否',
        最近变更: '系统内置'
      }),
      record('r-2', '能力发布者', '发布获准能力和签名包', '9 人', 'neutral', ['自定义', '有界范围', '4 个组'], {
        权限: 'Publication、Package',
        绑定人数: '9',
        可委托: '按策略',
        最近变更: '3 天前'
      })
    ],
    devices: [
      record('d-1', 'Jiang-PC', '林江 · Windows 11 x64', '在线', 'online', ['2 项能力', '客户端 0.12.4', '刚刚'], {
        注册状态: '已验证',
        连接代次: 'generation 84',
        最近地址: '内网出口 · 已脱敏',
        合规状态: '符合组织基线'
      }),
      record('d-2', 'GPU-Worker-02', 'AI Team · Linux x64', '在线', 'online', ['8 项能力', '客户端 0.12.3', '12 秒前'], {
        注册状态: '已验证',
        连接代次: 'generation 221',
        最近地址: '计算节点区 · 已脱敏',
        合规状态: '符合组织基线'
      }),
      record('d-3', 'Design-Mac-07', '陈汐 · macOS arm64', '离线', 'offline', ['3 项能力', '客户端 0.12.2', '2 小时前'], {
        注册状态: '已验证',
        连接代次: 'generation 17',
        最近地址: '办公网络 · 已脱敏',
        合规状态: '客户端建议更新'
      }),
      record('d-4', 'Legacy-Lab', '测试组 · Linux x64', '已撤销', 'danger', ['0 项可用能力', '客户端 0.10.1', '12 天前'], {
        注册状态: '2026-08-24 已撤销',
        连接代次: '无活动连接',
        最近地址: '不再保留',
        合规状态: '不具备新任务资格'
      })
    ],
    capabilities: [
      record('c-1', '图像生成', 'image.generate · 2.1.0', '2 / 3 在线', 'warning', ['3 个 Provider', '设计组', 'remote'], {
        输入: '文本、参考图片',
        数据策略: '任务期保留，不允许委托',
        版本: '2.0.x – 2.1.x',
        最近错误: 'Design-Mac-07 离线'
      }),
      record('c-2', '文档转 Word', 'document.convert.docx · 1.4.0', '可用', 'online', ['2 个 Provider', '全组织', 'remote + package'], {
        输入: 'PDF、图片、文本',
        数据策略: '处理完成立即清理',
        版本: '1.4.0',
        最近错误: '无'
      }),
      record('c-3', '代码安全扫描', 'code.security.scan · 3.0.2', '已暂停', 'offline', ['4 个 Provider', '平台工程', 'remote'], {
        输入: '代码目录',
        数据策略: '仅组织内，不允许联网',
        版本: '3.0.2',
        最近错误: 'Publication 被管理员暂停'
      })
    ],
    policies: [
      record('p-1', '生产数据禁止跨组织', '组织强制策略 · deny', '已生效', 'online', ['优先级最高', '数据分类：生产', '刚刚评估'], {
        作用主体: '全体成员与设备',
        能力范围: '全部能力',
        决策: '跨组织调用时拒绝',
        修订版本: 'revision 18'
      }),
      record('p-2', '设计组图像能力', 'Grant · allow', '已生效', 'online', ['设计中心', '每日 20 次/人', '有效至 12-31'], {
        作用主体: '用户组：设计中心',
        能力范围: '图像生成 2.x',
        决策: '允许文本与图片输入',
        修订版本: 'revision 6'
      }),
      record('p-3', '外部法务文档转换', 'Grant · require_approval', '已生效', 'warning', ['联邦组织', '每次审批', '有效至 10-01'], {
        作用主体: '法务服务商',
        能力范围: '文档转 Word 1.4.0',
        决策: '每次调用需要审批',
        修订版本: 'revision 3'
      })
    ],
    approvals: [
      record('a-1', '权限扩大更新', '代码安全扫描 3.1.0', '等待审批', 'warning', ['申请人：周启', '新增网络访问', '等待 42 分钟'], {
        申请类型: 'Package 权限变化',
        影响范围: '平台工程组 12 台设备',
        策略依据: '权限扩大必须重新批准',
        有效期限: '批准后 7 天内发布'
      }),
      record('a-2', '本次能力调用', '法务服务商 → 文档转 Word', '等待审批', 'warning', ['申请人：王简', '机密文档', '等待 18 分钟'], {
        申请类型: '联邦能力调用',
        影响范围: '1 个 PDF，2.8 MB',
        策略依据: '外部法务文档转换',
        有效期限: '本次调用，15 分钟'
      }),
      record('a-3', '发布图像生成能力', 'GPU-Worker-05 · 2.1.0', '等待审批', 'warning', ['申请人：苏禾', '组织内发布', '等待 6 分钟'], {
        申请类型: 'Publication',
        影响范围: '设计中心可发现并调用',
        策略依据: '新增 Provider 需要审批',
        有效期限: '批准后持续有效'
      })
    ],
    releases: [
      record('pkg-1', 'document-convert', '1.4.0 · Linux/Windows/macOS', '可用', 'online', ['签名已验证', '48.2 MB', '稳定通道'], {
        摘要: 'sha256: 9b3a…42e1',
        发布者: 'MesaLab Platform',
        权限变化: '无',
        下载事实: '24 台成功，0 台失败'
      }),
      record('pkg-2', 'security-scanner', '3.1.0 · Linux x64', '等待审批', 'warning', ['签名已验证', '128.6 MB', '候选通道'], {
        摘要: 'sha256: a18f…91d0',
        发布者: 'Security Team',
        权限变化: '新增受限网络访问',
        下载事实: '尚未进入发布目录'
      }),
      record('pkg-3', 'image-runtime', '2.0.4 · Linux x64', '紧急撤销', 'danger', ['签名有效', '3.2 GB', '已停止下载'], {
        摘要: 'sha256: f221…d872',
        发布者: 'AI Team',
        权限变化: '无',
        下载事实: '因运行崩溃于 09-02 撤销'
      })
    ],
    federation: [
      record('f-1', '法务服务商', 'share.legal.example', '已连接', 'online', ['2 项开放能力', '双边确认', '有效至 12-31'], {
        我方开放: '文档转 Word',
        对方开放: '合同审阅、法规检索',
        最终可用: '2 项',
        网关指纹: 'SHA256:9F:2A:…:71'
      }),
      record('f-2', '华东研究院', 'gateway.east-research.internal', '已暂停', 'offline', ['5 项开放能力', '我方暂停', '无新任务'], {
        我方开放: '代码扫描、文档解析',
        对方开放: '仿真计算、数据清洗、模型评测',
        最终可用: '暂停期间 0 项',
        网关指纹: 'SHA256:42:BC:…:E9'
      })
    ],
    tasks: [
      record('t-1', 'task_8B2K…19QF', '陈汐 → 图像生成', '运行中', 'online', ['GPU-Worker-02', '网关直连', '已运行 38 秒'], {
        数据类别: '普通 · 文本与图片',
        Provider: 'GPU-Worker-02 / image.generate 2.1.0',
        路由: '经 ShareServer 协商后端点直连',
        最后确认点: 'Provider 已报告 62%'
      }),
      record('t-2', 'task_4D8M…71XA', '王简 → 文档转 Word', '等待审批', 'warning', ['法务服务商', '联邦中继', '18 分钟前'], {
        数据类别: '机密 · PDF',
        Provider: 'MesaLab / document.convert.docx',
        路由: '联邦 + 端到端加密中继',
        最后确认点: '尚未发送正文'
      }),
      record('t-3', 'task_2A9P…82CD', '平台工程 → 代码安全扫描', '结果未知', 'danger', ['GPU-Worker-09', '网关直连', '1 小时前'], {
        数据类别: '内部 · 代码',
        Provider: 'GPU-Worker-09 / code.security.scan 3.0.2',
        路由: '端点直连',
        最后确认点: 'Provider 执行后连接中断'
      })
    ],
    audit: [
      record('e-1', '批准 Publication', '林江 · GPU-Worker-05', '成功', 'online', ['MesaLab', 'audit_7K2…1PA', '09:38:12'], {
        操作者: '林江 (user_81A…)',
        对象: 'publication_71B…',
        结果: 'active',
        时间: '2026-09-05T09:38:12+08:00'
      }),
      record('e-2', '撤销设备', '陈汐 · Legacy-Lab', '成功', 'online', ['MesaLab', 'audit_1M4…9FD', '09:14:07'], {
        操作者: '陈汐 (user_22C…)',
        对象: 'device_B82…',
        结果: 'revoked',
        时间: '2026-09-05T09:14:07+08:00'
      }),
      record('e-3', '创建联邦任务', '王简 · 法务服务商', '需要审批', 'warning', ['MesaLab', 'audit_8X7…0QA', '09:02:44'], {
        操作者: '王简 (external_subject_18D…)',
        对象: 'task_4D8…',
        结果: 'require_approval',
        时间: '2026-09-05T09:02:44+08:00'
      })
    ],
    myDevices: [
      record('md-1', 'Jiang-PC', '当前设备 · Windows 11 x64', '在线', 'online', ['2 项已发布能力', '5 项可用授权', '刚刚'], {
        注册时间: '2026-08-11',
        当前组织: 'MesaLab',
        发布能力: '屏幕理解、文档解析',
        登录状态: '当前 Web 会话不等于设备凭据'
      }),
      record('md-2', 'Home-Mac', 'macOS arm64', '离线', 'offline', ['未发布能力', '3 项可用授权', '4 天前'], {
        注册时间: '2026-07-28',
        当前组织: 'MesaLab',
        发布能力: '无',
        登录状态: '需要重新连接 ShareServer'
      })
    ],
    myGrants: [
      record('mg-1', '图像生成 2.x', '设计中心 Grant', '可调用', 'online', ['文本与图片', '每日 20 次', '组织内'], {
        Provider: '3 个已发布节点',
        数据范围: '普通、内部',
        有效期: '2026-12-31',
        委托: '不允许'
      }),
      record('mg-2', '文档转 Word 1.4.0', '全组织 Grant', '可调用与下载', 'online', ['PDF、图片、文本', '每次最大 10 MB', '组织内'], {
        Provider: '2 个在线节点',
        数据范围: '普通、内部、机密',
        有效期: '持续有效',
        委托: '不允许'
      })
    ],
    myRequests: [
      record('mr-1', '本次能力调用', '法务服务商 → 文档转 Word', '等待审批', 'warning', ['机密文档', '18 分钟前', '15 分钟有效'], {
        申请对象: 'task_4D8M…71XA',
        审批范围: '仅本次调用',
        当前阶段: '尚未发送正文',
        可执行操作: '取消申请'
      }),
      record('mr-2', '设备注册', 'Home-Mac', '已批准', 'online', ['MesaLab', '2026-07-28', '已完成'], {
        申请对象: 'device_91M…A21',
        审批范围: '设备注册',
        当前阶段: '设备当前离线',
        可执行操作: '查看设备'
      })
    ]
  }
}
