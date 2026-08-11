import {
  ChevronDown,
  ChevronRight,
  FileSearch,
  FileText,
  Folder,
  FolderOpen
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  WorkspaceChangedFile,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryListing
} from '../../shared/assistant-contracts'

type WorkspaceFilesPanelProps = {
  projectId?: string
  changedFiles: WorkspaceChangedFile[]
  onListDirectory: (path: string) => Promise<WorkspaceDirectoryListing>
  onOpenFile: (path: string) => void
  onOpenEntry: (
    path: string,
    type: WorkspaceDirectoryEntry['type']
  ) => Promise<void>
}

function statusKey(
  status: string
): 'added' | 'deleted' | 'renamed' | 'modified' {
  const value = status.trim()
  if (value === '??') {
    return 'added'
  }
  if (value.includes('D')) {
    return 'deleted'
  }
  if (value.includes('R')) {
    return 'renamed'
  }
  if (value.includes('A')) {
    return 'added'
  }
  return 'modified'
}

export function WorkspaceFilesPanel({
  projectId,
  changedFiles,
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
        inFlightPaths.current.delete(path)
        if (requestGeneration.current === generation) {
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

  useEffect(() => {
    requestGeneration.current += 1
    const generation = requestGeneration.current
    inFlightPaths.current.clear()
    if (!projectId) {
      return
    }
    const timeout = setTimeout(() => {
      void loadDirectory('', generation)
    }, 0)
    return () => clearTimeout(timeout)
  }, [loadDirectory, projectId])

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
    void onOpenEntry(entry.path, entry.type).catch((reason: unknown) => {
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
            <button
              aria-label={t('files.openFolderAriaLabel', {
                name: entry.name
              })}
              className="workspace-files__open-entry"
              onClick={() => openEntry(entry)}
              title={t('files.openFolder')}
              type="button"
            >
              <FolderOpen size={14} />
            </button>
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
            <small className="workspace-files__change">
              {t(`files.statuses.${statusKey(changed.status)}`)}
            </small>
          )}
        </button>
        <button
          aria-label={t('files.openFileAriaLabel', {
            name: entry.name
          })}
          className="workspace-files__open-entry"
          onClick={() => openEntry(entry)}
          title={t('files.openFile')}
          type="button"
        >
          <FileSearch size={14} />
        </button>
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
  return (
    <div className="workspace-files">
      {changedFiles.length > 0 && (
        <div className="workspace-files__changed">
          <strong>{t('files.changedTitle')}</strong>
          {changedFiles.slice(0, 50).map((file) => {
            const deleted = file.status.includes('D')
            return (
              <button
                className="workspace-files__changed-row"
                disabled={deleted}
                key={`${file.status}:${file.path}`}
                onClick={() => onOpenFile(file.path)}
                title={file.path}
                type="button"
              >
                <FileText size={14} />
                <span>{file.path}</span>
                <small>
                  {t(`files.statuses.${statusKey(file.status)}`)}
                </small>
              </button>
            )
          })}
          {changedFiles.length > 50 && (
            <p className="workspace-files__status">
              {t('files.changesTruncated')}
            </p>
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
