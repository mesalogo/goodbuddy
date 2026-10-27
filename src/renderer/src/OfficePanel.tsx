import { useEffect, useRef, useSyncExternalStore } from 'react'
import { officeStore } from './office-store'
import { isBrowserViewportOccluded } from './browser-viewport-occlusion'
import './office-panel.css'
import type { OfficeSession } from '../../shared/office-contracts'

export function OfficePanel({ instanceId, onOpened, conversationId }: { instanceId: string; onOpened?: (session: OfficeSession) => void; conversationId?: string }): React.JSX.Element {
  const state = useSyncExternalStore(officeStore.subscribe, () => officeStore.get(instanceId))
  const host = useRef<HTMLDivElement>(null)
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
    if (state.session && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!state.busy) void officeStore.save(instanceId, event.shiftKey)
    }
  }}>
    {!state.session && <div className="office-panel__empty">
      <p>{state.name ?? '选择 Office 文件，使用已配置的 ShareServer 编辑。'}</p>
      <p>Ctrl/Cmd+S 保存回文件，Ctrl/Cmd+Shift+S 另存为。旧格式转换和附件首次保存将选择新文件。</p>
      <button type="button" className="primary-button" disabled={state.busy} onClick={() => {
        void officeStore.open(instanceId).then(session => { if (session) onOpened?.(session) })
      }}>{state.source ? '重试打开' : '选择 Office 文件并编辑'}</button>
    </div>}
    {state.message && <p role="status">{state.message}</p>}
    {state.error && <p role="alert" className="settings-error">{state.error}</p>}
    <div className="office-panel__viewport" ref={host} />
  </section>
}
