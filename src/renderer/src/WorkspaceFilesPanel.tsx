import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  MoreHorizontal,
  RefreshCw,
  FilePlus,
  FolderPlus,
  Copy,
  Edit3,
  ExternalLink,
  FolderInput,
  Info,
  Trash2,
  FileText,
  Folder,
  FolderRoot,
  FolderOpen
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { SegmentedControl } from './WorkspacePrimitives'
import { WorkspaceActionDialog } from './WorkspaceActionDialog'
import { WorkspaceGitTools } from './WorkspaceGitTools'
import type {
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryListing
} from '../../shared/assistant-contracts'

type WorkspaceFilesPanelProps = {
  projectId?: string
  rootPath?: string
  onRefresh?: () => Promise<void>
  changedFiles: WorkspaceChangedFile[]
  gitError?: string
  isRepository?: boolean
  refreshToken?: unknown
  onLoadDiff: (path: string) => Promise<WorkspaceChanges>
  onListDirectory: (path: string) => Promise<WorkspaceDirectoryListing>
  onOpenFile: (path: string) => void
  onOpenEntry?: (
    path: string,
    type: WorkspaceDirectoryEntry['type']
  ) => Promise<void>
}

export function gitStatusLetter(status: string): string {
  if (status === '??') return 'U'
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status)) return 'U'
  return status.trim().replaceAll('.', '').split('').filter((value, index, values) => values.indexOf(value) === index).join('')
}

function changedTree(entries: { path: string; row: React.JSX.Element }[], prefix = ''): React.JSX.Element {
  const groups = new Map<string, typeof entries>()
  const files = entries.filter((entry) => !entry.path.slice(prefix.length).includes('/'))
  for (const entry of entries) {
    const rest = entry.path.slice(prefix.length)
    if (!rest.includes('/')) continue
    const directory = rest.split('/')[0]!
    groups.set(directory, [...(groups.get(directory) ?? []), entry])
  }
  return <>{[...groups].map(([name, children]) => <details key={name} open><summary>{name}</summary><div className="workspace-files__children">{changedTree(children, `${prefix}${name}/`)}</div></details>)}{files.map((entry) => entry.row)}</>
}

