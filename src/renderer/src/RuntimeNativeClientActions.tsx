import { useEffect, useRef, useState } from 'react'
import { Globe, LoaderCircle, TerminalSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TerminalSnapshot } from '../../shared/terminal-contracts'

export type RuntimeNativeClientApi = {
  openRuntimeNativeClient: (input: { conversationId: string }) => Promise<
    { kind: 'terminal'; terminal: TerminalSnapshot } | { kind: 'browser'; serviceId: string }
  >
  getRuntimeNativeClient: (input: { conversationId: string }) => Promise<{ serviceId: string } | null>
  stopRuntimeNativeClient: (input: { serviceId: string }) => Promise<void>
}

type Props = {
  browser: boolean
  contextKey: string
  conversationId?: string
  prepareConversation: () => Promise<string>
  onTerminal: (terminal: TerminalSnapshot) => void
  notify: (notification: { tone: 'error' | 'success'; message: string }) => void
}

export function RuntimeNativeClientActions({ browser, contextKey, conversationId, prepareConversation, onTerminal, notify }: Props): React.JSX.Element {
  const { t } = useTranslation('app')
  const [pending, setPending] = useState<'open' | 'stop'>()
  const busy = useRef(false)
  const lookupGeneration = useRef(0)
  const [service, setService] = useState<{ key: string; serviceId: string }>()
  const [confirmStop, setConfirmStop] = useState<string>()
  const current = useRef({ contextKey, prepareConversation, notify })
  useEffect(() => { current.current = { contextKey, prepareConversation, notify } })
  const api = window.goodbuddy as typeof window.goodbuddy & RuntimeNativeClientApi
  const serviceId = service?.key === contextKey ? service.serviceId : undefined

  useEffect(() => {
    if (!browser || !conversationId) return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const generation = ++lookupGeneration.current
      try {
        const id = await current.current.prepareConversation()
        if (cancelled) return
        const result = await api.getRuntimeNativeClient({ conversationId: id })
        if (!cancelled && !busy.current && lookupGeneration.current === generation) setService(result ? { key: contextKey, ...result } : undefined)
      } catch (error) {
        if (!cancelled) current.current.notify({ tone: 'error', message: error instanceof Error ? error.message : t('composer.nativeClient.failed') })
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.removeEventListener('focus', refresh) }
  }, [api, browser, contextKey, conversationId, t])

  const run = async (stopServiceId?: string): Promise<void> => {
    if (busy.current) return
    busy.current = true
    lookupGeneration.current += 1
    setPending(stopServiceId ? 'stop' : 'open')
    try {
      if (stopServiceId) {
        await api.stopRuntimeNativeClient({ serviceId: stopServiceId })
        setService(previous => previous?.serviceId === stopServiceId ? undefined : previous)
        setConfirmStop(undefined)
        notify({ tone: 'success', message: t('composer.nativeClient.stopped') })
      } else {
        const id = await prepareConversation()
        const result = await api.openRuntimeNativeClient({ conversationId: id })
        if (result.kind === 'terminal') onTerminal(result.terminal)
        else if (current.current.contextKey === contextKey) setService({ key: contextKey, serviceId: result.serviceId })
      }
    } catch (error) {
      notify({ tone: 'error', message: error instanceof Error ? error.message : t('composer.nativeClient.failed') })
      // A browser-open failure can leave a ready service that the user can stop or reopen.
      if (browser && !stopServiceId && current.current.contextKey === contextKey) {
        try {
          const id = await prepareConversation()
          const result = await api.getRuntimeNativeClient({ conversationId: id })
          if (current.current.contextKey === contextKey) setService(result ? { key: contextKey, ...result } : undefined)
        } catch { /* Keep the original operation error. */ }
      }
    } finally {
      busy.current = false
      setPending(undefined)
    }
  }

  return <>
    <button className="composer-context-compact" type="button" disabled={!!pending} aria-busy={!!pending} onClick={() => void run()}>
      {pending === 'open' ? <LoaderCircle aria-hidden="true" className="context-chip__spinner" size={13} /> : browser ? <Globe aria-hidden="true" size={13} /> : <TerminalSquare aria-hidden="true" size={13} />}
      {t(pending === 'open' ? 'composer.nativeClient.opening' : browser ? 'composer.nativeClient.browser' : 'composer.nativeClient.terminal')}
    </button>
    {browser && serviceId && <button className="composer-context-compact danger-ghost" type="button" disabled={!!pending} onClick={() => setConfirmStop(serviceId)}>{t('composer.nativeClient.stop')}</button>}
    {serviceId && confirmStop === serviceId && <span className="composer-native-client-confirm" role="group" aria-label={t('composer.nativeClient.stop')}>
      <button type="button" className="composer-context-compact danger-ghost" title={t('composer.nativeClient.stopWarning')} aria-description={t('composer.nativeClient.stopWarning')} aria-busy={pending === 'stop'} disabled={!!pending} onClick={() => void run(serviceId)}>
        {pending === 'stop' && <LoaderCircle aria-hidden="true" className="context-chip__spinner" size={13} />}
        {t(pending === 'stop' ? 'composer.nativeClient.stopping' : 'composer.nativeClient.confirmStop')}
      </button>
      <button type="button" className="composer-context-compact" disabled={!!pending} onClick={() => setConfirmStop(undefined)}>{t('composer.nativeClient.cancel')}</button>
    </span>}
  </>
}
