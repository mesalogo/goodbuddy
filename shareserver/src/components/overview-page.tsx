import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  GitFork,
  RadioTower,
  ServerCog,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { Metric, PrototypeSnapshot } from '../../shared/prototype-data'
import { PageHeader } from './page-header'
import { StatusBadge } from './ui/status-badge'

const metricStyles: Record<Metric['tone'], string> = {
  cyan: 'from-cyan-400/16 to-cyan-400/[0.025] border-cyan-300/15 text-cyan-300',
  violet: 'from-violet-400/16 to-violet-400/[0.025] border-violet-300/15 text-violet-300',
  amber: 'from-amber-400/16 to-amber-400/[0.025] border-amber-300/15 text-amber-200',
  rose: 'from-rose-400/16 to-rose-400/[0.025] border-rose-300/15 text-rose-300'
}

export function OverviewPage({ snapshot }: { snapshot: PrototypeSnapshot }) {
  const navigate = useNavigate()
  const maxActivity = Math.max(...snapshot.activity.map((item) => item.value))
  const recent = [
    {
      icon: ShieldCheck,
      title: '策略决定',
      copy: '生产数据跨组织请求被强制策略拒绝',
      time: '2 分钟前',
      tone: 'warning' as const
    },
    {
      icon: CheckCircle2,
      title: '能力发布',
      copy: 'GPU-Worker-05 的图像生成能力已批准',
      time: '4 分钟前',
      tone: 'online' as const
    },
    {
      icon: GitFork,
      title: '联邦心跳',
      copy: '法务服务商网关完成双边状态同步',
      time: '8 分钟前',
      tone: 'neutral' as const
    }
  ]

  return (
    <>
      <PageHeader
        eyebrow={`实例 · ${snapshot.instance.region}`}
        title="运行概览"
        description={`${snapshot.instance.name} 正在为组织 ${snapshot.instance.organization} 提供控制面服务。`}
        action={
          <div className="flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.06] px-3 py-2 text-xs text-emerald-200">
            <span className="size-1.5 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(52,211,153,.9)]" />
            所有核心服务正常
          </div>
        }
      />

      <section aria-label="关键指标" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {snapshot.metrics.map((metric) => (
          <button
            key={metric.label}
            className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-5 text-left outline-none transition duration-200 hover:-translate-y-0.5 hover:border-white/20 focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${metricStyles[metric.tone]}`}
            onClick={() => navigate(metric.target)}
          >
            <div className="absolute -right-8 -top-8 size-24 rounded-full bg-current opacity-[0.055] blur-2xl" />
            <div className="flex items-start justify-between">
              <span className="text-xs font-medium text-[var(--text-muted)]">{metric.label}</span>
              <ArrowUpRight className="size-4 opacity-50 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
            </div>
            <p className="mt-5 text-3xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">
              {metric.value}
            </p>
            <p className="mt-2 text-xs text-[var(--text-muted)]">{metric.detail}</p>
          </button>
        ))}
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.55fr_.85fr]">
        <section className="rounded-2xl border border-white/[0.075] bg-[var(--panel)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-strong)]">任务活动</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">过去 12 小时创建的任务</p>
            </div>
            <span className="rounded-lg border border-white/[0.07] bg-white/[0.035] px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
              24 小时
            </span>
          </div>
          <div className="mt-8 flex h-52 items-end gap-2 sm:gap-3" role="img" aria-label="过去十二小时任务量柱状图">
            {snapshot.activity.map((item, index) => (
              <div key={item.time} className="group flex h-full min-w-0 flex-1 flex-col justify-end">
                <div className="relative flex-1">
                  <div
                    className="absolute inset-x-0 bottom-0 min-h-1 rounded-t-md bg-gradient-to-t from-cyan-400/35 to-cyan-300/90 shadow-[0_0_18px_-8px_rgba(34,211,238,.8)] transition group-hover:from-violet-400/50 group-hover:to-violet-300"
                    style={{ height: `${Math.max(6, (item.value / maxActivity) * 100)}%` }}
                  >
                    <span className="absolute -top-6 left-1/2 hidden -translate-x-1/2 text-[10px] text-cyan-200 group-hover:block">
                      {item.value}
                    </span>
                  </div>
                </div>
                <span className={`mt-2 text-center text-[9px] text-slate-600 ${index % 2 ? 'hidden sm:block' : ''}`}>
                  {item.time}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/[0.075] bg-[var(--panel)] p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-strong)]">网络脉冲</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">连接与路由实时摘要</p>
            </div>
            <RadioTower className="size-5 text-cyan-300" />
          </div>
          <div className="relative mt-7 grid place-items-center py-4">
            <div className="pulse-ring absolute size-36 rounded-full border border-cyan-300/10" />
            <div className="pulse-ring pulse-delay absolute size-24 rounded-full border border-cyan-300/15" />
            <div className="relative grid size-16 place-items-center rounded-full border border-cyan-300/25 bg-cyan-300/10 shadow-[0_0_45px_-10px_rgba(34,211,238,.7)]">
              <ServerCog className="size-7 text-cyan-200" />
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-white/[0.025] p-3">
              <dt className="text-[10px] text-slate-500">设备连接</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-200">18</dd>
            </div>
            <div className="rounded-xl bg-white/[0.025] p-3">
              <dt className="text-[10px] text-slate-500">联邦网关</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-200">1 / 2</dd>
            </div>
            <div className="rounded-xl bg-white/[0.025] p-3">
              <dt className="text-[10px] text-slate-500">中继占用</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-200">34%</dd>
            </div>
          </dl>
        </section>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="overflow-hidden rounded-2xl border border-white/[0.075] bg-[var(--panel)]">
          <header className="flex items-center justify-between border-b border-white/[0.065] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-strong)]">需要关注</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">按影响与等待时间排序</p>
            </div>
            <CircleAlert className="size-5 text-amber-300" />
          </header>
          <div className="divide-y divide-white/[0.055]">
            {snapshot.pages.approvals.slice(0, 3).map((item) => (
              <button
                key={item.id}
                className="flex w-full items-center gap-4 px-5 py-4 text-left outline-none transition hover:bg-white/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60"
                onClick={() => navigate('/approvals')}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-amber-300/15 bg-amber-300/[0.07] text-amber-200">
                  <Sparkles className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text-strong)]">{item.primary}</span>
                  <span className="mt-1 block truncate text-xs text-[var(--text-muted)]">{item.secondary}</span>
                </span>
                <span className="hidden text-xs text-slate-600 sm:block">{item.meta[2]}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-white/[0.075] bg-[var(--panel)]">
          <header className="flex items-center justify-between border-b border-white/[0.065] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-strong)]">最近活动</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">仅显示有界审计元数据</p>
            </div>
            <Activity className="size-5 text-violet-300" />
          </header>
          <div className="divide-y divide-white/[0.055]">
            {recent.map((item) => {
              const Icon = item.icon
              return (
                <div key={item.copy} className="flex items-center gap-4 px-5 py-4">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-slate-300">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-slate-500">{item.title}</span>
                    <span className="mt-1 block truncate text-sm text-[var(--text-primary)]">{item.copy}</span>
                  </span>
                  <span className="text-xs text-slate-600">{item.time}</span>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <footer className="mt-6 flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
        <StatusBadge status="原型数据" tone="neutral" />
        <span>{snapshot.instance.protocol}</span>
        <span>·</span>
        <span>快照 {new Date(snapshot.instance.generatedAt).toLocaleString('zh-CN')}</span>
      </footer>
    </>
  )
}
