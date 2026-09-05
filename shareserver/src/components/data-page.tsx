import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { PrototypeRecord, PrototypeSnapshot } from '../../shared/prototype-data'
import type { PageConfig } from '../app-config'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'
import { StatusBadge } from './ui/status-badge'
import { PageHeader } from './page-header'

type Feedback = {
  tone: 'success' | 'danger'
  message: string
}

async function sendPrototypeAction(action: string, targetId: string): Promise<void> {
  const response = await fetch('/api/v1/web/prototype/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, targetId })
  })
  if (!response.ok) {
    throw new Error('原型操作未能提交，请重试。')
  }
}

function DetailPanel({
  record,
  page,
  onAction
}: {
  record: PrototypeRecord
  page: PageConfig
  onAction: (action: string, record: PrototypeRecord) => void
}) {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] pb-5">
        <div>
          <p className="text-base font-semibold text-slate-100">{record.primary}</p>
          <p className="mt-1 text-sm text-slate-400">{record.secondary}</p>
        </div>
        <StatusBadge status={record.status} tone={record.statusTone} />
      </div>
      <dl className="divide-y divide-white/[0.06]">
        {Object.entries(record.detail).map(([label, value]) => (
          <div key={label} className="grid gap-1 py-4 sm:grid-cols-[140px_1fr] sm:gap-4">
            <dt className="text-xs font-medium text-slate-500">{label}</dt>
            <dd className="text-sm leading-6 text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-white/[0.07] pt-5">
        {page.path === '/approvals' ? (
          <>
            <Button variant="danger" onClick={() => onAction('拒绝申请', record)}>
              <X className="size-4" />
              拒绝
            </Button>
            <Button onClick={() => onAction('批准申请', record)}>
              <Check className="size-4" />
              批准此申请
            </Button>
          </>
        ) : null}
        {page.path === '/devices' && record.status !== '已撤销' ? (
          <Button variant="danger" onClick={() => onAction('撤销设备', record)}>
            撤销设备
          </Button>
        ) : null}
        {page.path === '/tasks' && record.status === '运行中' ? (
          <Button variant="danger" onClick={() => onAction('取消任务', record)}>
            取消任务
          </Button>
        ) : null}
        {page.path === '/federation' ? (
          <Button variant="secondary" onClick={() => onAction('切换联邦状态', record)}>
            {record.status === '已连接' ? '暂停关系' : '恢复关系'}
          </Button>
        ) : null}
        {!['/approvals', '/devices', '/tasks', '/federation'].includes(page.path) ? (
          <Button variant="secondary" onClick={() => onAction('保存变更', record)}>
            编辑配置
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function DataPage({
  page,
  snapshot
}: {
  page: PageConfig
  snapshot: PrototypeSnapshot
}) {
  const [activeKey, setActiveKey] = useState(page.dataKey ?? '')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('全部状态')
  const [selected, setSelected] = useState<PrototypeRecord | null>(null)
  const [actionTarget, setActionTarget] = useState<{
    action: string
    record: PrototypeRecord
  } | null>(null)
  const [primaryOpen, setPrimaryOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const records = useMemo(
    () => snapshot.pages[activeKey] ?? [],
    [activeKey, snapshot.pages]
  )
  const statuses = ['全部状态', ...new Set(records.map((item) => item.status))]
  const visibleRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return records.filter((item) => {
      const matchesQuery =
        !normalized ||
        [item.primary, item.secondary, ...item.meta]
          .join(' ')
          .toLowerCase()
          .includes(normalized)
      const matchesStatus = statusFilter === '全部状态' || item.status === statusFilter
      return matchesQuery && matchesStatus
    })
  }, [query, records, statusFilter])

  const handleAction = (action: string, record: PrototypeRecord) => {
    setSelected(null)
    setActionTarget({ action, record })
  }

  const confirmAction = async () => {
    if (!actionTarget) return
    setSubmitting(true)
    try {
      await sendPrototypeAction(actionTarget.action, actionTarget.record.id)
      setFeedback({
        tone: 'success',
        message: `${actionTarget.action}已在交互原型中完成，不会写入生产数据。`
      })
      setActionTarget(null)
    } catch (error) {
      setFeedback({
        tone: 'danger',
        message: error instanceof Error ? error.message : '操作失败，请重试。'
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={`组织 · ${snapshot.instance.organization}`}
        title={page.title}
        description={page.description}
        action={
          page.primaryAction ? (
            <Button onClick={() => setPrimaryOpen(true)}>
              {page.primaryAction}
              <ArrowRight className="size-4" />
            </Button>
          ) : undefined
        }
      />

      {feedback ? (
        <div
          role={feedback.tone === 'danger' ? 'alert' : 'status'}
          className={cn(
            'mb-5 flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-sm',
            feedback.tone === 'success'
              ? 'border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-200'
              : 'border-rose-400/20 bg-rose-400/[0.08] text-rose-200'
          )}
        >
          <span>{feedback.message}</span>
          <button
            aria-label="关闭消息"
            className="rounded p-1 outline-none hover:bg-white/10 focus-visible:ring-2"
            onClick={() => setFeedback(null)}
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      {page.tabs ? (
        <div
          role="tablist"
          aria-label={`${page.title}分类`}
          className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-white/[0.07] bg-white/[0.025] p-1"
        >
          {page.tabs.map((tab) => (
            <button
              key={tab.dataKey}
              role="tab"
              aria-selected={activeKey === tab.dataKey}
              className={cn(
                'min-h-8 shrink-0 rounded-lg px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-400/70',
                activeKey === tab.dataKey
                  ? 'bg-white/[0.09] font-medium text-slate-100 shadow-sm'
                  : 'text-slate-500 hover:text-slate-200'
              )}
              onClick={() => {
                setActiveKey(tab.dataKey)
                setStatusFilter('全部状态')
                setQuery('')
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-white/[0.075] bg-[var(--panel)] shadow-[0_18px_50px_-36px_rgba(0,0,0,.7)]">
        <div className="flex flex-col gap-3 border-b border-white/[0.07] p-4 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-500" />
            <span className="sr-only">搜索{page.title}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/10 pl-9 pr-3 text-sm outline-none placeholder:text-slate-600 focus:border-cyan-300/35 focus:ring-2 focus:ring-cyan-400/10"
              placeholder={`搜索${page.title}…`}
            />
          </label>
          <label className="relative">
            <span className="sr-only">状态筛选</span>
            <Filter className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-500" />
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-9 min-w-36 appearance-none rounded-lg border border-white/[0.08] bg-[var(--control)] pl-9 pr-8 text-sm text-slate-300 outline-none focus:border-cyan-300/35 focus:ring-2 focus:ring-cyan-400/10"
            >
              {statuses.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
          </label>
          <Button variant="secondary">
            <SlidersHorizontal className="size-4" />
            更多筛选
          </Button>
        </div>

        <div className="hidden grid-cols-[minmax(220px,1.45fr)_minmax(160px,.85fr)_minmax(300px,1.7fr)_44px] border-b border-white/[0.06] px-5 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400 md:grid">
          <span>对象</span>
          <span>状态</span>
          <span>范围与事实</span>
          <span className="sr-only">操作</span>
        </div>

        <div className="divide-y divide-white/[0.055]">
          {visibleRecords.map((item) => (
            <button
              key={item.id}
              className="group grid w-full gap-4 px-5 py-4 text-left outline-none transition hover:bg-cyan-300/[0.025] focus-visible:bg-cyan-300/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/50 md:grid-cols-[minmax(220px,1.45fr)_minmax(160px,.85fr)_minmax(300px,1.7fr)_44px] md:items-center"
              onClick={() => setSelected(item)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--text-strong)]">
                  {item.primary}
                </span>
                <span className="mt-1 block truncate text-xs text-[var(--text-muted)]">
                  {item.secondary}
                </span>
              </span>
              <StatusBadge status={item.status} tone={item.statusTone} />
              <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
                {item.meta.map((meta) => (
                  <span key={meta} className="truncate">
                    {meta}
                  </span>
                ))}
              </span>
              <span className="hidden size-8 place-items-center rounded-lg text-slate-500 transition group-hover:bg-white/[0.06] group-hover:text-slate-200 md:grid">
                <MoreHorizontal className="size-4" />
              </span>
            </button>
          ))}
          {visibleRecords.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <p className="text-sm font-medium text-slate-300">没有符合条件的结果</p>
              <p className="mt-1 text-xs text-slate-500">请修改关键词或清除状态筛选。</p>
              <Button
                className="mt-4"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setQuery('')
                  setStatusFilter('全部状态')
                }}
              >
                清除筛选
              </Button>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-white/[0.07] px-5 py-3 text-xs text-[var(--text-muted)]">
          <span>显示 {visibleRecords.length} / {records.length} 项</span>
          <div className="flex items-center gap-1">
            <Button aria-label="上一页" disabled size="icon" variant="ghost">
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2">第 1 页</span>
            <Button aria-label="下一页" disabled size="icon" variant="ghost">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </footer>
      </section>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={`${page.title}详情`}
        description="当前组织范围内可见的有界元数据。"
      >
        {selected ? (
          <DetailPanel record={selected} page={page} onAction={handleAction} />
        ) : null}
      </Dialog>

      <Dialog
        open={primaryOpen}
        onOpenChange={setPrimaryOpen}
        title={page.primaryAction ?? '创建对象'}
        description={`该表单展示 ${page.title} 的完整交互结构；本阶段不会写入生产数据库。`}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            setPrimaryOpen(false)
            setFeedback({
              tone: 'success',
              message: `${page.primaryAction ?? '操作'}已在交互原型中提交。`
            })
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">名称或标识</span>
            <input
              required
              className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 text-sm outline-none focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-400/10"
              placeholder={`输入${page.title}名称`}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">范围</span>
            <select className="h-10 w-full rounded-lg border border-white/10 bg-[var(--control)] px-3 text-sm outline-none focus:border-cyan-300/40">
              <option>组织：{snapshot.instance.organization}</option>
              <option>指定用户组</option>
              <option>仅当前用户</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">说明</span>
            <textarea
              className="min-h-24 w-full resize-y rounded-lg border border-white/10 bg-white/[0.035] p-3 text-sm outline-none focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-400/10"
              placeholder="补充用途、影响范围或有效期"
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setPrimaryOpen(false)}>
              取消
            </Button>
            <Button type="submit">{page.primaryAction ?? '提交'}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(actionTarget)}
        onOpenChange={(open) => !open && setActionTarget(null)}
        title={actionTarget?.action ?? '确认操作'}
        description={
          actionTarget
            ? `对象：${actionTarget.record.primary}。请确认操作范围和直接影响。`
            : undefined
        }
      >
        <div className="rounded-xl border border-amber-400/15 bg-amber-300/[0.055] p-4 text-sm leading-6 text-amber-100/80">
          这是交互原型。确认后会调用 ShareServer 原型 API 并返回请求编号，但不会更改生产数据。
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setActionTarget(null)}>
            取消
          </Button>
          <Button
            variant={actionTarget?.action.includes('撤销') || actionTarget?.action.includes('拒绝') ? 'danger' : 'default'}
            disabled={submitting}
            onClick={confirmAction}
          >
            {submitting ? '正在提交…' : actionTarget?.action}
          </Button>
        </div>
      </Dialog>
    </>
  )
}
