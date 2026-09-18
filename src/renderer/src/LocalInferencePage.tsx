import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { InferenceAction, InferenceService, InferenceTask, LocalInferenceSnapshot } from '../../shared/local-inference-contracts'
import { PageHeader } from './WorkspacePrimitives'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { getOcrInferenceState, loadOcrInference, releaseOcrInference } from './document-ocr-bridge'
import { ApplicationSettingsLink } from './ApplicationCenter'
import './local-inference.css'

const stateLabels: Record<string, string> = {
  idle: '未加载 / 按需运行', running: '运行中', starting: '启动中', stopping: '停止中',
  stopped: '已停止', error: '异常', unavailable: '不可用', unknown: '未知',
  cancelling: '等待取消确认', completed: '已完成', cancelled: '已取消', failed: '失败'
}
const actionLabels = { start: '启动服务', stop: '停止服务', restart: '重启服务', load: '加载模型', release: '释放模型' }
type Control = { service: InferenceService; action: InferenceAction['action'] | 'load' | 'release'; tasks: InferenceTask[] }

function ImpactConfirmation({ control, busy, onClose, onConfirm }: {
  control: Control; busy: boolean; onClose: () => void; onConfirm: () => void
}): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => activateModalFocus(() => cancel.current, () => document.querySelector<HTMLElement>('.local-inference-modal')), [])
  return createPortal(<div className="custom-task-dialog"><section className="custom-task-dialog__surface local-inference-confirm" role="dialog" aria-modal="true" aria-labelledby="inference-confirm-title" aria-describedby="inference-confirm-description" tabIndex={-1} onKeyDown={(event) => {
    event.stopPropagation()
    trapTabFocus(event, event.currentTarget)
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose() }
  }}><div className="custom-task-dialog__content">
    <h2 id="inference-confirm-title">{actionLabels[control.action]}：{control.service.name}</h2>
    <p id="inference-confirm-description">此操作影响整个执行服务。被中断的任务不会在服务重新启动后自动重放。</p>
    {control.tasks.length ? <ul>{control.tasks.map((task) => <li key={task.id}>{task.source} · {new Date(task.startedAt).toLocaleTimeString()} · {stateLabels[task.state]}</li>)}</ul> : <p>当前没有已登记的活动任务。执行前将再次核对。</p>}
  </div><div className="custom-task-dialog__actions">
      <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>保留运行状态</button>
      <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? '操作中…' : `确认${actionLabels[control.action]}`}</button>
    </div>
  </section></div>, document.body)
}

