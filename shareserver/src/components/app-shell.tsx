import {
  Bell,
  ChevronsUpDown,
  Command,
  Menu,
  MoonStar,
  Search,
  Shield,
  Sun,
  X
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import type { PrototypeRole, PrototypeSnapshot } from '../../shared/prototype-data'
import { visiblePages } from '../app-config'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'

function BrandMark() {
  return (
    <div className="relative grid size-10 shrink-0 place-items-center rounded-xl border border-cyan-300/25 bg-cyan-300/10 text-cyan-300 shadow-[0_0_34px_-10px_rgba(34,211,238,.9)]">
      <span className="absolute inset-1 rounded-lg border border-violet-400/20" />
      <Shield aria-hidden="true" className="size-5" />
    </div>
  )
}

export function AppShell({
  snapshot,
  role,
  onRoleChange,
  children
}: {
  snapshot: PrototypeSnapshot
  role: PrototypeRole
  onRoleChange: (role: PrototypeRole) => void
  children: ReactNode
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [dark, setDark] = useState(true)
  const navigate = useNavigate()
  const navigation = visiblePages(role)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const nav = (
    <>
      <div className="flex h-19 items-center gap-3 border-b border-white/[0.07] px-5">
        <BrandMark />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-wide text-white">
            {snapshot.instance.name}
          </p>
          <p className="truncate text-[11px] uppercase tracking-[0.16em] text-cyan-300/70">
            Control plane
          </p>
        </div>
      </div>
      <div className="px-3 py-4">
        <button className="flex w-full items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.035] px-3 py-2.5 text-left outline-none transition hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-cyan-400/70">
          <span className="grid size-8 place-items-center rounded-lg bg-violet-400/12 text-sm font-semibold text-violet-200">
            M
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-100">
              {snapshot.instance.organization}
            </span>
            <span className="block truncate text-[11px] text-slate-500">当前组织</span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-4 text-slate-500" />
        </button>
      </div>
      <nav aria-label={role === 'admin' ? '管理控制台' : '成员自助'} className="flex-1 overflow-y-auto px-3 pb-4">
        <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
          {role === 'admin' ? '组织控制台' : '成员自助'}
        </p>
        <div className="space-y-1">
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'group relative flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-400/70',
                    isActive
                      ? 'bg-cyan-300/[0.09] font-medium text-cyan-100'
                      : 'text-slate-400 hover:bg-white/[0.045] hover:text-slate-100'
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(34,211,238,.9)]" />
                    ) : null}
                    <Icon aria-hidden="true" className="size-[18px]" />
                    <span>{item.title}</span>
                    {item.path === '/approvals' ? (
                      <span className="ml-auto rounded-full bg-amber-300/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                        6
                      </span>
                    ) : null}
                  </>
                )}
              </NavLink>
            )
          })}
        </div>
      </nav>
      <div className="border-t border-white/[0.07] p-3">
        <button
          onClick={() => {
            const nextRole = role === 'admin' ? 'member' : 'admin'
            onRoleChange(nextRole)
            navigate(nextRole === 'admin' ? '/' : '/me/devices')
          }}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-cyan-400/70"
        >
          <span className="grid size-9 place-items-center rounded-full border border-violet-300/20 bg-gradient-to-br from-cyan-300/25 to-violet-400/25 text-sm font-semibold text-white">
            林
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-200">林江</span>
            <span className="block truncate text-[11px] text-slate-500">
              {role === 'admin' ? '切换到成员自助' : '切换到管理控制台'}
            </span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-4 text-slate-600" />
        </button>
      </div>
    </>
  )

  return (
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--text-primary)]">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-60 -top-72 size-[620px] rounded-full bg-cyan-500/[0.055] blur-3xl" />
        <div className="absolute -right-48 top-24 size-[520px] rounded-full bg-violet-500/[0.06] blur-3xl" />
        <div className="grid-overlay absolute inset-0 opacity-40" />
      </div>
      <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden w-[258px] flex-col border-r border-white/[0.075] bg-[#07111f]/95 backdrop-blur-xl lg:flex">
        {nav}
      </aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="关闭导航"
            className="absolute inset-0 bg-slate-950/75 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="app-sidebar relative flex h-full w-[min(300px,86vw)] flex-col border-r border-white/10 bg-[#07111f] shadow-2xl">
            <Button
              aria-label="关闭导航"
              className="absolute right-3 top-3 z-10"
              size="icon"
              variant="ghost"
              onClick={() => setMobileOpen(false)}
            >
              <X className="size-5" />
            </Button>
            {nav}
          </aside>
        </div>
      ) : null}
      <div className="relative lg:pl-[258px]">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-white/[0.07] bg-[var(--header)] px-4 backdrop-blur-xl sm:px-6">
          <Button
            aria-label="打开导航"
            className="lg:hidden"
            size="icon"
            variant="ghost"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <button
            className="flex h-9 max-w-md flex-1 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.035] px-3 text-left text-sm text-slate-500 outline-none transition hover:border-white/[0.15] hover:bg-white/[0.055] focus-visible:ring-2 focus-visible:ring-cyan-400/70 sm:flex-initial sm:basis-[360px]"
            onClick={() => setSearchOpen(true)}
          >
            <Search aria-hidden="true" className="size-4" />
            <span className="min-w-0 flex-1 truncate">搜索设备、能力、任务或成员</span>
            <span className="hidden items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-500 sm:flex">
              <Command className="size-3" />K
            </span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-2 hidden items-center gap-2 text-xs text-slate-500 xl:flex">
              <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.8)]" />
              控制面正常
            </span>
            <Button
              aria-label={dark ? '切换到浅色主题' : '切换到深色主题'}
              size="icon"
              variant="ghost"
              onClick={() => setDark((value) => !value)}
            >
              {dark ? <Sun className="size-4" /> : <MoonStar className="size-4" />}
            </Button>
            <Button aria-label="查看通知，6 条待处理" size="icon" variant="ghost">
              <Bell className="size-4" />
              <span className="absolute ml-3 mt-[-13px] size-1.5 rounded-full bg-amber-300" />
            </Button>
          </div>
        </header>
        <main className="min-h-[calc(100vh-4rem)] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto max-w-[1440px]">{children}</div>
        </main>
      </div>
      <Dialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="全局搜索"
        description={`搜索范围：组织 ${snapshot.instance.organization}`}
        width="max-w-2xl"
      >
        <div className="relative">
          <Search className="absolute left-3 top-3 size-4 text-slate-500" />
          <input
            autoFocus
            aria-label="搜索关键词"
            className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.04] pl-10 pr-3 text-sm outline-none placeholder:text-slate-600 focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-400/15"
            placeholder="输入设备、能力、任务 ID 或成员名称…"
          />
        </div>
        <p className="mt-5 text-center text-sm text-slate-500">
          输入关键词后，将按当前身份和组织权限显示结果。
        </p>
      </Dialog>
    </div>
  )
}
