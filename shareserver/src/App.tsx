import { useEffect, useState } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation
} from 'react-router-dom'
import type { PrototypeRole, PrototypeSnapshot } from '../shared/prototype-data'
import { pages, visiblePages } from './app-config'
import { AppShell } from './components/app-shell'
import { DataPage } from './components/data-page'
import { OverviewPage } from './components/overview-page'
import { SettingsPage } from './components/settings-page'
import { Button } from './components/ui/button'

async function loadSnapshot(): Promise<PrototypeSnapshot> {
  const response = await fetch('/api/v1/web/prototype/snapshot')
  if (!response.ok) throw new Error('控制台快照加载失败')
  return response.json() as Promise<PrototypeSnapshot>
}

function LoadingState() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#07111f]" role="status" aria-busy="true">
      <div className="text-center">
        <div className="mx-auto size-10 animate-spin rounded-full border-2 border-cyan-300/15 border-t-cyan-300" />
        <p className="mt-4 text-sm text-slate-400">正在连接 ShareServer…</p>
      </div>
    </div>
  )
}

function Console({
  snapshot,
  role,
  onRoleChange
}: {
  snapshot: PrototypeSnapshot
  role: PrototypeRole
  onRoleChange: (role: PrototypeRole) => void
}) {
  const location = useLocation()
  const allowedPaths = visiblePages(role).map((page) => page.path)
  const fallback = role === 'admin' ? '/' : '/me/devices'

  if (!allowedPaths.includes(location.pathname)) {
    return <Navigate replace to={fallback} />
  }

  return (
    <AppShell snapshot={snapshot} role={role} onRoleChange={onRoleChange}>
      <Routes>
        {pages.map((page) => (
          <Route
            key={page.path}
            path={page.path}
            element={
              page.path === '/' ? (
                <OverviewPage snapshot={snapshot} />
              ) : page.path === '/settings' ? (
                <SettingsPage snapshot={snapshot} />
              ) : (
                <DataPage page={page} snapshot={snapshot} />
              )
            }
          />
        ))}
        <Route path="*" element={<Navigate replace to={fallback} />} />
      </Routes>
    </AppShell>
  )
}

export default function App() {
  const [snapshot, setSnapshot] = useState<PrototypeSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [role, setRole] = useState<PrototypeRole>('admin')

  useEffect(() => {
    let cancelled = false
    loadSnapshot()
      .then((data) => {
        if (!cancelled) setSnapshot(data)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : '控制台加载失败')
        }
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#07111f] p-6 text-slate-100">
        <div role="alert" className="max-w-md rounded-2xl border border-rose-400/20 bg-rose-400/[0.06] p-6 text-center">
          <p className="font-medium">{error}</p>
          <p className="mt-2 text-sm text-slate-400">请确认 ShareServer API 已启动，然后重试。</p>
          <Button
            className="mt-5"
            onClick={() => {
              setError(null)
              setReloadKey((key) => key + 1)
            }}
          >
            重新连接
          </Button>
        </div>
      </div>
    )
  }

  if (!snapshot) return <LoadingState />

  return (
    <BrowserRouter>
      <Console snapshot={snapshot} role={role} onRoleChange={setRole} />
    </BrowserRouter>
  )
}
