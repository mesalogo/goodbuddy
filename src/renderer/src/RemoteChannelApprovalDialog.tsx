import { ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  RemoteChannelApproval,
  RemoteChannelApprovalDecision
} from '../../shared/remote-channel-contracts'
import { trapTabFocus } from './dialog-focus'

export function RemoteChannelApprovalDialog(): React.JSX.Element | null {
  const [requests, setRequests] = useState<RemoteChannelApproval[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const current = requests[0]

  useEffect(() => {
    const api = window.goodbuddy.channels
    if (!api) {
      return
    }
    let active = true
    void api
      .getPendingRemoteApprovals()
      .then((pending) => {
        if (active) {
          setRequests((existing) => {
            const merged = new Map(
              [...pending, ...existing].map((request) => [
                request.approvalId,
                request
              ])
            )
            return [...merged.values()]
          })
        }
      })
      .catch(() => undefined)
    const remove = api.onRemoteApproval((approval) => {
      setRequests((existing) =>
        existing.some(
          (candidate) => candidate.approvalId === approval.approvalId
        )
          ? existing
          : [...existing, approval]
      )
    })
    return () => {
      active = false
      remove()
    }
  }, [])

  useEffect(() => {
    if (!current) {
      return
    }
    const remaining = Math.max(
      0,
      new Date(current.expiresAt).getTime() - Date.now()
    )
    const timeout = window.setTimeout(() => {
      setRequests((existing) =>
        existing.filter(
          (request) => request.approvalId !== current.approvalId
        )
      )
      setError(undefined)
    }, remaining)
    return () => window.clearTimeout(timeout)
  }, [current])

  const respond = useCallback(
    async (
      decision: RemoteChannelApprovalDecision
    ): Promise<void> => {
      if (!current || busy) {
        return
      }
      const api = window.goodbuddy.channels
      if (!api) {
        setError('本机审批服务不可用')
        return
      }
      setBusy(true)
      setError(undefined)
      try {
        const accepted = await api.respondRemoteApproval(
          current.approvalId,
          decision
        )
        if (!accepted) {
          throw new Error('审批请求已超时或不再有效')
        }
        setRequests((existing) => existing.slice(1))
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : '提交审批结果失败'
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, current]
  )

  useEffect(() => {
    if (!current) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        void respond('deny')
        return
      }
      trapTabFocus(event, dialogRef.current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, current, respond])

  if (!current) {
    return null
  }

  return (
    <div className="remote-approval-backdrop">
      <section
        aria-describedby="remote-approval-description"
        aria-labelledby="remote-approval-title"
        aria-modal="true"
        className="remote-approval-dialog"
        ref={dialogRef}
        role="alertdialog"
      >
        <header>
          <span className="remote-approval-dialog__icon">
            <ShieldCheck aria-hidden="true" size={20} />
          </span>
          <div>
            <strong id="remote-approval-title">
              {current.kind === 'request'
                ? '确认远程执行请求'
                : '确认远程工具调用'}
            </strong>
            <small>
              {current.channelLabel} · {current.senderDisplay}
            </small>
          </div>
        </header>

        <div className="remote-approval-dialog__scope">
          <span>项目：{current.projectName}</span>
          <span title={current.rootPath}>
            工作目录：{current.rootPath || '未设置'}
          </span>
        </div>

        <div
          className="remote-approval-dialog__request"
          id="remote-approval-description"
        >
          <strong>{current.title}</strong>
          <p>{current.description}</p>
          {current.toolName && (
            <dl>
              <div>
                <dt>工具</dt>
                <dd>{current.toolName}</dd>
              </div>
              {current.argumentSummary && (
                <div>
                  <dt>参数摘要</dt>
                  <dd>{current.argumentSummary}</dd>
                </div>
              )}
            </dl>
          )}
        </div>

        <p className="remote-approval-dialog__warning">
          此请求来自远程消息。批准只对本次请求有效，不能从消息应用中自行批准。
        </p>
        {error && (
          <p className="settings-warning" role="alert">
            {error}
          </p>
        )}

        <footer>
          <button
            autoFocus
            className="secondary-button"
            disabled={busy}
            onClick={() => void respond('deny')}
            type="button"
          >
            拒绝
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void respond('once')}
            type="button"
          >
            {busy
              ? '提交中…'
              : current.kind === 'request'
                ? '仅批准本次执行'
                : '仅允许本次调用'}
          </button>
        </footer>

        {requests.length > 1 && (
          <small className="remote-approval-dialog__queue">
            还有 {requests.length - 1} 个远程审批请求
          </small>
        )}
      </section>
    </div>
  )
}
