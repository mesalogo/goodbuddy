import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
import { X } from 'lucide-react'
import type { InferenceAction, InferenceService, InferenceTask, LocalInferenceSnapshot } from '../../shared/local-inference-contracts'
import { PageHeader } from './WorkspacePrimitives'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { getOcrInferenceState, loadOcrInference, releaseOcrInference } from './document-ocr-bridge'
import './local-inference.css'

type Control = { service: InferenceService; action: InferenceAction['action'] | 'load' | 'release'; tasks: InferenceTask[] }

function ImpactConfirmation({ control, busy, onClose, onConfirm }: {
  control: Control; busy: boolean; onClose: () => void; onConfirm: () => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const cancel = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => activateModalFocus(() => cancel.current, () => document.querySelector<HTMLElement>('.local-inference-modal')), [])
  return createPortal(<div className="custom-task-dialog"><section className="custom-task-dialog__surface local-inference-confirm" role="dialog" aria-modal="true" aria-labelledby="inference-confirm-title" aria-describedby="inference-confirm-description" tabIndex={-1} onKeyDown={(event) => {
    event.stopPropagation()
    trapTabFocus(event, event.currentTarget)
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose() }
  }}><div className="custom-task-dialog__content">
    <h2 id="inference-confirm-title">{t('localInference.confirmTitle', { action: t(`localInference.actions.${control.action}`), service: control.service.name })}</h2>
    <p id="inference-confirm-description">{t('localInference.confirmDescription')}</p>
    {control.tasks.length ? <ul>{control.tasks.map((task) => <li key={task.id}>{task.source} · {new Date(task.startedAt).toLocaleTimeString()} · {t(`localInference.states.${task.state}`)}</li>)}</ul> : <p>{t('localInference.noActiveTasks')}</p>}
  </div><div className="custom-task-dialog__actions">
      <button ref={cancel} type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t('localInference.keepRunning')}</button>
      <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? t('localInference.working') : t('localInference.confirm', { action: t(`localInference.actions.${control.action}`) })}</button>
    </div>
  </section></div>, document.body)
}

export default function LocalInferencePage({ onClose, enabled = true, restoreFocus }: {
  onClose: () => void; enabled?: boolean; restoreFocus?: () => HTMLElement | null
}): React.JSX.Element {
  const { t } = useTranslation('app')
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
        if (!window.goodbuddy.localInference) throw new Error(i18n.t('app:localInference.apiUnavailable'))
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

  return createPortal(<div className="custom-task-dialog"><section className="custom-task-dialog__surface local-inference-modal" role="dialog" aria-modal="true" aria-label={t('localInference.title')} tabIndex={-1} onKeyDown={(event) => {
    if (event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== event.currentTarget) return
    trapTabFocus(event, event.currentTarget)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!operation.current && !control) onClose()
    }
  }}>
    <div className="custom-task-dialog__header">
    <PageHeader headingId="local-inference-title" title={t('localInference.title')}
      help={enabled ? t('localInference.help') : undefined}
      actions={<button ref={close} type="button" className="icon-button" aria-label={t('localInference.close')} title={t('localInference.close')} disabled={busy || Boolean(control)} onClick={() => { if (!operation.current && !control) onClose() }}><X size={20} aria-hidden="true" /></button>} />
    </div>
    <div className="local-inference-modal__body">
    {!enabled && <div className="local-inference-actions"><strong>{t('applications.disabledPage')}</strong></div>}
    <div className="local-inference-workspace" hidden={!enabled} inert={!enabled}>
    <div className="local-inference-toolbar">
    <div className="local-inference-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void window.goodbuddy.localInference.openSettings().catch((reason: unknown) => setOperationError(String(reason)))}>{t('localInference.openSettings')}</button><button className="secondary-button" type="button" disabled={refreshing || busy} onClick={() => setReload((value) => value + 1)}>{t('localInference.refresh')}</button></div>
    </div>
    {error && <div className="local-inference-feedback" role="alert"><p>{snapshot ? t('localInference.stale') : t('localInference.loadFailed')} {error}</p><button type="button" className="secondary-button" onClick={() => setReload((value) => value + 1)}>{t('localInference.retry')}</button></div>}
    {!snapshot && !error && <p role="status">{t('localInference.loading')}</p>}
    {operationError && !control && <div className="local-inference-feedback" role="alert">{operationError}<button type="button" className="secondary-button" onClick={() => setOperationError('')}>{t('localInference.dismissError')}</button></div>}
    {snapshot && <section aria-label={t('localInference.servicesLabel')} className="local-inference-content">
        {services?.length === 0 && <p role="status">{t('localInference.noServices')}</p>}
        {services?.map((service) => <article className="local-inference-row" key={service.id}>
          <div><div className="local-inference-row__heading"><h2>{service.name}</h2><span className="local-inference-state">{service.id === 'asr' && service.state === 'unknown' ? t('localInference.onDemandUnknown') : t(`localInference.states.${service.state}`)}</span></div>
            <p className="local-inference-metadata">{service.engine}{service.model ? ` · ${service.model}` : ''}</p>
            <p className="local-inference-metadata">
              {service.resources?.scope === 'service-process'
                ? t('localInference.processResources', {
                    pid: service.resources.pid,
                    cpu: service.resources.cpuPercent === undefined ? service.resources.cpuUnavailableReason : `${service.resources.cpuPercent.toFixed(1)}%`,
                    memory: service.resources.workingSetBytes === undefined ? service.resources.memoryUnavailableReason : `${(service.resources.workingSetBytes / 1024 / 1024).toFixed(1)} MiB`
                  })
                : t('localInference.cpuMemory', { value: service.resources?.reason ?? t('localInference.unavailableValue') })}
            </p>
            {service.error && <p className="local-inference-error">{service.error}</p>}
          </div>
          <div className="local-inference-actions">
            {service.id === 'ocr' && <button className="secondary-button" type="button" disabled={busy} onClick={() => void window.goodbuddy.localInference.openSettings('document-parsing').catch((reason: unknown) => setOperationError(String(reason)))}>{t('localInference.documentParsingSettings')}</button>}
            {service.actions.map((action) => <button type="button" className="secondary-button" key={action} disabled={busy || refreshing || Boolean(error)} onClick={() => selectAction(service, action)}>{t(`localInference.actions.${action}`)}</button>)}
            {service.id === 'ocr' && <button type="button" className="secondary-button" disabled={busy || refreshing || Boolean(error) || ocr.busy || service.state === 'unavailable'} onClick={() => selectAction(service, ocr.loaded ? 'release' : 'load')}>{t(ocr.loaded ? 'localInference.actions.release' : 'localInference.actions.load')}</button>}
          </div>
        </article>)}
    </section>}
    {control && <ImpactConfirmation control={control} busy={busy} onClose={() => { if (!operation.current) { setControl(undefined); setOperationError('') } }} onConfirm={() => void execute(control)} />}
  </div></div></section></div>, document.body)
}
