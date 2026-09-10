import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronLeft, ChevronRight, Download, FileText, GitBranch } from 'lucide-react'
import type { WorkspaceManagementAction, WorkspaceManagementResult } from '../../shared/workspace-management-contracts'

type Result<K extends WorkspaceManagementResult['kind']> = Extract<WorkspaceManagementResult, { kind: K }>

export function WorkspaceGitTools({ projectId, refreshToken, onRefresh, viewControl, children }: {
  projectId: string; refreshToken?: unknown; onRefresh: () => Promise<void>; viewControl: React.ReactNode; children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const [branches, setBranches] = useState<Result<'branches'>>()
  const [branchOpen, setBranchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Result<'history'>>()
  const [historySize, setHistorySize] = useState(50)
  const workingRef = useRef<HTMLDivElement>(null)
  const [commit, setCommit] = useState<string>()
  const [files, setFiles] = useState<Result<'commitFiles'>>()
  const [patch, setPatch] = useState<Result<'commitDiff'>>()
  const [path, setPath] = useState<string>()
  const request = useRef(0)
  const branchRequest = useRef(0)
  const returnTrigger = useRef<HTMLElement | null>(null)
  const fileTrigger = useRef<HTMLElement | null>(null)
  const branchTrigger = useRef<HTMLButtonElement>(null)
  const diffBack = useRef<HTMLButtonElement>(null)
  const commitBack = useRef<HTMLButtonElement>(null)
  const action = (value: WorkspaceManagementAction): Promise<WorkspaceManagementResult> => window.goodbuddy.workspace.manage(projectId, value)
  useEffect(() => {
    const detailCounter = request
    return () => { detailCounter.current++ }
  }, [])
  useEffect(() => {
    const branchCounter = branchRequest
    const generation = ++branchRequest.current
    void window.goodbuddy.workspace.manage(projectId, { kind: 'branches' }).then((result) => {
      if (branchRequest.current === generation && result.kind === 'branches') setBranches(result)
    }).catch((reason: unknown) => { if (branchRequest.current === generation) setError(String(reason)) })
    return () => { branchCounter.current++ }
  }, [projectId, refreshToken])
  useEffect(() => { if (path) diffBack.current?.focus(); else if (commit) commitBack.current?.focus() }, [path, commit])
  const run = async (value: WorkspaceManagementAction): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await action(value)
      setBranchOpen(false); setHistory(undefined); setCommit(undefined); setFiles(undefined); setPath(undefined); setPatch(undefined)
      request.current++
      const result = await action({ kind: 'branches' })
      if (result.kind === 'branches') setBranches(result)
      await onRefresh()
      branchTrigger.current?.focus()
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const loadHistory = async (more = false): Promise<void> => {
    const generation = ++request.current
    setBusy(true); setError('')
    try {
      const result = await action({ kind: 'history', offset: more ? history?.commits.length ?? 0 : 0, head: more ? history?.head : undefined })
      if (generation === request.current && result.kind === 'history') setHistory({ ...result, commits: more ? [...(history?.commits ?? []), ...result.commits] : result.commits })
    } catch (reason) { if (generation === request.current) setError(String(reason)) }
    finally { if (generation === request.current) setBusy(false) }
  }
  const refreshHistory = useEffectEvent(() => {
    if (historyOpen && !commit && !busy) void loadHistory()
  })
  useEffect(() => {
    const timeout = setTimeout(() => refreshHistory(), 0)
    return () => clearTimeout(timeout)
  }, [projectId, refreshToken])
  const loadCommit = async (oid: string, selectedPath?: string): Promise<void> => {
    const generation = ++request.current
    setBusy(true); setError('')
    if (selectedPath) { setPath(selectedPath); setPatch(undefined) } else { setCommit(oid); setFiles(undefined) }
    try {
      const result = await action(selectedPath ? { kind: 'commitDiff', oid, path: selectedPath } : { kind: 'commitFiles', oid })
      if (generation !== request.current) return
      if (result.kind === 'commitFiles') setFiles(result)
      if (result.kind === 'commitDiff') setPatch(result)
    } catch (reason) { if (generation === request.current) setError(String(reason)) }
    finally { if (generation === request.current) setBusy(false) }
  }
  return <div className="workspace-git">
    {error && <p role="alert">{error}<button type="button" disabled={busy} onClick={() => { if (commit) void loadCommit(commit, path); else void loadHistory() }}>{t('files.retry')}</button></p>}
    {busy && <p role="status">{t('files.reading')}</p>}
    <div ref={workingRef} hidden={Boolean(commit)} className="workspace-git__working">
      <div className="workspace-git__current">
      <div className="workspace-git__toolbar">
        <div className="workspace-git__repository-actions">
        <button ref={branchTrigger} className="model-button workspace-git__branch-trigger" type="button" aria-expanded={branchOpen} onClick={() => setBranchOpen(!branchOpen)}><GitBranch size={14} aria-hidden="true" /><span className="model-button__label" title={branches?.current}>{branches?.current || t('management.branch')}</span><ChevronDown size={14} aria-hidden="true" /></button>
        <button className="secondary-button workspace-git__fetch" type="button" title={t('management.fetch')} aria-label={t('management.fetch')} disabled={busy} onClick={() => void run({ kind: 'fetch' })}><Download size={14} aria-hidden="true" /></button>
        </div>
        {viewControl}
      </div>
      {branchOpen && <div className="workspace-git__branches" onKeyDown={(event) => { if (event.key === 'Escape') { setBranchOpen(false); branchTrigger.current?.focus() } }}>
        <label className="field"><span>{t('management.searchBranch')}</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="workspace-git__branch-list">{branches?.branches.filter((branch) => branch.name.toLowerCase().includes(query.toLowerCase())).map((branch) => <button className="workspace-files__changed-row" type="button" key={`${branch.remote}:${branch.name}`} disabled={busy} aria-current={!branch.remote && branches.current === branch.name ? 'true' : undefined} onClick={() => void run({ kind: 'switchBranch', branch: branch.name, remote: branch.remote })}><GitBranch size={14} aria-hidden="true" /><span title={branch.name}>{branch.name}</span><small>{t(branch.remote ? 'management.remote' : 'management.local')}</small></button>)}</div>
        <button className="secondary-button workspace-git__create-branch" type="button" disabled={busy || !query.trim()} onClick={() => void run({ kind: 'createBranch', branch: query })}>{t('management.createBranch')}</button>
      </div>}
      <div className="workspace-git__changes">{children}</div>
      </div>
      <div className="workspace-git__history-dock" style={{ flexBasis: historyOpen ? `${historySize}%` : undefined }}>
        {historyOpen && <div role="separator" tabIndex={0} aria-label={t('management.resizeHistory')} aria-orientation="horizontal" aria-valuemin={10} aria-valuemax={90} aria-valuenow={historySize} onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setHistorySize((current) => event.key === 'Home' ? 10 : event.key === 'End' ? 90 : Math.max(10, Math.min(90, current + (event.key === 'ArrowUp' ? 5 : -5)))) }
        }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.startY = String(event.clientY); event.currentTarget.dataset.startSize = String(historySize) }} onPointerMove={(event) => {
          const availableHeight = workingRef.current?.getBoundingClientRect().height ?? 0
          if (availableHeight > 0 && event.currentTarget.hasPointerCapture(event.pointerId)) setHistorySize(Math.max(10, Math.min(90, Number(event.currentTarget.dataset.startSize) + (Number(event.currentTarget.dataset.startY) - event.clientY) / availableHeight * 100)))
        }} onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)} />}
      <button className="workspace-files__changed-row workspace-git__history-toggle" type="button" aria-expanded={historyOpen} onClick={() => { setHistoryOpen(!historyOpen); if (!historyOpen && !history) void loadHistory() }}>{historyOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}<span>{t('management.history')}</span></button>
      <section hidden={!historyOpen} className="workspace-git__history">
        <div className="workspace-git__history-scroll">
          {history?.commits.map((item) => <button type="button" className="workspace-files__changed-row workspace-git__commit" key={item.oid} disabled={busy} onClick={(event) => { returnTrigger.current = event.currentTarget; void loadCommit(item.oid) }}>
            <strong title={item.subject}>{item.subject}</strong><span title={`${item.author} · ${new Date(item.time).toLocaleString()}`}>{item.author} · {new Date(item.time).toLocaleString()}</span><small title={`${item.oid} ${item.refs}`}>{item.oid.slice(0, 8)} {item.refs}</small>
          </button>)}
          {history?.commits.length === 0 && <p>{t('management.noCommits')}</p>}
          {history?.hasMore && <button className="secondary-button" type="button" disabled={busy} onClick={() => void loadHistory(true)}>{t('management.loadMore')}</button>}
        </div>
      </section>
      </div>
    </div>
    {commit && <section>
      <div hidden={Boolean(path)}>
        <button ref={commitBack} className="assistant-sidebar__back" type="button" onClick={() => { request.current++; setBusy(false); setCommit(undefined); setError(''); requestAnimationFrame(() => returnTrigger.current?.focus({ preventScroll: true })) }}><ChevronLeft size={14} aria-hidden="true" />{t('management.backHistory')}</button>
        <p>{commit.slice(0, 8)}</p>
        {files?.files.map((file) => <button className="workspace-files__changed-row" type="button" key={file.path} onClick={(event) => { fileTrigger.current = event.currentTarget; void loadCommit(commit, file.path) }}><FileText size={14} aria-hidden="true" /><span title={file.path}>{file.path}</span><small>{file.status}</small></button>)}
      </div>
      {path && <div><button ref={diffBack} className="assistant-sidebar__back" type="button" onClick={() => { request.current++; setBusy(false); setPath(undefined); setError(''); requestAnimationFrame(() => fileTrigger.current?.focus({ preventScroll: true })) }}><ChevronLeft size={14} aria-hidden="true" />{t('management.backCommit')}</button><strong>{path}</strong>
        <pre className="assistant-sidebar__diff workspace-files__diff">{patch?.patch.split('\n').map((line, index) => <span key={index} data-line={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'deleted' : undefined}>{line}{'\n'}</span>)}</pre>
        {patch?.truncated && <p>{t('files.diffTruncated')}</p>}
      </div>}
    </section>}
  </div>
}
