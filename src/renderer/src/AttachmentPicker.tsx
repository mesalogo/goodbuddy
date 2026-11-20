import { useRef, useState, type RefObject } from 'react'
import { FileText, Folder } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SshDirectoryBrowseResult } from '../../shared/ssh-host-contracts'

export function AttachmentPicker({ fileButtonRef, hostId, onFiles, onDirectories, onError }: {
  fileButtonRef: RefObject<HTMLButtonElement | null>
  hostId?: string
  onFiles: () => void
  onDirectories: (paths: string[]) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const popup = useRef<HTMLDivElement>(null)
  const [listing, setListing] = useState<SshDirectoryBrowseResult>()
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const close = (): void => popup.current?.hidePopover?.()
  const choose = async (path?: string): Promise<void> => {
    const request = ++generation.current
    setBusy(true)
    try {
      if (hostId) {
        const api = window.goodbuddy.sshHosts
        if (!api) throw new Error(t('composer.directoryUnavailable'))
        const result = await api.browseDirectories(hostId, path)
        if (request === generation.current) setListing(result)
      } else {
        close()
        onDirectories(await window.goodbuddy.context.selectDirectories())
      }
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); close() }
    finally { if (request === generation.current) setBusy(false) }
  }
  return <div ref={popup} id="composer-attachment-picker" className="composer-attachment-picker" popover="auto" onToggle={event => {
    if (event.newState === 'closed') { generation.current++; setListing(undefined); setSelected([]); setBusy(false) }
  }}>
    {listing ? <>
      <strong>{listing.path}</strong>
      {listing.parentPath && <button type="button" disabled={busy} onClick={() => void choose(listing.parentPath!)}>..</button>}
      {listing.entries.map(entry => <div className="composer-directory-choice" key={entry.path}>
        <input type="checkbox" aria-label={entry.path} checked={selected.includes(entry.path)} disabled={busy} onChange={event => {
          const checked = event.currentTarget.checked
          setSelected(current => checked ? [...current, entry.path] : current.filter(path => path !== entry.path))
        }} />
        <button disabled={busy} type="button" onClick={() => void choose(entry.path)}><Folder size={14} />{entry.name}</button>
      </div>)}
      <button type="button" disabled={busy} onClick={() => { onDirectories(selected.length ? selected : [listing.path]); close() }}>{t('composer.addDirectory')}{selected.length ? ` (${selected.length})` : ''}</button>
    </> : <>
      <button ref={fileButtonRef} type="button" onClick={() => { close(); onFiles() }}><FileText size={16} />{t('composer.addFile')}</button>
      <button type="button" disabled={busy} onClick={() => void choose()}><Folder size={16} />{t('composer.addDirectory')}</button>
    </>}
  </div>
}
