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

function statusLabel(status: string): string {
  const value = status.trim()
  if (value === '??') {
    return '新增'
  }
  if (value.includes('D')) {
    return '删除'
  }
  if (value.includes('R')) {
    return '重命名'
  }
  if (value.includes('A')) {
    return '新增'
  }
  return '修改'
}

export function WorkspaceFilesPanel({
  projectId,
  changedFiles,
  onListDirectory,
  onOpenFile,
  onOpenEntry
}: WorkspaceFilesPanelProps): React.JSX.Element {
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
                : '工作区文件读取失败'
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
              ? '打开文件夹失败'
              : '打开文件失败'
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
              aria-label={`在系统资源管理器中打开文件夹 ${entry.name}`}
              className="workspace-files__open-entry"
              onClick={() => openEntry(entry)}
              title="打开文件夹"
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
                <p className="workspace-files__status">正在读取…</p>
              )}
              {listing?.truncated && (
                <p className="workspace-files__status">
                  目录项目超过 500 项，仅显示前 500 项。
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
              {statusLabel(changed.status)}
            </small>
          )}
        </button>
        <button
          aria-label={`使用默认应用打开文件 ${entry.name}`}
          className="workspace-files__open-entry"
          onClick={() => openEntry(entry)}
          title="打开文件"
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
        选择项目后可浏览项目工作区。
      </p>
    )
  }

  const root = listings['']
  return (
    <div className="workspace-files">
      {changedFiles.length > 0 && (
        <div className="workspace-files__changed">
          <strong>未提交更改</strong>
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
                <small>{statusLabel(file.status)}</small>
              </button>
            )
          })}
          {changedFiles.length > 50 && (
            <p className="workspace-files__status">
              仅显示前 50 个未提交更改。
            </p>
          )}
        </div>
      )}
      <strong className="workspace-files__heading">当前工作区</strong>
      {loadingPaths.has('') && !root ? (
        <p className="assistant-sidebar__empty">正在读取工作区…</p>
      ) : error && !root ? (
        <p className="assistant-sidebar__empty">{error}</p>
      ) : root?.entries.length ? (
        <>
          <div className="workspace-files__tree">
            {root.entries.map((entry) => renderEntry(entry))}
          </div>
          {root.truncated && (
            <p className="workspace-files__status">
              根目录项目超过 500 项，仅显示前 500 项。
            </p>
          )}
        </>
      ) : (
        <p className="assistant-sidebar__empty">工作区为空。</p>
      )}
      {error && root && (
        <p className="workspace-files__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