export function WorkspaceFilesPanel({
  projectId,
  rootPath,
  onRefresh,
  changedFiles,
  gitError,
  isRepository,
  refreshToken,
  onLoadDiff,
  onListDirectory,
  onOpenFile,
  onOpenEntry
}: WorkspaceFilesPanelProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const [listingState, setListingState] = useState<{
    projectId?: string
    value: Record<string, WorkspaceDirectoryListing>
  }>({ value: {} })
  const [expandedState, setExpandedState] = useState<{
    projectId?: string
    value: Set<string>
  }>({ value: new Set() })
  const [loadingState, setLoadingState] = useState<{
    projectId?: string
    value: Set<string>
  }>({ value: new Set() })
  const [errorState, setErrorState] = useState<{
    projectId?: string
    value: Record<string, string | undefined>
  }>({ value: {} })
  const [actionError, setActionError] = useState('')
  const [menu, setMenu] = useState<{ entry: WorkspaceDirectoryEntry; trigger: HTMLButtonElement }>()
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = (restoreFocus = false): void => {
    if (restoreFocus) menu?.trigger.focus({ preventScroll: true })
    setMenu(undefined)
  }
  useLayoutEffect(() => {
    const surface = menuRef.current
    if (!menu || !surface) return
    const position = (): void => {
      const anchor = menu.trigger.getBoundingClientRect()
      const bounds = surface.getBoundingClientRect()
      surface.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`
      surface.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 8))}px`
    }
    position()
    surface.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const dismiss = (event: Event): void => {
      if (event.target instanceof Node && !surface.contains(event.target) && !menu.trigger.contains(event.target)) setMenu(undefined)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [menu])
  const [view, setView] = useState<'files' | 'changes'>('files')
  const [browsedPath, setBrowsedPath] = useState('')
  const [createTarget, setCreateTarget] = useState('')
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'move' | 'delete' | 'properties' | 'createFile' | 'createDirectory'; path: string }>()
  const [changeView, setChangeView] = useState<'list' | 'tree'>('list')
  const [refreshing, setRefreshing] = useState(false)
  const repositoryKnown = useRef<{ projectId?: string; available: boolean }>({ available: false })
  useEffect(() => { if (!gitError && isRepository !== undefined) repositoryKnown.current = { projectId, available: isRepository } }, [gitError, isRepository, projectId])
  const showGit = isRepository === true || (Boolean(gitError) && repositoryKnown.current.projectId === projectId && repositoryKnown.current.available)
  const activeView = showGit ? view : 'files'
  const [selected, setSelected] = useState<{ projectId?: string; path: string }>()
  const panelRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const returnContext = useRef<{ scrollTop: number; scrollLeft: number; trigger: HTMLButtonElement } | undefined>(undefined)
  const requestGeneration = useRef(0)
  const inFlightPaths = useRef(new Set<string>())
  const [diffState, setDiff] = useState<{ projectId?: string; path: string; value?: WorkspaceChanges; error?: string }>()
  const diff = diffState?.projectId === projectId ? diffState : undefined
  const diffRequest = useRef(0)
  const [visibleChangeCount, setVisibleChangeCount] = useState(50)
  const openDiff = (path: string): void => {
    const request = ++diffRequest.current
    setDiff({ projectId, path })
    void onLoadDiff(path).then((value) => {
      if (request === diffRequest.current) setDiff({ projectId, path, value, error: value.error })
    }).catch((reason: unknown) => {
      if (request === diffRequest.current) setDiff({ projectId, path, error: reason instanceof Error ? reason.message : t('files.errors.read') })
    })
  }
  const showingDiff = Boolean(diff)
  useLayoutEffect(() => {
    const scroller = panelRef.current?.closest<HTMLElement>('.assistant-sidebar__body')
    if (showingDiff) {
      if (scroller) {
        scroller.scrollTop = 0
        scroller.scrollLeft = 0
      }
      backRef.current?.focus({ preventScroll: true })
    } else if (returnContext.current) {
      const context = returnContext.current
      if (context.trigger.isConnected) {
        context.trigger.focus({ preventScroll: true })
        if (scroller) {
          scroller.scrollTop = context.scrollTop
          scroller.scrollLeft = context.scrollLeft
        }
      }
      returnContext.current = undefined
    }
  }, [showingDiff])

  const copyPath = async (path: string): Promise<void> => {
    setActionError('')
    try {
      await window.goodbuddy.clipboard.writeText(path)
    } catch (reason) {
      setActionError(reason instanceof Error ? `${t('sidebar.workspace.copyError')} ${reason.message}` : t('sidebar.workspace.copyError'))
    }
  }

  const loadDirectory = useCallback(
    async (path: string, generation: number): Promise<void> => {
      if (!projectId || inFlightPaths.current.has(path)) {
        return
      }
      inFlightPaths.current.add(path)
      setLoadingState((current) => {
        const next = new Set(
          current.projectId === projectId ? current.value : []
        )
        next.add(path)
        return { projectId, value: next }
      })
      try {
        const listing = await onListDirectory(path)
        if (requestGeneration.current !== generation) {
          return
        }
        setListingState((current) => ({
          projectId,
          value: {
            ...(current.projectId === projectId ? current.value : {}),
            [path]: listing
          }
        }))
        setErrorState((current) => ({ projectId, value: {
          ...(current.projectId === projectId ? current.value : {}), [path]: undefined
        } }))
      } catch (reason) {
        if (requestGeneration.current === generation) {
          setErrorState((current) => ({
            projectId,
            value: { ...(current.projectId === projectId ? current.value : {}), [path]:
              reason instanceof Error
                ? reason.message
                : tRef.current('files.errors.read') }
          }))
        }
      } finally {
        if (requestGeneration.current === generation) {
          inFlightPaths.current.delete(path)
          setLoadingState((current) => {
            const next = new Set(
              current.projectId === projectId ? current.value : []
            )
            next.delete(path)
            return { projectId, value: next }
          })
        }
      }
    },
    [onListDirectory, projectId]
  )

  const refreshDirectories = useEffectEvent((generation: number) => {
    const paths = expandedState.projectId === projectId ? [...expandedState.value] : []
    setLoadingState({ projectId, value: new Set() })
    void loadDirectory('', generation)
    for (const path of paths) void loadDirectory(path, generation)
    if (diff) openDiff(diff.path)
  })
  useEffect(() => {
    requestGeneration.current += 1
    const generation = requestGeneration.current
    inFlightPaths.current.clear()
    if (!projectId) {
      return
    }
    const timeout = setTimeout(() => {
      refreshDirectories(generation)
    }, 0)
    return () => {
      clearTimeout(timeout)
      requestGeneration.current += 1
      diffRequest.current += 1
    }
  }, [loadDirectory, projectId, refreshToken])

  const changedByPath = useMemo(
    () =>
      new Map(
        changedFiles.map((file) => [
          file.path.replaceAll('\\', '/'),
          file
        ])
      ),
    [changedFiles]
  )
  const emptyPaths = useMemo(() => new Set<string>(), [])
  const listings =
    listingState.projectId === projectId ? listingState.value : {}
  const expandedPaths =
    expandedState.projectId === projectId
      ? expandedState.value
      : emptyPaths
  const loadingPaths =
    loadingState.projectId === projectId
      ? loadingState.value
      : emptyPaths
  const errors = errorState.projectId === projectId ? errorState.value : {}
  const renderDirectoryError = (path: string): React.JSX.Element | null => errors[path] ? (
    <p className="workspace-files__error" role="alert">
      {errors[path]}
      <button type="button" disabled={loadingPaths.has(path)} onClick={() => void loadDirectory(path, requestGeneration.current)}>
        {t('files.retry')}
      </button>
    </p>
  ) : null

  const toggleDirectory = (path: string): void => {
    setCreateTarget(path)
    const expanding = !expandedPaths.has(path)
    setExpandedState((current) => {
      const next = new Set(
        current.projectId === projectId ? current.value : []
      )
      if (expanding) {
        next.add(path)
      } else {
        next.delete(path)
      }
      return { projectId, value: next }
    })
    if (expanding) {
      void loadDirectory(path, requestGeneration.current)
    }
  }

  const openEntry = (entry: WorkspaceDirectoryEntry): void => {
    setActionError('')
    void onOpenEntry?.(entry.path, entry.type).catch((reason: unknown) => {
      setActionError(
          reason instanceof Error
            ? reason.message
            : entry.type === 'directory'
              ? t('files.errors.openFolder')
              : t('files.errors.openFile')
      )
    })
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await onRefresh?.()
      await loadDirectory('', requestGeneration.current)
      if (browsedPath) await loadDirectory(browsedPath, requestGeneration.current)
      for (const path of expandedPaths) await loadDirectory(path, requestGeneration.current)
    } catch (reason) { setActionError(String(reason)) }
    finally { setRefreshing(false) }
  }
  const browse = (path: string): void => {
    setBrowsedPath(path); setCreateTarget(path)
    void loadDirectory(path, requestGeneration.current)
  }
  const entryMenu = (entry: WorkspaceDirectoryEntry): React.JSX.Element => (
    <button className="icon-button workspace-files__more" type="button"
      aria-label={t('management.more', { name: entry.name })}
      title={t('management.more', { name: entry.name })}
      aria-haspopup="menu" aria-expanded={menu?.entry.path === entry.path}
      onClick={(event) => setMenu(menu?.entry.path === entry.path ? undefined : { entry, trigger: event.currentTarget })}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setMenu({ entry, trigger: event.currentTarget })
        }
      }}><MoreHorizontal size={14} aria-hidden="true" /></button>
  )

  const renderEntry = (
    entry: WorkspaceDirectoryEntry
  ): React.JSX.Element => {
    const expanded = expandedPaths.has(entry.path)
    const listing = listings[entry.path]
    const changed = changedByPath.get(entry.path)
    if (entry.type === 'directory') {
      return (
        <div key={entry.path}>
          <div className="workspace-files__entry">
            <button
              aria-expanded={expanded}
              className="workspace-files__row"
              onClick={() => toggleDirectory(entry.path)}
              type="button"
            >
              {expanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
              {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span title={entry.path}>{entry.name}</span>
            </button>
            {entryMenu(entry)}
          </div>
          {expanded && (
            <div className="workspace-files__children">
              {listing?.entries.map((child) =>
                renderEntry(child)
              )}
              {loadingPaths.has(entry.path) && (
                <p className="workspace-files__status">
                  {t('files.reading')}
                </p>
              )}
              {renderDirectoryError(entry.path)}
              {listing?.truncated && (
                <p className="workspace-files__status">
                  {t('files.directoryTruncated')}
                </p>
              )}
            </div>
          )}
        </div>
      )
    }
    return (
      <div className="workspace-files__entry" key={entry.path}>
        <button
          className="workspace-files__row"
          aria-current={selected?.projectId === projectId && selected?.path === entry.path ? 'true' : undefined}
          onClick={() => {
            setSelected({ projectId, path: entry.path })
            setCreateTarget(entry.path.split('/').slice(0, -1).join('/'))
            onOpenFile(entry.path)
          }}
          title={entry.path}
          type="button"
        >
          <span className="workspace-files__indent" />
          <FileText size={15} />
          <span>{entry.name}</span>
          {changed && (
            <small className="workspace-files__change" data-status={gitStatusLetter(changed.status)} title={changed.status}>
              {gitStatusLetter(changed.status)}
            </small>
          )}
        </button>
        {entryMenu(entry)}
      </div>
    )
  }

  if (!projectId) {
    return (
      <p className="assistant-sidebar__empty">
        {t('files.selectProject')}
      </p>
    )
  }

  const root = listings[browsedPath]
  const renderPatch = (patch: string): React.JSX.Element => (
    <pre className="assistant-sidebar__diff workspace-files__diff">
      {patch.split('\n').map((line, index) => (
        <span key={index} data-line={
          line.startsWith('+++') || line.startsWith('---') ? 'header'
            : line.startsWith('+') ? 'added'
              : line.startsWith('-') ? 'deleted'
                : line.startsWith('@@') ? 'hunk' : undefined
        }>{line}{'\n'}</span>
      ))}
    </pre>
  )
  return (
    <div ref={panelRef} className="workspace-files">
    {diff && <section className="assistant-sidebar__preview" aria-busy={!diff.value && !diff.error}>
      <header>
        <button ref={backRef} className="assistant-sidebar__back" type="button" onClick={() => {
          diffRequest.current += 1
          setDiff(undefined)
          setActionError('')
        }}><ChevronLeft size={14} />{t('files.backToChanges')}</button>
        <strong>{diff.path}</strong>
      </header>
      <div className="workspace-files__toolbar">
        {!changedByPath.get(diff.path)?.status.includes('D') && <button type="button" className="secondary-button" onClick={() => onOpenFile(diff.path)}>{t('files.viewCurrentFile')}</button>}
        <button type="button" className="secondary-button" disabled={!diff.value && !diff.error} onClick={() => openDiff(diff.path)}>{t(!diff.value && !diff.error ? 'sidebar.workspace.refreshing' : 'sidebar.workspace.refresh')}</button>
        <button type="button" className="secondary-button" onClick={() => void copyPath(diff.path)}>{t('sidebar.workspace.copyPath')}</button>
      </div>
      {diff.error ? <p role="alert">{diff.error}<button type="button" onClick={() => openDiff(diff.path)}>{t('files.retry')}</button></p>
        : !diff.value ? <p>{t('files.reading')}</p> : <>
          {diff.value.stagedPatch && <><h4>{t('files.staged')}</h4>{renderPatch(diff.value.stagedPatch)}</>}
          {diff.value.patch && <><h4>{t('files.unstaged')}</h4>{renderPatch(diff.value.patch)}</>}
          {!diff.value.patch && !diff.value.stagedPatch && <p>{t('files.noDiff')}</p>}
          {diff.value.truncated && <p>{t('files.diffTruncated')}</p>}
        </>}
    </section>}
    <div className="workspace-files__list" hidden={showingDiff}>
      <nav className="workspace-files__breadcrumbs" aria-label={t('management.path')}>
        {browsedPath && <button className="icon-button" type="button" aria-label={t('management.parent')} title={t('management.parent')} onClick={() => browse(browsedPath.split('/').slice(0, -1).join('/'))}><ChevronLeft size={14} /></button>}
        <div className="workspace-files__breadcrumb-parts">
        <button className="icon-button" type="button" onClick={() => browse('')} aria-label={rootPath || t('files.currentWorkspace')} title={rootPath || t('files.currentWorkspace')} aria-current={!browsedPath ? 'location' : undefined}><FolderRoot size={14} aria-hidden="true" /></button>
        {browsedPath.split('/').filter(Boolean).map((part, index, parts) => <button type="button" key={index} title={parts.slice(0, index + 1).join('/')} aria-current={index === parts.length - 1 ? 'location' : undefined} onClick={() => browse(parts.slice(0, index + 1).join('/'))}>{part}</button>)}
        </div>
      </nav>
      {root && <div className="workspace-files__toolbar workspace-files__actions">
        <button className="icon-button" type="button" disabled={refreshing} aria-label={t('sidebar.workspace.refreshAriaLabel')} title={t('sidebar.workspace.refresh')} onClick={() => void refresh()}><RefreshCw size={14} /></button>
        <button className="icon-button" type="button" aria-label={t('management.createFile')} title={`${t('management.createFile')}: ${createTarget || '/'}`} onClick={() => setDialog({ kind: 'createFile', path: createTarget })}><FilePlus size={14} /></button>
        <button className="icon-button" type="button" aria-label={t('management.createDirectory')} title={`${t('management.createDirectory')}: ${createTarget || '/'}`} onClick={() => setDialog({ kind: 'createDirectory', path: createTarget })}><FolderPlus size={14} /></button>
      </div>}
      {showGit && <div className="workspace-files__view-switch"><SegmentedControl ariaLabel={t('files.view')} value={activeView} onChange={setView} options={[
        { value: 'files', label: t('files.filesView') },
        { value: 'changes', label: t('management.gitWorkspace') }
      ]} /></div>}
        <div hidden={activeView !== 'changes'}>
        {showGit && <WorkspaceGitTools projectId={projectId} refreshToken={refreshToken} onRefresh={refresh} viewControl={
          <SegmentedControl ariaLabel={t('management.changedView')} value={changeView} onChange={setChangeView} options={[{ value: 'list', label: t('management.list') }, { value: 'tree', label: t('management.tree') }]} />
        }>
        {gitError ? <p className="workspace-files__status" role="status">{t('sidebar.workspace.gitUnavailable', { error: gitError })}</p>
          : isRepository === false ? <p className="assistant-sidebar__empty">{t('files.notRepository')}</p>
            : changedFiles.length === 0 ? <p className="assistant-sidebar__empty">{t('files.noChanges')}</p> : null}
         <div className="workspace-files__changed" data-view={changeView}>
          {((entries: { path: string; row: React.JSX.Element }[]) => changeView === 'tree' ? changedTree(entries) : entries.map((entry) => entry.row))(changedFiles.slice(0, visibleChangeCount).map((file) => {
            return { path: file.path, row: (
              <button
                className="workspace-files__changed-row"
                key={file.path}
                aria-current={selected?.projectId === projectId && selected?.path === file.path ? 'true' : undefined}
                onClick={(event) => {
                  const scroller = panelRef.current?.closest<HTMLElement>('.assistant-sidebar__body')
                  returnContext.current = { scrollTop: scroller?.scrollTop ?? 0, scrollLeft: scroller?.scrollLeft ?? 0, trigger: event.currentTarget }
                  setSelected({ projectId, path: file.path })
                  setActionError('')
                  openDiff(file.path)
                }}
                title={`${file.previousPath ? `${file.previousPath} -> ` : ''}${file.path} (${file.status})`}
                type="button"
              >
                <FileText size={14} />
                <span>{changeView === 'tree' ? file.path.split('/').at(-1) : file.path}</span>
                <small data-status={gitStatusLetter(file.status)} data-conflict={['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.status)} aria-label={file.status}>
                  {gitStatusLetter(file.status)}
                </small>
              </button>
            ) }
          }))}
          {changedFiles.length > visibleChangeCount && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => setVisibleChangeCount((count) => count + 50)}
            >
              {t('files.loadMoreChanges', {
                count: changedFiles.length - visibleChangeCount
              })}
            </button>
          )}
        </div>
        </WorkspaceGitTools>}
        </div>
      <div hidden={activeView !== 'files'}>
      {loadingPaths.has(browsedPath) && !root ? (
        <p className="assistant-sidebar__empty">
          {t('files.readingWorkspace')}
        </p>
      ) : errors[browsedPath] && !root ? null : root?.entries.length ? (
        <>
          <div className="workspace-files__tree">
            {root.entries.map((entry) => renderEntry(entry))}
          </div>
          {root.truncated && (
            <p className="workspace-files__status">
              {t('files.rootTruncated')}
            </p>
          )}
        </>
      ) : (
        <p className="assistant-sidebar__empty">
          {t('files.empty')}
        </p>
      )}
      {renderDirectoryError(browsedPath)}
      </div>
    </div>
    {actionError && <p className="workspace-files__error" role="alert">{actionError}</p>}
    {menu && createPortal(<div ref={menuRef} className="workspace-files__menu" role="menu" aria-label={menu.entry.name} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return }
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : undefined
      if (next !== undefined) { event.preventDefault(); items[next]?.focus() }
    }}>
      {menu.entry.type === 'directory' && <button role="menuitem" type="button" onClick={() => { closeMenu(true); browse(menu.entry.path) }}><FolderOpen size={14} />{t('management.browse')}</button>}
      {(['rename', 'move', 'properties'] as const).map((kind) => {
        const Icon = { rename: Edit3, move: FolderInput, properties: Info }[kind]
        return <button key={kind} role="menuitem" type="button" onClick={() => { closeMenu(true); setDialog({ kind, path: menu.entry.path }) }}><Icon size={14} />{t(`management.${kind}`)}</button>
      })}
      <button role="menuitem" type="button" onClick={() => { closeMenu(true); void copyPath(menu.entry.path) }}><Copy size={14} />{t('sidebar.workspace.copyPath')}</button>
      {onOpenEntry && <button role="menuitem" type="button" onClick={() => { closeMenu(true); openEntry(menu.entry) }}><ExternalLink size={14} />{t('management.defaultOpen')}</button>}
      <div role="separator" />
      <button role="menuitem" type="button" className="danger-ghost" onClick={() => { closeMenu(true); setDialog({ kind: 'delete', path: menu.entry.path }) }}><Trash2 size={14} />{t('management.delete')}</button>
    </div>, document.body)}
    {dialog && <WorkspaceActionDialog key={projectId} projectId={projectId} rootPath={rootPath} {...dialog} onClose={() => setDialog(undefined)} onComplete={() => { setSelected(undefined); setCreateTarget(browsedPath); void refresh() }} />}
    </div>
  )
}
