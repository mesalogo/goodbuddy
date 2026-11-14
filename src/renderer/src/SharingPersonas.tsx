import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { PersonaDraft, SharedPersona } from '../../shared/sharing-personas'
import type { AppNotificationInput } from './notifications'
import { createSharingPersonasStore } from './sharing-personas-store'
import './device-sharing.css'

const empty = (): PersonaDraft => ({ name: '', description: '', instructions: '', modelId: '', sourceIds: [], memberIds: [], groupIds: [], status: 'draft' })
export function SharingPersonas({ serverUrl, deviceId, notify }: { serverUrl: string; deviceId: string; notify: (input: AppNotificationInput) => void }): React.JSX.Element {
  const { t } = useTranslation('app')
  const [store] = useState(() => createSharingPersonasStore(window.goodbuddy.sharing))
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const [draft, setDraft] = useState<PersonaDraft>()
  const [selected, setSelected] = useState<SharedPersona>()
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [withdraw, setWithdraw] = useState<string>()
  const [query, setQuery] = useState('')
  useEffect(() => { void store.load().catch(() => undefined); return () => store.dispose() }, [store])
  const run = async (action: () => Promise<void>, success?: string): Promise<void> => {
    if (saving) return
    setSaving(true)
    try { await action(); if (success) notify({ tone: 'success', message: success }) }
    catch (error) { notify({ tone: 'error', message: String(error), dedupeKey: 'sharing-personas' }) }
    finally { setSaving(false) }
  }
  const edit = (item: SharedPersona): void => setDraft({ id: item.id, revision: item.revision, name: item.name, description: item.description, instructions: item.instructions ?? '', modelId: item.modelId, sourceIds: item.sourceIds, memberIds: item.memberIds ?? [], groupIds: item.groupIds ?? [], status: item.status === 'revoked' ? 'draft' : item.status })
  const selection = (label: string, field: 'sourceIds' | 'memberIds' | 'groupIds', items: { id: string; name: string }[]): React.JSX.Element => <label className="field"><span>{label}</span><select multiple value={draft?.[field] ?? []} onChange={event => draft && setDraft({ ...draft, [field]: Array.from(event.target.selectedOptions, option => option.value) })}>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
  return <section className="device-sharing__section" aria-labelledby="sharing-personas-heading">
    <h2 id="sharing-personas-heading">{t('sharing.personas.title')}</h2>
    <p>{t('sharing.personas.help', { serverUrl })}</p>
    <div className="device-sharing__actions"><button className="primary-button" disabled={saving || state.busy || !state.catalog?.canCreate} onClick={() => setDraft(empty())}>{t('sharing.personas.create')}</button><button className="secondary-button" disabled={saving || state.busy} onClick={() => void store.load().catch(() => undefined)}>{t('sharing.personas.refresh')}</button></div>
    {state.busy && <p role="status">{t('sharing.personas.loading')}</p>}
    {state.error && <div role="alert" className="device-sharing__alert">{state.error}</div>}
    <label className="field"><span>{t('sharing.personas.search')}</span><input value={query} onChange={event => setQuery(event.target.value)} /></label>
    {state.catalog?.personas.length === 0 && <p>{t('sharing.personas.empty')}</p>}
    {state.catalog?.personas.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())).map(item => <article key={item.id}>
      <h3>{item.name} · AI · {t(`sharing.personas.status.${item.status}`)}</h3><p>{item.description}</p>
      <p>{item.origin === 'device' ? t('sharing.personas.originDevice', { device: item.sourceDeviceName ?? item.sourceDeviceId }) : t('sharing.personas.originAdmin')} · {t('sharing.personas.serverHosted')}</p>
      <div className="device-sharing__actions">
        <button className="secondary-button" disabled={state.asking || item.status !== 'published'} onClick={() => { setSelected(item); setMessage(''); store.clearAnswer() }}>{t('sharing.personas.chat')}</button>
        {item.sourceDeviceId === deviceId && item.canEdit && <><button className="secondary-button" disabled={saving} onClick={() => edit(item)}>{t('sharing.personas.configure')}</button><button className="secondary-button" disabled={saving || item.status !== 'published'} onClick={() => void run(() => store.transition(item.id, item.revision, 'pause'), t('sharing.personas.pausedNotice'))}>{t('sharing.personas.pause')}</button><button className="danger-ghost" disabled={saving || item.status === 'revoked'} onClick={() => setWithdraw(item.id)}>{t('sharing.personas.withdraw')}</button></>}
      </div>
      {withdraw === item.id && <div><p>{t('sharing.personas.withdrawHelp')}</p><button className="danger-solid" disabled={saving} onClick={() => void run(async () => { await store.transition(item.id, item.revision, 'revoke'); setWithdraw(undefined) }, t('sharing.personas.withdrawnNotice'))}>{t('sharing.personas.confirmWithdraw')}</button><button className="secondary-button" disabled={saving} onClick={() => setWithdraw(undefined)}>{t('sharing.personas.cancelWithdraw')}</button></div>}
    </article>)}
    {draft && <form className="device-sharing__publication-form" onSubmit={event => { event.preventDefault(); void run(async () => { await store.save(draft); setDraft(undefined) }, t('sharing.personas.savedNotice')) }}>
      <h3>{draft.id ? t('sharing.personas.edit') : t('sharing.personas.create')}</h3>
      <fieldset disabled={saving}>
        <label className="field"><span>{t('sharing.personas.fields.name')}</span><input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="field"><span>{t('sharing.personas.fields.description')}</span><input maxLength={2000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="field"><span>{t('sharing.personas.fields.instructions')}</span><textarea required maxLength={8000} rows={4} value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <label className="field"><span>{t('sharing.personas.fields.model')}</span><select required value={draft.modelId} onChange={event => setDraft({ ...draft, modelId: event.target.value })}><option value="">{t('sharing.personas.fields.modelPlaceholder')}</option>{state.catalog?.models.map(item => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
        {selection(t('sharing.personas.fields.sources'), 'sourceIds', state.catalog?.sources ?? [])}
        <p>{t('sharing.personas.sourcesHelp')}</p>
        {selection(t('sharing.personas.fields.members'), 'memberIds', state.catalog?.subjects.members ?? [])}
        {selection(t('sharing.personas.fields.groups'), 'groupIds', state.catalog?.subjects.groups ?? [])}
        <label className="field"><span>{t('sharing.personas.fields.status')}</span><select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as PersonaDraft['status'] })}><option value="draft">{t('sharing.personas.status.draft')}</option><option value="published">{t('sharing.personas.status.published')}</option><option value="paused">{t('sharing.personas.status.paused')}</option></select></label>
      </fieldset>
      <div className="device-sharing__actions"><button className="primary-button" disabled={saving || !draft.modelId}>{t('sharing.personas.save')}</button><button type="button" className="secondary-button" disabled={saving} onClick={() => setDraft(undefined)}>{t('sharing.personas.cancelEdit')}</button></div>
    </form>}
    {selected && <section aria-label={t('sharing.personas.chatLabel')}><h3>{t('sharing.personas.chatTitle', { name: selected.name })}</h3><p>{t('sharing.personas.chatHelp')}</p><form onSubmit={event => { event.preventDefault(); void store.chat(selected.id, message).catch(() => undefined) }}><label className="field"><span>{t('sharing.personas.question')}</span><textarea required maxLength={8000} value={message} disabled={state.asking} onChange={event => setMessage(event.target.value)} /></label><button className="primary-button" disabled={state.asking || !message.trim()}>{t('sharing.personas.send')}</button>{state.asking && <button className="secondary-button" type="button" onClick={() => void store.cancel().catch(error => notify({ tone: 'error', message: String(error) }))}>{t('sharing.personas.cancelAnswer')}</button>}</form>{state.answer && <article><h4>{t('sharing.personas.answerTitle', { model: state.answer.model })}</h4><div className="device-sharing__answer">{state.answer.answer}</div>{state.answer.sources.map((source, index) => <p key={source.id}>{t('sharing.personas.source', { index: index + 1, name: source.name, filename: source.filename, version: source.versionId })}</p>)}</article>}</section>}
  </section>
}
