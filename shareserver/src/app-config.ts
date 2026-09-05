import {
  Activity,
  Boxes,
  Building2,
  CircleUserRound,
  Cpu,
  FileKey2,
  Gauge,
  GitFork,
  PackageCheck,
  ScrollText,
  Settings2,
  ShieldCheck,
  UserRoundCheck
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PrototypeRole } from '../shared/prototype-data'

export type PageConfig = {
  path: string
  title: string
  shortTitle?: string
  description: string
  dataKey?: string
  icon: LucideIcon
  role: PrototypeRole | 'all'
  primaryAction?: string
  tabs?: Array<{ label: string; dataKey: string }>
}

export const pages: PageConfig[] = [
  {
    path: '/',
    title: '运行概览',
    description: '需要行动的事项与当前 ShareServer 运行事实。',
    icon: Gauge,
    role: 'admin'
  },
  {
    path: '/members',
    title: '组织与成员',
    description: '管理当前组织的成员、用户组和有界角色。',
    dataKey: 'members',
    icon: Building2,
    role: 'admin',
    primaryAction: '邀请成员',
    tabs: [
      { label: '成员', dataKey: 'members' },
      { label: '用户组', dataKey: 'groups' },
      { label: '角色', dataKey: 'roles' }
    ]
  },
  {
    path: '/devices',
    title: '设备',
    description: '查看已注册设备、连接状态与合规元数据。',
    dataKey: 'devices',
    icon: Cpu,
    role: 'admin',
    primaryAction: '生成注册链接'
  },
  {
    path: '/capabilities',
    title: '能力目录',
    description: '查看显式发布的能力、版本和 Provider 可用性。',
    dataKey: 'capabilities',
    icon: Boxes,
    role: 'admin'
  },
  {
    path: '/policies',
    title: '权限策略',
    description: '配置拒绝优先的组织强制策略与 Grant。',
    dataKey: 'policies',
    icon: ShieldCheck,
    role: 'admin',
    primaryAction: '新建策略'
  },
  {
    path: '/approvals',
    title: '审批',
    description: '处理调用、发布、更新和联邦申请。',
    dataKey: 'approvals',
    icon: UserRoundCheck,
    role: 'admin'
  },
  {
    path: '/releases',
    title: '发布与更新',
    description: '管理签名能力包、发布通道、更新策略和撤销。',
    dataKey: 'releases',
    icon: PackageCheck,
    role: 'admin',
    primaryAction: '上传能力包'
  },
  {
    path: '/federation',
    title: '网关联邦',
    description: '管理经双边确认的组织协作边界。',
    dataKey: 'federation',
    icon: GitFork,
    role: 'admin',
    primaryAction: '建立联邦关系'
  },
  {
    path: '/tasks',
    title: '任务与中继',
    description: '查看任务路由、终态和可选中继容量。',
    dataKey: 'tasks',
    icon: Activity,
    role: 'admin'
  },
  {
    path: '/audit',
    title: '审计',
    description: '按组织查询有界操作元数据，不包含任务正文。',
    dataKey: 'audit',
    icon: ScrollText,
    role: 'admin',
    primaryAction: '导出当前结果'
  },
  {
    path: '/settings',
    title: '系统设置',
    description: '查看实例、身份源、基础设施状态与保留策略。',
    icon: Settings2,
    role: 'admin'
  },
  {
    path: '/me/devices',
    title: '我的设备',
    description: '查看你在当前组织注册的设备与连接状态。',
    dataKey: 'myDevices',
    icon: CircleUserRound,
    role: 'member'
  },
  {
    path: '/me/grants',
    title: '我的授权',
    description: '查看你获准发现、调用或下载的能力。',
    dataKey: 'myGrants',
    icon: FileKey2,
    role: 'member'
  },
  {
    path: '/me/requests',
    title: '我的申请',
    description: '跟踪你的设备、能力与任务审批。',
    dataKey: 'myRequests',
    icon: UserRoundCheck,
    role: 'member'
  }
]

export function visiblePages(role: PrototypeRole): PageConfig[] {
  return pages.filter((page) => page.role === 'all' || page.role === role)
}
