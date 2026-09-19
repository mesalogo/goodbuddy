import { useEffect, useState } from 'react'
import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'

export function AttachmentCapabilityNotice({ conversationId, selection, revision }: {
  conversationId: string; selection?: AgentRuntimeSelection; revision: string
}): React.JSX.Element {
  const [reason, setReason] = useState<string>()
  const [confirmed, setConfirmed] = useState(false)
  const key = JSON.stringify(selection)
  useEffect(() => {
    let active = true
    void window.goodbuddy.context.imageCapability(conversationId, JSON.parse(key ?? 'null') ?? undefined).then((result) => {
      if (active) { setConfirmed(true); setReason(result.supported ? undefined : result.reason) }
    }, () => { if (active) { setConfirmed(false); setReason('尚未确认图片输入能力；发送前将再次核对') } })
    return () => { active = false }
  }, [conversationId, key, revision])
  return !confirmed || reason ? <p className="settings-warning" role="status">{reason ?? '正在核对当前模型与 Runtime 的图片输入能力'}</p> : <></>
}
