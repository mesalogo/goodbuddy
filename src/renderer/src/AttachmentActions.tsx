import { useContext, useId, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import type { ContextAttachment } from '../../shared/contracts'
import { AnchoredMenu } from './AnchoredMenu'
import { DocumentConversationContext } from './DocumentConversationContext'

export function AttachmentStatus({ attachment }: { attachment: ContextAttachment }): React.JSX.Element {
  return <>
    {attachment.completeness && <small>{({ complete: '解析完成', partial: '部分解析，请查看警告', 'images-only': '仅图片，无可发送正文' })[attachment.completeness]}</small>}
    {attachment.sendMode && <small>{attachment.sendMode === 'text' ? '仅发送提取文字，原图保留' : '图片输入'}</small>}
  </>
}

export function AttachmentActions({ attachment, conversationId, onBusyChange, readOnly = false }: {
  attachment: ContextAttachment; conversationId?: string; onBusyChange?: (busy: boolean) => void; readOnly?: boolean
}): React.JSX.Element {
  const target = useContext(DocumentConversationContext)
  const [menu, setMenu] = useState(false)
  const [operation, setOperation] = useState('')
  const [error, setError] = useState('')
  const [provider, setProvider] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  const id = useId()
  if (!attachment.resourceId) return <></>
  const run = (action: (operationId: string) => Promise<unknown>): void => {
    const operationId = crypto.randomUUID()
    setMenu(false); setError(''); setOperation(operationId); onBusyChange?.(true)
    void action(operationId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '附件操作失败'))
      .finally(() => { setOperation(''); onBusyChange?.(false) })
  }
  return <>
    <button type="button" className="icon-button attachment-action" title="更多附件操作" data-tooltip="更多附件操作" ref={anchor} aria-haspopup="menu" aria-expanded={menu} aria-controls={menu ? id : undefined}
      aria-label={`更多附件操作：${attachment.name}`} disabled={Boolean(operation)} onClick={() => {
        if (!menu) {
          setProvider('正在读取已保存的解析来源')
          void window.goodbuddy.documentParsing!.getSnapshot().then((snapshot) => setProvider(snapshot.settings.ocrProvider === 'paddleocr-vl' ? '解析来源：HTTP PaddleOCR-VL（远程服务）' : '解析来源：本地 OCR'), () => setProvider('来源读取失败；操作仍使用已保存的解析设置'))
        }
        setMenu((value) => !value)
      }}><Ellipsis size={16} aria-hidden="true" /></button>
    {menu && <AnchoredMenu anchorRef={anchor} id={id} label={`附件操作：${attachment.name}`} onClose={() => setMenu(false)}>
      <small>{provider}</small>
      <button type="button" role="menuitem" onClick={() => run(() => window.goodbuddy.context.openOriginal(attachment.resourceId!))}>打开原文件：{attachment.originalName ?? attachment.name}</button>
      {conversationId && <button type="button" role="menuitem" onClick={() => run((operationId) => window.goodbuddy.context.reparseDraft(conversationId, attachment.id, operationId))}>
        {attachment.sendMode ? '提取图片文字' : '使用当前设置重新解析'}：{attachment.originalName ?? attachment.name}
      </button>}
      {conversationId && attachment.sendMode === 'text' && <button type="button" role="menuitem" onClick={() => run(() => window.goodbuddy.context.sendOriginal(conversationId, attachment.id))}>改为发送原图：{attachment.originalName}</button>}
      {!readOnly && !conversationId && target?.activeId && <button type="button" role="menuitem" onClick={() => run(async (operationId) => {
        await window.goodbuddy.context.copyToDraft(target.activeId!, attachment.resourceId!, operationId)
        target.notify('已按当前设置解析并添加到目标会话草稿')
      })}>{attachment.sendMode ? '添加到当前草稿并提取文字' : '添加到当前草稿重新解析'}：{attachment.originalName ?? attachment.name}</button>}
      <button type="button" role="menuitem" onClick={() => { setMenu(false); void window.goodbuddy.localInference.openSettings('document-parsing') }}>前往文档解析设置</button>
    </AnchoredMenu>}
    {operation && <span role="status">正在处理附件<button type="button" className="secondary-button" onClick={() => void window.goodbuddy.context.cancelParsing(operation)}>取消解析</button></span>}
    {error && <span role="alert">{error}</span>}
  </>
}
