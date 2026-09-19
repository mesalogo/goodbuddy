import { useEffect, useState } from 'react'
import type { ContextAttachment } from '../../shared/contracts'

export function PendingDocumentImports({ conversationId, refreshing, onBusyChange }: {
  conversationId: string; refreshing: boolean; onBusyChange: (busy: boolean) => void
}): React.JSX.Element | null {
  const [items, setItems] = useState<ContextAttachment[]>([])
  const [revision, setRevision] = useState(0)
  const [operation, setOperation] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.goodbuddy.context.pendingParsing(conversationId).then((value) => { if (active) setItems(value) },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '解析记录读取失败') })
    return () => { active = false }
  }, [conversationId, refreshing, revision])
  if (!items.length && !error) return null
  return <div className="settings-warning" aria-label="未完成的文件解析">
    {items.map((item) => <div key={item.id}>
      <strong>{item.name} · {item.parsingState === 'interrupted' ? '解析已中断' : '解析失败'}</strong>
      <p>{item.parsingError ?? '原文件已保存，可使用当前设置手动重试。'}</p>
      <button type="button" className="secondary-button" disabled={Boolean(operation)} onClick={() => {
        const id = crypto.randomUUID()
        setOperation(id); setError(''); onBusyChange(true)
        void window.goodbuddy.context.retryParsing(conversationId, item.id, id).then(() => setRevision((value) => value + 1))
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '重试失败'))
          .finally(() => { setOperation(''); onBusyChange(false) })
      }}>使用当前设置重试</button>
      <button type="button" className="secondary-button" disabled={Boolean(operation)} onClick={() => {
        void window.goodbuddy.context.dismissParsing(conversationId, item.id).then(() => setRevision((value) => value + 1))
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '移除记录失败'))
      }}>移除记录与暂存原件</button>
    </div>)}
    {operation && <button type="button" className="secondary-button" onClick={() => void window.goodbuddy.context.cancelParsing(operation)}>取消解析</button>}
    {error && <p role="alert">{error}</p>}
  </div>
}
