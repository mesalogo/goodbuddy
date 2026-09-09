import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import type { WorkspaceManagementAction, WorkspaceManagementResult } from '../../shared/workspace-management-contracts'
import type { SshDirectoryBrowseResult } from '../../shared/ssh-host-contracts'

export function WorkspaceActionDialog({ projectId, rootPath, kind, path, onClose, onComplete }: {
  projectId: string
  rootPath?: string
  kind: 'rename' | 'move' | 'delete' | 'properties' | 'createFile' | 'createDirectory'
  path: string
  onClose: () => void
  onComplete: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const [value, setValue] = useState(kind === 'rename' ? path.split('/').at(-1)! : '')
  const [destinationDirectory, setDestinationDirectory] = useState('')
  const [remotePicker, setRemotePicker] = useState<{ hostId: string; root: string; listing?: SshDirectoryBrowseResult }>()
  const browseRequest = useRef(0)
  const remoteBrowsing = useRef(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [properties, setProperties] = useState<Extract<WorkspaceManagementResult, { kind: 'properties' }>>()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => activateModalFocus(() => cancel.current), [])
  useEffect(() => () => {
    browseRequest.current++
    if (remoteBrowsing.current) void window.goodbuddy.sshHosts?.cancelDirectoryBrowse().catch(() => undefined)
  }, [])
  useEffect(() => {
    if (kind !== 'properties') return
    let active = true
    void window.goodbuddy.workspace.manage(projectId, { kind, path }).then((result) => {
      if (active && result.kind === 'properties') setProperties(result)
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [kind, path, projectId])
  const selectDestination = (directory: string, root: string, remote: boolean): void => {
    const windows = !remote && /^(?:[a-z]:[\\/]|\\\\)/i.test(root)
    const normalize = (input: string): string => {
      const parts: string[] = []
      for (const part of (windows ? input.replaceAll('\\', '/') : input).split('/')) {
        if (part === '..') parts.pop()
        else if (part && part !== '.') parts.push(part)
      }
      return `/${parts.join('/')}`
    }
    const base = normalize(root)
    const selected = normalize(directory)
    const compare = (input: string): string => windows ? input.toLowerCase() : input
    const prefix = base === '/' ? '/' : `${base}/`
    if (compare(selected) !== compare(base) && !compare(selected).startsWith(compare(prefix))) {
      setValue('')
      setDestinationDirectory(directory)
      setError(t('management.destinationOutside', { root }))
      return
    }
    const relative = compare(selected) === compare(base) ? '' : selected.slice(prefix.length)
    setValue([relative, path.split('/').at(-1)!].filter(Boolean).join('/'))
    setDestinationDirectory(directory)
    setError('')
    setRemotePicker(undefined)
    remoteBrowsing.current = false
  }
  const browseRemote = async (hostId: string, root: string, directory: string): Promise<void> => {
    const generation = ++browseRequest.current
    setBusy(true); setError(''); remoteBrowsing.current = true
    try {
      const api = window.goodbuddy.sshHosts
      if (!api) throw new Error(t('management.destinationUnavailable'))
      const listing = await api.browseDirectories(hostId, directory)
      if (generation === browseRequest.current) setRemotePicker({ hostId, root, listing })
    } catch (reason) { if (generation === browseRequest.current) setError(String(reason)) }
    finally { if (generation === browseRequest.current) setBusy(false) }
  }
  const chooseDirectory = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const project = (await window.goodbuddy.projects.list()).find((item) => item.id === projectId)
      if (!project) throw new Error(t('management.destinationUnavailable'))
      const space = project.executionSpace
      if (space?.kind === 'ssh') {
        const root = rootPath || space.remoteRootPath
        setRemotePicker({ hostId: space.hostId, root })
        await browseRemote(space.hostId, root, root)
      } else {
        const root = rootPath || space?.rootPath || project.rootPath
        if (!root) throw new Error(t('management.destinationUnavailable'))
        const directory = await window.goodbuddy.settings.selectWorkspace()
        if (directory) selectDestination(directory, root, false)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const submit = async (): Promise<void> => {
    setError('')
    if (busy) return
    setBusy(true)
    try {
      const parent = path.split('/').slice(0, -1).join('/')
      const destination = kind === 'rename' ? [parent, value].filter(Boolean).join('/') : value
      if (kind === 'rename' && /[\\/]/.test(value)) throw new Error(t('management.nameOnly'))
      const action: WorkspaceManagementAction = kind === 'rename' || kind === 'move' ? { kind: 'move', path, destination }
        : kind === 'createFile' || kind === 'createDirectory' ? { kind, path: [path, value].filter(Boolean).join('/') }
          : { kind, path }
      await window.goodbuddy.workspace.manage(projectId, action)
      onComplete()
      onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return createPortal(<div className="custom-task-dialog"><section className="custom-task-dialog__surface" role="dialog" aria-modal="true" aria-labelledby="workspace-action-title" onKeyDown={(event) => {
    trapTabFocus(event, event.currentTarget)
    if (event.key === 'Escape' && (!busy || remotePicker)) onClose()
  }}>
    <div className="custom-task-dialog__content">
    <h3 id="workspace-action-title">{t(`management.${kind}`)}</h3>
    <p className="workspace-files__path">{path || '/'}</p>
    {kind === 'delete' ? <p>{t('management.deleteWarning')}</p> : kind === 'properties' ? properties && <dl>
      <dt>{t('management.path')}</dt><dd>{properties.path}</dd>
      <dt>{t('management.type')}</dt><dd>{properties.type}</dd>
      <dt>{t('management.size')}</dt><dd>{properties.size.toLocaleString()} B</dd>
      <dt>{t('management.modified')}</dt><dd>{new Date(properties.modifiedAt).toLocaleString()}</dd>
    </dl> : kind === 'move' ? <div className="custom-task-dialog__field">
      <span id="workspace-destination-label">{t('management.destination')}</span>
      <button className="secondary-button" type="button" disabled={busy} aria-labelledby="workspace-destination-label workspace-destination-value" aria-describedby={error ? 'workspace-action-error' : 'workspace-destination-help'} onClick={() => void chooseDirectory()}>
        <FolderOpen size={14} aria-hidden="true" /><span id="workspace-destination-value" className="workspace-files__path">{destinationDirectory || t('management.chooseDirectory')}</span>
      </button>
      <small id="workspace-destination-help">{t('management.moveHelp')}</small>
      {remotePicker && <div className="workspace-files__directory-picker">
        <div className="remote-directory-picker__location"><code>{remotePicker.listing?.path || remotePicker.root}</code></div>
        <div className="remote-directory-picker__toolbar">
          <button className="icon-button" type="button" title={t('management.parent')} aria-label={t('management.parent')} disabled={busy || !remotePicker.listing?.parentPath || remotePicker.listing.path === remotePicker.root} onClick={() => void browseRemote(remotePicker.hostId, remotePicker.root, remotePicker.listing!.parentPath!)}><ArrowUp size={14} /></button>
          <button className="icon-button" type="button" title={t('sidebar.workspace.refresh')} aria-label={t('sidebar.workspace.refresh')} disabled={busy} onClick={() => void browseRemote(remotePicker.hostId, remotePicker.root, remotePicker.listing?.path || remotePicker.root)}><RefreshCw size={14} /></button>
        </div>
        <div className="remote-directory-picker__content" aria-busy={busy}>
          {busy ? <p role="status">{t('files.reading')}</p> : remotePicker.listing?.entries.length === 0 ? <p>{t('projectSwitcher.remote.directoryPicker.empty')}</p> : <ul>{remotePicker.listing?.entries.map((entry) => <li key={entry.path}><button type="button" onClick={() => void browseRemote(remotePicker.hostId, remotePicker.root, entry.path)}><Folder size={16} aria-hidden="true" /><span>{entry.name}</span></button></li>)}</ul>}
        </div>
        {remotePicker.listing?.truncated && <small>{t('files.directoryTruncated')}</small>}
        <button className="secondary-button" type="button" disabled={busy || !remotePicker.listing} onClick={() => selectDestination(remotePicker.listing!.path, remotePicker.root, true)}>{t('projectSwitcher.remote.directoryPicker.select')}</button>
      </div>}
    </div> : <label className="custom-task-dialog__field">{t('management.name')}<input value={value} onChange={(event) => setValue(event.target.value)} aria-describedby={error ? 'workspace-action-error' : undefined} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} /></label>}
    {error && <p id="workspace-action-error" role="alert">{error}</p>}
    <div className="custom-task-dialog__actions">
      <button ref={cancel} className="secondary-button" type="button" disabled={busy && !remotePicker} onClick={onClose}>{t('management.cancel')}</button>
      {kind !== 'properties' && <button className={kind === 'delete' ? 'danger-solid' : 'primary-button'} type="button" disabled={busy || Boolean(remotePicker) || (kind !== 'delete' && !value.trim())} onClick={() => void submit()}>{t(`management.${kind}`)}</button>}
    </div>
    </div>
  </section></div>, document.body)
}
