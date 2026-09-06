import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  FileSearch,
  FileText,
  Folder,
  FolderOpen
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryListing
} from '../../shared/assistant-contracts'

type WorkspaceFilesPanelProps = {
  projectId?: string
  changedFiles: WorkspaceChangedFile[]
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

export function WorkspaceFilesPanel({
  projectId,
  changedFiles,
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
    value?: string
  }>({})
  const requestGeneration = useRef(0)
  const inFlightPaths = useRef(new Set<string>())
  const [diff, setDiff] = useState<{ path: string; value?: WorkspaceChanges; error?: string }>()
  const diffRequest = useRef(0)
  const [visibleChangeCount, setVisibleChangeCount] = useState(50)
  const openDiff = (path: string): void => {
    const request = ++diffRequest.current
    setDiff({ path })
    void onLoadDiff(path).then((value) => {
      if (request === diffRequest.current) setDiff({ path, value, error: value.error })
    }).catch((reason: unknown) => {
      if (request === diffRequest.current) setDiff({ path, error: reason instanceof Error ? reason.message : t('files.errors.read') })
    })
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
        setErrorState({ projectId })
      } catch (reason) {
        if (requestGeneration.current === generation) {
          setErrorState({
            projectId,
            value:
              reason instanceof Error
                ? reason.message
                : tRef.current('files.errors.read')
          })
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
    setListingState({ projectId, value: {} })
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
  const error =
    errorState.projectId === projectId ? errorState.value : undefined

  const toggleDirectory = (path: string): void => {
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
    if (expanding && !listings[path]) {
      void loadDirectory(path, requestGeneration.current)
    }
  }

  const openEntry = (entry: WorkspaceDirectoryEntry): void => {
    setErrorState({ projectId })
    void onOpenEntry?.(entry.path, entry.type).catch((reason: unknown) => {
      setErrorState({
        projectId,
        value:
          reason instanceof Error
            ? reason.message
            : entry.type === 'directory'
              ? t('files.errors.openFolder')
              : t('files.errors.openFile')
      })
    })
  }

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
            {onOpenEntry && <button
              aria-label={t('files.openFolderAriaLabel', {
                name: entry.name
              })}
              className="workspace-files__open-entry"
              onClick={() => openEntry(entry)}
              title={t('files.openFolder')}
              type="button"
            >
              <FolderOpen size={14} />
            </button>}
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
          onClick={() => onOpenFile(entry.path)}
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
        {onOpenEntry && <button
          aria-label={t('files.openFileAriaLabel', {
            name: entry.name
          })}
          className="workspace-files__open-entry"
          onClick={() => openEntry(entry)}
          title={t('files.openFile')}
          type="button"
        >
          <FileSearch size={14} />
        </button>}
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

  const root = listings['']
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
  if (diff) {
    return <section className="assistant-sidebar__preview" aria-busy={!diff.value && !diff.error}>
      <header>
        <button className="assistant-sidebar__back" type="button" onClick={() => {
          diffRequest.current += 1
          setDiff(undefined)
        }}><ChevronLeft size={14} />{t('files.currentWorkspace')}</button>
        <strong>{diff.path}</strong>
      </header>
      {diff.error ? <p role="alert">{diff.error}<button type="button" onClick={() => openDiff(diff.path)}>{t('files.retry')}</button></p>
        : !diff.value ? <p>{t('files.reading')}</p> : <>
          {diff.value.stagedPatch && <><h4>{t('files.staged')}</h4>{renderPatch(diff.value.stagedPatch)}</>}
          {diff.value.patch && <><h4>{t('files.unstaged')}</h4>{renderPatch(diff.value.patch)}</>}
          {!diff.value.patch && !diff.value.stagedPatch && <p>{t('files.noDiff')}</p>}
          {diff.value.truncated && <p>{t('files.diffTruncated')}</p>}
        </>}
    </section>
  }
  return (
    <div className="workspace-files">
      {changedFiles.length > 0 && (
        <div className="workspace-files__changed">
          <strong>{t('files.changedTitle')}</strong>
          {changedFiles.slice(0, visibleChangeCount).map((file) => {
            return (
              <button
                className="workspace-files__changed-row"
                key={`${file.status}:${file.path}`}
                onClick={() => openDiff(file.path)}
                title={`${file.previousPath ? `${file.previousPath} -> ` : ''}${file.path} (${file.status})`}
                type="button"
              >
                <FileText size={14} />
                <span>{file.path}</span>
                <small data-status={gitStatusLetter(file.status)} data-conflict={['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.status)} aria-label={file.status}>
                  {gitStatusLetter(file.status)}
                </small>
              </button>
            )
          })}
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
      )}
      <strong className="workspace-files__heading">
        {t('files.currentWorkspace')}
      </strong>
      {loadingPaths.has('') && !root ? (
        <p className="assistant-sidebar__empty">
          {t('files.readingWorkspace')}
        </p>
      ) : error && !root ? (
        <p className="assistant-sidebar__empty">{error}</p>
      ) : root?.entries.length ? (
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
      {error && root && (
        <p className="workspace-files__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
