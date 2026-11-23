import { useEffect, useRef, useSyncExternalStore } from 'react'
import { officeStore } from './office-store'
import { isBrowserViewportOccluded } from './browser-viewport-occlusion'
import './office-panel.css'
import type { OfficeSession } from '../../shared/office-contracts'

export function OfficePanel({ instanceId, onOpened, conversationId }: { instanceId: string; onOpened?: (session: OfficeSession) => void; conversationId?: string }): React.JSX.Element {
  const state = useSyncExternalStore(officeStore.subscribe, () => officeStore.get(instanceId))
  const host = useRef<HTMLDivElement>(null)
  const interaction = state.interaction
  const continueButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const button = continueButton.current
    if (button && !button.closest('[hidden]')) button.focus()
  }, [interaction?.kind])
  useEffect(() => {
    if (state.session) void window.goodbuddy.office?.context?.({ instanceId, conversationId })
  }, [instanceId, conversationId, state.session])
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
  return <section className="office-panel" aria-label="在线文档" data-office-instance={instanceId} onKeyDown={event => {
    if (state.session && !interaction?.closing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!state.busy) void officeStore.save(instanceId, event.shiftKey)
    }
  }}>
    {!state.session && state.busy && <div className="office-panel__progress" role="progressbar" aria-label={state.name ? `正在打开 ${state.name}` : '正在打开文档'} />}
    {!state.session && !state.busy && <div className="office-panel__empty">
      <p>{state.name ?? '选择 Office 文件，使用已配置的 ShareServer 编辑。'}</p>
      <p>Ctrl/Cmd+S 保存回文件，Ctrl/Cmd+Shift+S 另存为。旧格式转换和附件首次保存将选择新文件。</p>
      <button type="button" className="primary-button" onClick={() => {
        void officeStore.open(instanceId).then(session => { if (session) onOpened?.(session) })
      }}>{state.source ? '重试打开' : '选择 Office 文件并编辑'}</button>
    </div>}
    {!interaction && state.message && <p role="status">{state.message}</p>}
    {!interaction && state.error && <p role="alert" className="settings-error">{state.error}</p>}
    {interaction && <div className="office-panel__decision" role="dialog" aria-modal="false" aria-label={interaction.closing ? '关闭文档' : '保存到源文件失败'} onKeyDown={event => {
      if (event.key === 'Escape' && interaction.kind !== 'progress' && !state.busy) {
        event.stopPropagation()
        if (interaction.closing) void officeStore.resolveClose(instanceId, 'cancel')
        else officeStore.dismissInteraction(instanceId)
      }
    }}>
      <div className="office-panel__decision-card">
        <h3>{interaction.closing ? '关闭文档' : '保存到源文件失败'}</h3>
        <strong>{interaction.name}</strong>
        <p role={interaction.kind === 'error' ? 'alert' : 'status'}>{interaction.detail}</p>
        {state.error && <p role="alert">{state.error}</p>}
        {state.message && <p role="status">{state.message}</p>}
        {interaction.kind !== 'progress' && <div className="office-panel__toolbar">
          <button type="button" className="primary-button" disabled={state.busy} onClick={() => {
            if (interaction.closing) void officeStore.resolveClose(instanceId, 'save')
            else void officeStore.save(instanceId, false)
          }}>{interaction.closing ? '保存到源文件并关闭' : '重试保存'}</button>
          <button type="button" className="secondary-button" disabled={state.busy} onClick={() => {
            if (interaction.closing) void officeStore.resolveClose(instanceId, 'saveAs')
            else void officeStore.save(instanceId, true)
          }}>{interaction.closing ? '另存为并关闭' : '另存为'}</button>
          {interaction.closing && <button type="button" className="secondary-button" onClick={() => { void officeStore.resolveClose(instanceId, 'discard') }}>不写回源文件并关闭</button>}
          <button ref={continueButton} type="button" className="secondary-button" disabled={state.busy} onClick={() => {
            if (interaction.closing) void officeStore.resolveClose(instanceId, 'cancel')
            else officeStore.dismissInteraction(instanceId)
          }}>继续编辑</button>
        </div>}
      </div>
    </div>}
    <div className="office-panel__viewport" ref={host} />
  </section>
}
