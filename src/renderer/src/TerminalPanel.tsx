import { SearchAddon } from '@xterm/addon-search'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  Clipboard,
  Copy,
  Eraser,
  Pencil,
  RefreshCw,
  Search
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type { DesktopApi } from '../../shared/contracts'
import type {
  TerminalEvent,
  TerminalSessionId,
  TerminalSnapshot,
  TerminalTarget
} from '../../shared/terminal-contracts'
import './terminal-panel.css'

export type TerminalAdapter = Omit<DesktopApi['terminal'], 'onEvent'> & {
  subscribe: DesktopApi['terminal']['onEvent']
}

type Disposable = { dispose: () => void }

export type TerminalEmulator = {
  readonly cols: number
  readonly rows: number
  open: (element: HTMLElement) => void
  onData: (listener: (data: string) => void) => Disposable
  write: (data: string, callback?: () => void) => void
  clear: () => void
  selectAll: () => void
  getSelection: () => string
  focus: () => void
  dispose: () => void
}

export type TerminalFitAddon = {
  fit: () => void
}

export type TerminalSearchAddon = {
  findNext: (term: string) => boolean
}

export type TerminalFactoryResult = {
  terminal: TerminalEmulator
  fitAddon: TerminalFitAddon
  searchAddon: TerminalSearchAddon
  activateRenderer?: () => void
}

export type TerminalFactory = () => TerminalFactoryResult

export type TerminalPanelProps = {
  adapter: TerminalAdapter
  target: TerminalTarget
  sessionId?: TerminalSessionId
  title?: string
  terminalFactory?: TerminalFactory
  onSessionChange?: (snapshot: TerminalSnapshot) => void
  onRename?: (title: string) => void
}

const announcedStates = new Set<TerminalSnapshot['state']>([
  'running',
  'exited',
  'interrupted',
  'failed'
])

const fallbackTerminalFontFamily = [
  '"Cascadia Mono"',
  '"Cascadia Code"',
  '"SFMono-Regular"',
  'Menlo',
  'Monaco',
  'Consolas',
  '"Noto Sans Mono"',
  '"DejaVu Sans Mono"',
  '"Liberation Mono"',
  'monospace'
].join(', ')

export function resolveTerminalFontFamily(): string {
  const configured = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-family-mono')
    .trim()
  return configured || fallbackTerminalFontFamily
}

function createDefaultTerminal(): TerminalFactoryResult {
  const terminal = new Terminal({
    cursorBlink: true,
    scrollback: 10_000,
    fontFamily: resolveTerminalFontFamily(),
    fontSize: 13,
    rescaleOverlappingGlyphs: true
  })
  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  return {
    terminal,
    fitAddon,
    searchAddon,
    activateRenderer: () => {
      const webglAddon = new WebglAddon()
      const contextLossSubscription = webglAddon.onContextLoss(() => {
        contextLossSubscription.dispose()
        webglAddon.dispose()
      })
      try {
        terminal.loadAddon(webglAddon)
      } catch {
        contextLossSubscription.dispose()
        webglAddon.dispose()
      }
    }
  }
}

function failureMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : fallback
}

function isValidSize(
  cols: number,
  rows: number
): boolean {
  return cols >= 2 && rows >= 1
}

