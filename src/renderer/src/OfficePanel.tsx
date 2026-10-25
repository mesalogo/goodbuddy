import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { officeStore } from './office-store'
import { isBrowserViewportOccluded } from './browser-viewport-occlusion'
import './office-panel.css'
import type { OfficeSession } from '../../shared/office-contracts'

export function OfficePanel({ instanceId, onOpened, conversationId }: { instanceId: string; onOpened?: (session: OfficeSession) => void; conversationId?: string }): React.JSX.Element {
  const state = useSyncExternalStore(officeStore.subscribe, () => officeStore.get(instanceId))
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('goodbuddy.office.serverUrl') ?? 'http://localhost:8088')
  const host = useRef<HTMLDivElement>(null)
  const [instruction, setInstruction] = useState('请润色选区，保持原意，表达更清晰。')
  useEffect(() => {
    if (!state.session || !host.current) return
    const element = host.current
    let frame = 0
    let previous = ''
    const update = (): void => {
      frame = 0
      const rect = element.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0 && !element.closest('[hidden]') &&
        !isBrowserViewportOccluded(element, rect)
      const input = { instanceId, visible, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      const next = JSON.stringify(input)
      if (next === previous) return
      previous = next
      void window.goodbuddy.office?.viewport(input).catch(() => { previous = '' })
    }
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(update) }
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      void window.goodbuddy.office?.viewport({ instanceId, visible: false, x: 0, y: 0, width: 0, height: 0 })
    }
  }, [instanceId, state.session])
  return <section className="office-panel" aria-label="在线文档">
    {!state.session ? <form onSubmit={event => {
      event.preventDefault()
      localStorage.setItem('goodbuddy.office.serverUrl', serverUrl)
      void officeStore.open(instanceId, serverUrl).then(session => { if (session) onOpened?.(session) })
    }}>
      <label className="field">ShareServer 地址
        <input value={serverUrl} onChange={event => setServerUrl(event.target.value)} type="url" required disabled={state.busy} />
      </label>
      <p>{state.name ?? '选择 DOCX 后上传编辑副本。'} 点击保存回文件才会更新源文件；附件使用另存为。</p>
      <button type="submit" className="primary-button" disabled={state.busy}>{state.source ? '打开在线编辑' : '选择 DOCX 并编辑'}</button>
    </form> : <div className="office-panel__toolbar">
      <strong title={state.session.document.name}>{state.session.document.name}</strong>
      <button className="primary-button" disabled={state.busy} onClick={() => void officeStore.save(instanceId, false)}>{state.session.readOnlySource ? '保存到本地文件' : '保存回文件'}</button>
      <button className="secondary-button" disabled={state.busy} onClick={() => void officeStore.save(instanceId, true)}>另存为</button>
    </div>}
    {state.session && <details>
      <summary>AI 编辑选区</summary>
      <label className="field">修改要求<input value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={4000} /></label>
      <div className="office-panel__toolbar">
        <button className="secondary-button" disabled={state.busy || !conversationId || !instruction.trim()} onClick={() => void officeStore.ask(instanceId, conversationId!, instruction)}>向当前对话发送选区</button>
        {(state.aiPending || state.reply) && <button className="secondary-button" disabled={state.busy} onClick={() => void officeStore.result(instanceId)}>获取修改结果</button>}
      </div>
      {!conversationId && <p>请先打开一个对话，再发送文档选区。</p>}
      {state.selectedText && <p>已绑定原选区（{state.selectedText.length} 字）；切换对话不会改变本次结果归属。</p>}
      {state.reply !== undefined && <>
        <label className="field">修改结果<textarea value={state.reply} rows={4} maxLength={32000} onChange={event => officeStore.setReply(instanceId, event.target.value)} /></label>
        <button className="primary-button" disabled={state.busy || !state.reply.trim()} onClick={() => void officeStore.apply(instanceId)}>应用到原选区</button>
      </>}
    </details>}
    {state.message && <p role="status">{state.message}</p>}
    {state.error && <p role="alert" className="settings-error">{state.error}</p>}
    <div className="office-panel__viewport" ref={host} />
  </section>
}