export default function LocalInferencePage({ onClose, enabled = true, restoreFocus }: {
  onClose: () => void; enabled?: boolean; restoreFocus?: () => HTMLElement | null
}): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(restoreFocus)
  useLayoutEffect(() => activateModalFocus(() => close.current, () => restoreFocusRef.current?.() ?? null), [])
  const [snapshot, setSnapshot] = useState<LocalInferenceSnapshot>()
  const [error, setError] = useState('')
  const [operationError, setOperationError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [control, setControl] = useState<Control>()
  const [reload, setReload] = useState(0)
  const operation = useRef(false)
  const [ocr, setOcr] = useState(getOcrInferenceState)

  useEffect(() => {
    let alive = true
    let inFlight = false
    const refresh = async (): Promise<void> => {
      if (inFlight || !enabled || document.hidden || document.getElementById('local-inference-title')?.closest('[hidden], [inert]')) return
      inFlight = true
      setRefreshing(true)
      try {
        if (!window.goodbuddy.localInference) throw new Error('本机推理管理接口不可用，请重启应用后重试')
        const next = await window.goodbuddy.localInference.getSnapshot()
        if (alive) { setSnapshot(next); setOcr(getOcrInferenceState()); setError('') }
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        inFlight = false
        if (alive) setRefreshing(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    const onVisible = (): void => { void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [reload, enabled])

  const services = useMemo(() => snapshot?.services.map((service) => service.id === 'ocr' ? {
    ...service,
    state: ocr.state === 'idle' && (service.state === 'unavailable' || service.state === 'error') ? service.state : ocr.state,
    model: ocr.model ?? service.model, error: ocr.error ?? service.error
  } : service), [snapshot, ocr])
  const activeTasks = useMemo(() => snapshot?.tasks.filter((task) => task.finishedAt === undefined) ?? [], [snapshot])

  const execute = async (selected: Control): Promise<void> => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setOperationError('')
    try {
      if (selected.action === 'load') await loadOcrInference()
      else if (selected.action === 'release') releaseOcrInference()
      else await window.goodbuddy.localInference.act({ serviceId: selected.service.id, action: selected.action, confirmedTaskIds: selected.tasks.map((task) => task.id) })
      setControl(undefined)
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : String(reason))
      setControl(undefined)
    } finally {
      operation.current = false
      setBusy(false)
      setOcr(getOcrInferenceState())
      setReload((value) => value + 1)
    }
  }
  const selectAction = (service: InferenceService, action: Control['action']): void => {
    if (operation.current) return
    const selected = { service, action, tasks: activeTasks.filter((task) => task.serviceId === service.id) }
    setOperationError('')
    if (action === 'start' || action === 'load') void execute(selected)
    else setControl(selected)
  }

  return createPortal(<div className="custom-task-dialog"><section className="custom-task-dialog__surface local-inference-modal" role="dialog" aria-modal="true" aria-label="本机推理" tabIndex={-1} onKeyDown={(event) => {
    if (event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== event.currentTarget) return
    trapTabFocus(event, event.currentTarget)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!operation.current && !control) onClose()
    }
  }}>
    <div className="custom-task-dialog__header">
    <PageHeader headingId="local-inference-title" title="本机推理" scope={{ kind: 'global' }}
      actions={<button ref={close} type="button" className="icon-button" aria-label="关闭本机推理" title="关闭本机推理" disabled={busy || Boolean(control)} onClick={() => { if (!operation.current && !control) onClose() }}><X size={20} aria-hidden="true" /></button>} />
    </div>
    <div className="local-inference-modal__body">
    {!enabled && <div className="local-inference-actions"><strong>应用已关闭</strong><ApplicationSettingsLink id="local-inference" /></div>}
    <div className="local-inference-workspace" hidden={!enabled} inert={!enabled}>
    <div className="local-inference-toolbar">
    <p className="local-inference-note">每 5 秒刷新 · CPU 100% = 一个逻辑核心</p>
    <div className="local-inference-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void window.goodbuddy.localInference.openSettings().catch((reason: unknown) => setOperationError(String(reason)))}>模型与连接设置</button><button className="secondary-button" type="button" disabled={refreshing || busy} onClick={() => setReload((value) => value + 1)}>刷新状态</button></div>
    </div>
    {error && <div className="local-inference-feedback" role="alert"><p>{snapshot ? '状态刷新失败；以下为上次成功读取的状态，操作已禁用。' : '无法读取本机推理状态。'} {error}</p><button type="button" className="secondary-button" onClick={() => setReload((value) => value + 1)}>重试</button></div>}
    {!snapshot && !error && <p role="status">正在读取服务状态…</p>}
    {operationError && !control && <div className="local-inference-feedback" role="alert">{operationError}<button type="button" className="secondary-button" onClick={() => setOperationError('')}>关闭提示</button></div>}
    {snapshot && <section aria-label="本机推理服务" className="local-inference-content">
        {services?.length === 0 && <p role="status">暂无本机推理服务</p>}
        {services?.map((service) => <article className="local-inference-row" key={service.id}>
          <div><div className="local-inference-row__heading"><h2>{service.name}</h2><span className="local-inference-state">{service.id === 'asr' && service.state === 'unknown' ? '按需运行（状态未知）' : stateLabels[service.state]}</span></div>
            <p className="local-inference-metadata">{service.engine}{service.model ? ` · ${service.model}` : ''}</p>
            <p className="local-inference-metadata">
              {service.resources?.scope === 'service-process'
                ? `服务进程 PID ${service.resources.pid} · CPU ${service.resources.cpuPercent === undefined ? service.resources.cpuUnavailableReason : `${service.resources.cpuPercent.toFixed(1)}%`} · 工作集 ${service.resources.workingSetBytes === undefined ? service.resources.memoryUnavailableReason : `${(service.resources.workingSetBytes / 1024 / 1024).toFixed(1)} MiB`}`
                : `CPU / 内存：${service.resources?.reason ?? '暂不可用'}`}
            </p>
            {service.error && <p className="local-inference-error">{service.error}</p>}
          </div>
          <div className="local-inference-actions">
            {service.actions.map((action) => <button type="button" className="secondary-button" key={action} disabled={busy || refreshing || Boolean(error)} onClick={() => selectAction(service, action)}>{actionLabels[action]}</button>)}
            {service.id === 'ocr' && <button type="button" className="secondary-button" disabled={busy || refreshing || Boolean(error) || ocr.busy || service.state === 'unavailable'} onClick={() => selectAction(service, ocr.loaded ? 'release' : 'load')}>{ocr.loaded ? '释放模型' : '加载模型'}</button>}
          </div>
        </article>)}
    </section>}
    {control && <ImpactConfirmation control={control} busy={busy} onClose={() => { if (!operation.current) { setControl(undefined); setOperationError('') } }} onConfirm={() => void execute(control)} />}
  </div></div></section></div>, document.body)
}