export function TerminalPanel({
  adapter,
  target,
  sessionId,
  title,
  terminalFactory = createDefaultTerminal,
  onSessionChange,
  onRename
}: TerminalPanelProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const searchInputId = useId()
  const titleInputId = useId()
  const hostRef = useRef<HTMLDivElement>(null)
  const emulatorRef = useRef<TerminalEmulator | undefined>(undefined)
  const fitAddonRef = useRef<TerminalFitAddon | undefined>(undefined)
  const searchAddonRef = useRef<TerminalSearchAddon | undefined>(
    undefined
  )
  const activeSessionRef = useRef<TerminalSessionId | undefined>(
    undefined
  )
  const snapshotRef = useRef<TerminalSnapshot | undefined>(undefined)
  const mountedRef = useRef(false)
  const acceptedSequenceRef = useRef(0)
  const eventQueueRef = useRef(Promise.resolve())
  const lastSizeRef = useRef<
    { cols: number; rows: number } | undefined
  >(undefined)
  const operationGenerationRef = useRef(0)
  const onSessionChangeRef = useRef(onSessionChange)
  const onRenameRef = useRef(onRename)
  const translationRef = useRef(t)
  const [snapshot, setSnapshot] = useState<
    TerminalSnapshot | undefined
  >(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [announcement, setAnnouncement] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title ?? '')
  const [hasMeasuredSize, setHasMeasuredSize] = useState(false)

  useLayoutEffect(() => {
    onSessionChangeRef.current = onSessionChange
    onRenameRef.current = onRename
    translationRef.current = t
  }, [onRename, onSessionChange, t])

  const publishSnapshot = useCallback((next: TerminalSnapshot): void => {
    snapshotRef.current = next
    setSnapshot(next)
    onSessionChangeRef.current?.(next)
    if (announcedStates.has(next.state)) {
      setAnnouncement(
        translationRef.current(
          `sidebar.terminal.states.${next.state}`
        )
      )
    }
  }, [])

  const consumeEvent = useCallback(
    async (event: TerminalEvent): Promise<void> => {
      if (
        !mountedRef.current ||
        event.sessionId !== activeSessionRef.current ||
        event.sequence <= acceptedSequenceRef.current
      ) {
        return
      }
      acceptedSequenceRef.current = event.sequence

      if (event.type === 'output') {
        await new Promise<void>((resolve) => {
          emulatorRef.current?.write(event.data, resolve)
          if (!emulatorRef.current) {
            resolve()
          }
        })
      } else {
        const current = snapshotRef.current
        if (current) {
          if (event.type === 'state') {
            publishSnapshot({ ...current, state: event.state })
          } else if (event.type === 'exit') {
            publishSnapshot({
              ...current,
              state: 'exited',
              exit: event.exit,
              error: null
            })
          } else {
            publishSnapshot({
              ...current,
              state: 'failed',
              error: event.error,
              exit: null
            })
            setError(event.error.message)
          }
        }
      }

      if (mountedRef.current) {
        try {
          await adapter.ack({
            sessionId: event.sessionId,
            sequence: event.sequence
          })
        } catch (reason) {
          if (mountedRef.current) {
            setError(
              failureMessage(
                reason,
                translationRef.current('sidebar.terminal.errors.ack')
              )
            )
          }
        }
      }
    },
    [adapter, publishSnapshot]
  )

  useEffect(() => {
    mountedRef.current = true
    const {
      terminal,
      fitAddon,
      searchAddon,
      activateRenderer
    } = terminalFactory()
    emulatorRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon
    if (hostRef.current) {
      terminal.open(hostRef.current)
      activateRenderer?.()
    }

    const inputSubscription = terminal.onData((data) => {
      const current = snapshotRef.current
      if (!current || current.state !== 'running') {
        return
      }
      void adapter
        .write({ sessionId: current.sessionId, data })
        .catch((reason: unknown) => {
          if (mountedRef.current) {
            setError(
              failureMessage(
                reason,
                translationRef.current('sidebar.terminal.errors.write')
              )
            )
          }
        })
    })
    const unsubscribe = adapter.subscribe((event) => {
      eventQueueRef.current = eventQueueRef.current.then(
        () => consumeEvent(event),
        () => consumeEvent(event)
      )
    })

    return () => {
      mountedRef.current = false
      operationGenerationRef.current += 1
      unsubscribe()
      inputSubscription.dispose()
      terminal.dispose()
      emulatorRef.current = undefined
      fitAddonRef.current = undefined
      searchAddonRef.current = undefined
    }
  }, [adapter, consumeEvent, terminalFactory])

  const attachSession = useCallback(
    async (
      id: TerminalSessionId,
      generation: number
    ): Promise<void> => {
      try {
        const next = await adapter.getSnapshot({ sessionId: id })
        if (
          !mountedRef.current ||
          operationGenerationRef.current !== generation
        ) {
          return
        }
        activeSessionRef.current = next.sessionId
        acceptedSequenceRef.current = next.lastSequence
        publishSnapshot(next)
        setError(next.error?.message)
        emulatorRef.current?.focus()
      } catch (reason) {
        if (
          mountedRef.current &&
          operationGenerationRef.current === generation
        ) {
          setError(
            failureMessage(
              reason,
              translationRef.current('sidebar.terminal.errors.snapshot')
            )
          )
          setAnnouncement(
            translationRef.current('sidebar.terminal.states.failed')
          )
        }
      }
    },
    [adapter, publishSnapshot]
  )

  useEffect(() => {
    if (!sessionId) {
      return
    }
    const generation = ++operationGenerationRef.current
    void attachSession(sessionId, generation)
  }, [attachSession, sessionId])

  const createSession = useCallback(
    async (cols: number, rows: number): Promise<void> => {
      const generation = ++operationGenerationRef.current
      setError(undefined)
      try {
        const next = await adapter.create({ target, cols, rows })
        if (
          !mountedRef.current ||
          operationGenerationRef.current !== generation
        ) {
          try {
            await adapter.close({ sessionId: next.sessionId })
          } catch {
            // The owning tab is gone; Main shutdown cleanup remains the fallback.
          }
          return
        }
        activeSessionRef.current = next.sessionId
        acceptedSequenceRef.current = 0
        publishSnapshot(next)
        setError(next.error?.message)
        emulatorRef.current?.focus()
      } catch (reason) {
        if (
          mountedRef.current &&
          operationGenerationRef.current === generation
        ) {
          setError(
            failureMessage(
              reason,
              translationRef.current('sidebar.terminal.errors.create')
            )
          )
          setAnnouncement(
            translationRef.current('sidebar.terminal.states.failed')
          )
        }
      }
    },
    [adapter, publishSnapshot, target]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (
        !entry ||
        entry.contentRect.width <= 0 ||
        entry.contentRect.height <= 0
      ) {
        return
      }
      fitAddonRef.current?.fit()
      const emulator = emulatorRef.current
      if (
        !emulator ||
        !isValidSize(emulator.cols, emulator.rows)
      ) {
        return
      }
      const size = { cols: emulator.cols, rows: emulator.rows }
      if (
        lastSizeRef.current?.cols === size.cols &&
        lastSizeRef.current.rows === size.rows
      ) {
        return
      }
      lastSizeRef.current = size
      setHasMeasuredSize(true)

      const current = snapshotRef.current
      if (!current && !sessionId) {
        void createSession(size.cols, size.rows)
        return
      }
      if (current && current.state === 'running') {
        void adapter
          .resize({ sessionId: current.sessionId, ...size })
          .catch((reason: unknown) => {
            if (mountedRef.current) {
              setError(
                failureMessage(
                  reason,
                  translationRef.current(
                    'sidebar.terminal.errors.resize'
                  )
                )
              )
            }
          })
      }
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [adapter, createSession, sessionId])

  const runSearch = (): void => {
    if (searchTerm) {
      searchAddonRef.current?.findNext(searchTerm)
      emulatorRef.current?.focus()
    }
  }

  const copySelection = async (): Promise<void> => {
    const value = emulatorRef.current?.getSelection() ?? ''
    if (!value) {
      return
    }
    try {
      await navigator.clipboard.writeText(value)
    } catch (reason) {
      setError(
        failureMessage(
          reason,
          translationRef.current('sidebar.terminal.errors.copy')
        )
      )
    }
  }

  const paste = async (): Promise<void> => {
    const current = snapshotRef.current
    if (!current || current.state !== 'running') {
      return
    }
    try {
      const data = await navigator.clipboard.readText()
      if (data) {
        await adapter.write({ sessionId: current.sessionId, data })
      }
      emulatorRef.current?.focus()
    } catch (reason) {
      setError(
        failureMessage(
          reason,
          translationRef.current('sidebar.terminal.errors.paste')
        )
      )
    }
  }

  const reopenSession = async (): Promise<void> => {
    const size = lastSizeRef.current
    if (!size) {
      return
    }
    const current = snapshotRef.current
    if (current) {
      try {
        await adapter.close({ sessionId: current.sessionId })
      } catch (reason) {
        if (mountedRef.current) {
          setError(
            failureMessage(
              reason,
              translationRef.current(
                'sidebar.terminal.errors.closePrevious'
              )
            )
          )
        }
        return
      }
    }
    if (!mountedRef.current) {
      return
    }
    emulatorRef.current?.clear()
    activeSessionRef.current = undefined
    acceptedSequenceRef.current = 0
    snapshotRef.current = undefined
    setSnapshot(undefined)
    setError(undefined)
    await createSession(size.cols, size.rows)
  }

  const submitRename = (): void => {
    const nextTitle = draftTitle.trim()
    if (!nextTitle) {
      return
    }
    onRenameRef.current?.(nextTitle)
    setRenaming(false)
    emulatorRef.current?.focus()
  }

  const canReopen =
    snapshot?.state === 'exited' ||
    snapshot?.state === 'interrupted' ||
    snapshot?.state === 'failed'
  const location =
    snapshot?.targetLabel ??
    (target.type === 'local'
      ? t('sidebar.terminal.location.local')
      : t('sidebar.terminal.location.target'))

  return (
    <section
      className="terminal-panel"
      aria-label={t('sidebar.terminal.ariaLabel', {
        title: title ?? location
      })}
    >
      <div
        className="terminal-panel__toolbar"
        role="toolbar"
        aria-label={t('sidebar.terminal.toolbar.ariaLabel')}
      >
        <button
          type="button"
          title={t('sidebar.terminal.toolbar.search')}
          aria-label={t('sidebar.terminal.toolbar.search')}
          aria-pressed={searchOpen}
          onClick={() => setSearchOpen((value) => !value)}
        >
          <Search aria-hidden="true" />
        </button>
        <button
          type="button"
          title={t('sidebar.terminal.toolbar.copy')}
          aria-label={t('sidebar.terminal.toolbar.copy')}
          onClick={() => void copySelection()}
        >
          <Copy aria-hidden="true" />
        </button>
        <button
          type="button"
          title={t('sidebar.terminal.toolbar.paste')}
          aria-label={t('sidebar.terminal.toolbar.paste')}
          disabled={snapshot?.state !== 'running'}
          onClick={() => void paste()}
        >
          <Clipboard aria-hidden="true" />
        </button>
        <button
          type="button"
          title={t('sidebar.terminal.toolbar.selectAll')}
          aria-label={t('sidebar.terminal.toolbar.selectAllAriaLabel')}
          onClick={() => emulatorRef.current?.selectAll()}
        >
          {t('sidebar.terminal.toolbar.selectAll')}
        </button>
        <button
          type="button"
          title={t('sidebar.terminal.toolbar.clear')}
          aria-label={t('sidebar.terminal.toolbar.clear')}
          onClick={() => {
            emulatorRef.current?.clear()
            emulatorRef.current?.focus()
          }}
        >
          <Eraser aria-hidden="true" />
        </button>
        {onRename ? (
          <button
            type="button"
            title={t('sidebar.terminal.toolbar.rename')}
            aria-label={t('sidebar.terminal.toolbar.rename')}
            aria-pressed={renaming}
            onClick={() => {
              setDraftTitle(title ?? snapshot?.title ?? '')
              setRenaming(true)
            }}
          >
            <Pencil aria-hidden="true" />
          </button>
        ) : null}
        <span className="terminal-panel__toolbar-spacer" />
        {canReopen ? (
          <button
            type="button"
            className="terminal-panel__reopen"
            onClick={() => void reopenSession()}
          >
            <RefreshCw aria-hidden="true" />
            {snapshot.state === 'interrupted'
              ? t('sidebar.terminal.reopen.interrupted')
              : t('sidebar.terminal.reopen.default')}
          </button>
        ) : null}
      </div>

      {searchOpen ? (
        <form
          className="terminal-panel__inline-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            runSearch()
          }}
        >
          <label htmlFor={searchInputId}>
            {t('sidebar.terminal.search.label')}
          </label>
          <input
            id={searchInputId}
            autoFocus
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchOpen(false)
                emulatorRef.current?.focus()
              }
            }}
          />
          <button type="submit">
            {t('sidebar.terminal.search.next')}
          </button>
        </form>
      ) : null}

      {renaming ? (
        <form
          className="terminal-panel__inline-form"
          onSubmit={(event) => {
            event.preventDefault()
            submitRename()
          }}
        >
          <label htmlFor={titleInputId}>
            {t('sidebar.terminal.rename.label')}
          </label>
          <input
            id={titleInputId}
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setRenaming(false)
                emulatorRef.current?.focus()
              }
            }}
          />
          <button type="submit" disabled={!draftTitle.trim()}>
            {t('sidebar.terminal.rename.save')}
          </button>
          <button type="button" onClick={() => setRenaming(false)}>
            {t('sidebar.terminal.rename.cancel')}
          </button>
        </form>
      ) : null}

      {error ? (
        <div className="terminal-panel__error" role="alert">
          <span>{error}</span>
          {!snapshot ? (
            <button
              type="button"
              disabled={!hasMeasuredSize}
              onClick={() => void reopenSession()}
            >
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={hostRef}
        className="terminal-panel__emulator"
        aria-label={t('sidebar.terminal.status.emulatorAriaLabel')}
      />

      <footer
        className="terminal-panel__status"
        aria-label={t('sidebar.terminal.status.ariaLabel')}
      >
        <span title={location}>{location}</span>
        <span
          title={
            snapshot?.workingDirectory ??
            t('sidebar.terminal.status.readingDirectory')
          }
        >
          {snapshot?.workingDirectory ??
            t('sidebar.terminal.status.readingDirectory')}
        </span>
        <span
          title={
            snapshot?.shell ??
            t('sidebar.terminal.status.readingShell')
          }
        >
          {snapshot?.shell ??
            t('sidebar.terminal.status.readingShell')}
        </span>
        <strong
          data-state={snapshot?.state ?? (error ? 'failed' : 'starting')}
        >
          {snapshot
            ? t(`sidebar.terminal.states.${snapshot.state}`)
            : error
              ? t('sidebar.terminal.states.failed')
              : t('sidebar.terminal.states.creating')}
          {snapshot?.state === 'exited' && snapshot.exit?.exitCode !== null
            ? t('sidebar.terminal.status.exitCode', {
                code: snapshot.exit?.exitCode
              })
            : ''}
        </strong>
      </footer>
      <div className="terminal-panel__announcement" aria-live="polite">
        {announcement}
      </div>
    </section>
  )
}
