import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PersonaDraft, SharedPersona } from '../../shared/sharing-personas'
import type { AppNotificationInput } from './notifications'
import { createSharingPersonasStore } from './sharing-personas-store'

const empty = (): PersonaDraft => ({ name: '', description: '', instructions: '', modelId: '', sourceIds: [], memberIds: [], groupIds: [], status: 'draft' })
const status = { draft: '草稿', published: '已发布', paused: '已暂停', revoked: '已撤回' }
export function SharingPersonas({ serverUrl, deviceId, notify }: { serverUrl: string; deviceId: string; notify: (input: AppNotificationInput) => void }): React.JSX.Element {
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
    <h2 id="sharing-personas-heading">数字分身</h2>
    <p>配置发布到 {serverUrl}，由服务器托管执行。发布后 GB 离线仍可使用；本地项目、记忆、文件与密钥不会自动上传。</p>
    <div className="device-sharing__actions"><button className="primary-button" disabled={saving || state.busy || !state.catalog?.canCreate} onClick={() => setDraft(empty())}>创建共享分身</button><button className="secondary-button" disabled={saving || state.busy} onClick={() => void store.load().catch(() => undefined)}>刷新分身</button></div>
    {state.busy && <p role="status">正在读取分身…</p>}
    {state.error && <div role="alert" className="settings-warning">{state.error}</div>}
    <label className="field"><span>搜索分身</span><input value={query} onChange={event => setQuery(event.target.value)} /></label>
    {state.catalog?.personas.length === 0 && <p>暂无可访问的分身。可发布自己的配置，或由管理员授予成员使用权。</p>}
    {state.catalog?.personas.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())).map(item => <article key={item.id}>
      <h3>{item.name} · AI · {status[item.status]}</h3><p>{item.description}</p>
      <p>{item.origin === 'device' ? `GB 客户端共享 · ${item.sourceDeviceName ?? item.sourceDeviceId}` : '管理员创建'} · 服务器托管</p>
      <div className="device-sharing__actions">
        <button className="secondary-button" disabled={state.asking || item.status !== 'published'} onClick={() => { setSelected(item); setMessage(''); store.clearAnswer() }}>与分身对话</button>
        {item.sourceDeviceId === deviceId && item.canEdit && <><button className="secondary-button" disabled={saving} onClick={() => edit(item)}>配置与授权</button><button className="secondary-button" disabled={saving || item.status !== 'published'} onClick={() => void run(() => store.transition(item.id, item.revision, 'pause'), '分身已暂停')}>暂停分身</button><button className="danger-ghost" disabled={saving || item.status === 'revoked'} onClick={() => setWithdraw(item.id)}>撤回共享</button></>}
      </div>
      {withdraw === item.id && <div><p>撤回后其他成员不能继续调用；之后可由本设备编辑并重新发布。</p><button className="danger-solid" disabled={saving} onClick={() => void run(async () => { await store.transition(item.id, item.revision, 'revoke'); setWithdraw(undefined) }, '分身已撤回')}>确认撤回分身</button><button className="secondary-button" disabled={saving} onClick={() => setWithdraw(undefined)}>取消撤回</button></div>}
    </article>)}
    {draft && <form className="device-sharing__publication-form" onSubmit={event => { event.preventDefault(); void run(async () => { await store.save(draft); setDraft(undefined) }, '分身配置已保存到服务器') }}>
      <h3>{draft.id ? '编辑共享分身' : '创建共享分身'}</h3>
      <fieldset disabled={saving}>
        <label className="field"><span>分身名称</span><input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="field"><span>分身说明</span><input maxLength={2000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="field"><span>角色与回答规则</span><textarea required maxLength={8000} rows={4} value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <label className="field"><span>服务器执行模型</span><select required value={draft.modelId} onChange={event => setDraft({ ...draft, modelId: event.target.value })}><option value="">请选择模型</option>{state.catalog?.models.map(item => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
        {selection('可选站点知识', 'sourceIds', state.catalog?.sources ?? [])}
        <p>可不选择知识。选择后使用者须有来源下载权；匿名设备不能选择成员知识。支持 TXT、Markdown、CSV、JSON、LOG，最多 8 个来源。不会上传本地资料。</p>
        {selection('允许使用的成员', 'memberIds', state.catalog?.subjects.members ?? [])}
        {selection('允许使用的用户组', 'groupIds', state.catalog?.subjects.groups ?? [])}
        <label className="field"><span>发布状态</span><select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as PersonaDraft['status'] })}><option value="draft">草稿</option><option value="published">已发布</option><option value="paused">已暂停</option></select></label>
      </fieldset>
      <div className="device-sharing__actions"><button className="primary-button" disabled={saving || !draft.modelId}>保存分身配置</button><button type="button" className="secondary-button" disabled={saving} onClick={() => setDraft(undefined)}>取消编辑</button></div>
    </form>}
    {selected && <section aria-label="分身对话"><h3>{selected.name} · AI 对话</h3><p>当前为独立文本问答；问题和回答只保留在当前页面。</p><form onSubmit={event => { event.preventDefault(); void store.chat(selected.id, message).catch(() => undefined) }}><label className="field"><span>向分身提问</span><textarea required maxLength={8000} value={message} disabled={state.asking} onChange={event => setMessage(event.target.value)} /></label><button className="primary-button" disabled={state.asking || !message.trim()}>发送问题</button>{state.asking && <button className="secondary-button" type="button" onClick={() => void store.cancel().catch(error => notify({ tone: 'error', message: String(error) }))}>取消回答</button>}</form>{state.answer && <article><h4>AI 回答 · {state.answer.model}</h4><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{state.answer.answer}</div>{state.answer.sources.map((source, index) => <p key={source.id}>[S{index + 1}] {source.name} · {source.filename} · 版本 {source.versionId}</p>)}</article>}</section>}
  </section>
}
