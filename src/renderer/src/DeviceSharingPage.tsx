import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SharingCatalog, SharingPublicationDraft, SharingSettings } from '../../shared/device-sharing-contracts'
import { sharingSettingsInputSchema } from '../../shared/device-sharing-contracts'
import { EmptyState, PageHeader, PageShell } from './WorkspacePrimitives'
import type { AppNotificationInput } from './notifications'
import './device-sharing.css'

const emptyDraft: SharingPublicationDraft = {
  name: '', description: '', kind: 'capability', sourceMode: 'device',
  permissions: { search: false, read: false, download: false }
}

export function DeviceSharingPage({ notify }: { notify: (input: AppNotificationInput) => void }): React.JSX.Element {
  const { t } = useTranslation('app')
  const [settings, setSettings] = useState<SharingSettings>()
  const [name, setName] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [catalog, setCatalog] = useState<SharingCatalog>()
  const [draft, setDraft] = useState(emptyDraft)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [revokeId, setRevokeId] = useState<string>()
  const pending = useRef(false)
  useEffect(() => {
    let active = true
    void window.goodbuddy.sharing.getSettings().then(async next => {
      if (!active) return
      setSettings(next); setName(next.name); setServerUrl(next.serverUrl)
      const snapshot = await window.goodbuddy.sharing.getCatalog()
      if (active) { setCatalog(snapshot); setError('') }
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [reload])

  const refresh = async (): Promise<void> => {
    try {
      setCatalog(await window.goodbuddy.sharing.getCatalog())
      setError('')
    } catch (reason) {
      setError(String(reason))
    }
  }
  const run = async (action: () => Promise<unknown>, message?: string): Promise<void> => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try {
      await action()
      if (message) notify({ tone: 'success', message })
    } catch (reason) {
      notify({ tone: 'error', message: String(reason), dedupeKey: 'device-sharing-action' })
    } finally { pending.current = false; setBusy(false) }
  }
  const dirty = settings && (name !== settings.name || serverUrl !== settings.serverUrl)
  const registered = Boolean(settings && catalog?.devices.some(device => device.id === settings.deviceId))
  const canPublish = registered && !dirty && !error && !busy
  const validSettings = sharingSettingsInputSchema.safeParse({ name, serverUrl }).success

  return <PageShell variant="standard">
    <PageHeader headingId="device-sharing-title" title={t('sharing.title')} scope={{ kind: 'global' }} description={t('sharing.boundary')}
      actions={<button className="secondary-button" disabled={busy} onClick={() => {
        if (!settings) { setBusy(true); setReload(value => value + 1) }
        else void run(refresh)
      }}>{t('sharing.refresh')}</button>} />
    <div className="device-sharing" aria-busy={busy}>
      {busy && <p role="status">{t('sharing.working')}</p>}
      {error && <div role="alert" className="settings-warning">{t('sharing.loadFailed')} {error}</div>}
      {settings && <section aria-labelledby="sharing-settings">
        <h2 id="sharing-settings">{t('sharing.thisDevice')}</h2>
        <p>{t('sharing.deviceId')}: <code>{settings.deviceId}</code></p>
        <form onSubmit={event => { event.preventDefault(); void run(async () => {
          const next = await window.goodbuddy.sharing.saveSettings({ name, serverUrl })
          setSettings(next); setName(next.name); setServerUrl(next.serverUrl); setCatalog(undefined)
          await refresh()
        }, t('sharing.saved')) }}>
          <label className="field"><span>{t('sharing.serverUrl')}</span><input type="url" required value={serverUrl} disabled={busy} onChange={event => setServerUrl(event.target.value)} /></label>
          <label className="field"><span>{t('sharing.deviceName')}</span><input required maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <div className="device-sharing__actions">
            <button className="secondary-button" disabled={busy || !dirty || !validSettings}>{t('sharing.save')}</button>
            <button type="button" className="secondary-button" disabled={busy || Boolean(dirty)} onClick={() => void run(async () => {
              await window.goodbuddy.sharing.registerDevice(); await refresh()
            }, t('sharing.registered'))}>{t('sharing.register')}</button>
          </div>
          {dirty && <p>{t('sharing.saveFirst')}</p>}
        </form>
      </section>}
      <section aria-labelledby="sharing-devices">
        <h2 id="sharing-devices">{t('sharing.devices')}</h2>
        {catalog?.devices.length === 0 && <EmptyState title={t('sharing.noDevices')} description={t('sharing.registerFirst')} />}
        {catalog?.devices.map(device => <article key={device.id}>
          <h3>{device.name} {device.id === settings?.deviceId && <small>({t('sharing.thisDevice')})</small>}</h3>
          <p>{device.platform} · {device.appVersion} · <code>{device.id}</code></p>
          <p>{t('sharing.updatedAt')}: {device.updatedAt}</p>
        </article>)}
      </section>
      <section aria-labelledby="sharing-publish">
        <h2 id="sharing-publish">{t('sharing.publishMetadata')}</h2>
        <p>{t('sharing.sourceHelp')}</p>
        {!registered && <p>{t('sharing.registerFirst')}</p>}
        <form onSubmit={event => { event.preventDefault(); if (!canPublish) return; void run(async () => {
          await window.goodbuddy.sharing.publish(draft); setDraft(emptyDraft); await refresh()
        }, t('sharing.publishedNotice')) }}>
          <fieldset disabled={busy}>
            <label className="field"><span>{t('sharing.name')}</span><input required maxLength={200} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
            <label className="field"><span>{t('sharing.description')}</span><textarea maxLength={4000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
            <label className="field"><span>{t('sharing.kind')}</span><select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as SharingPublicationDraft['kind'] })}>
              <option value="capability">{t('sharing.capability')}</option><option value="knowledge">{t('sharing.knowledge')}</option>
            </select></label>
            <label className="field"><span>{t('sharing.sourceMode')}</span><select value={draft.sourceMode} onChange={event => setDraft({ ...draft, sourceMode: event.target.value as SharingPublicationDraft['sourceMode'] })}>
              <option value="device">{t('sharing.device')}</option><option value="server">{t('sharing.server')}</option>
            </select></label>
            {draft.kind === 'knowledge' && <fieldset><legend>{t('sharing.permissions')}</legend>
              {(['search', 'read', 'download'] as const).map(permission => <label key={permission} className="device-sharing__permission"><input type="checkbox" checked={draft.permissions[permission]} onChange={event => setDraft({ ...draft, permissions: { ...draft.permissions, [permission]: event.target.checked } })} />{t(`sharing.${permission}`)}</label>)}
            </fieldset>}
          </fieldset>
          <p>{t('sharing.target')}: {settings?.serverUrl} · {settings?.name}</p>
          <button className="primary-button" disabled={!canPublish || !draft.name.trim()}>{t('sharing.publishMetadata')}</button>
        </form>
      </section>
      <section aria-labelledby="sharing-publications">
        <h2 id="sharing-publications">{t('sharing.publications')}</h2>
        {catalog?.publications.length === 0 && <EmptyState title={t('sharing.noPublications')} description={t('sharing.publishHelp')} />}
        {catalog?.publications.map(item => <article key={item.id}>
          <h3>{item.name} <small>{t(`sharing.${item.status}`)}</small></h3>
          <p>{item.description}</p>
          <p>{t(`sharing.${item.kind}`)} · {t('sharing.sourceMode')}: {t(`sharing.${item.sourceMode}`)}</p>
          <p>{t('sharing.deviceId')}: <code>{item.deviceId}</code> · {t('sharing.updatedAt')}: {item.updatedAt}</p>
          {item.kind === 'knowledge' && <p>{(['search', 'read', 'download'] as const).map(key => `${t(`sharing.${key}`)}: ${t(item.permissions[key] ? 'sharing.yes' : 'sharing.no')}`).join(' · ')}</p>}
          {item.deviceId === settings?.deviceId && item.status === 'published' && (revokeId === item.id ? <div>
            <p>{t('sharing.revokeHelp')}</p><div className="device-sharing__actions">
              <button className="secondary-button" disabled={busy} onClick={() => setRevokeId(undefined)}>{t('sharing.cancel')}</button>
              <button className="danger-solid" disabled={busy || Boolean(dirty) || Boolean(error)} onClick={() => void run(async () => {
                await window.goodbuddy.sharing.revoke(item.id); setRevokeId(undefined); await refresh()
              }, t('sharing.revokedNotice'))}>{t('sharing.confirmRevoke')}</button>
            </div>
          </div> : <button className="danger-ghost" disabled={busy || Boolean(dirty) || Boolean(error)} onClick={() => setRevokeId(item.id)}>{t('sharing.revoke')}</button>)}
        </article>)}
      </section>
    </div>
  </PageShell>
}
