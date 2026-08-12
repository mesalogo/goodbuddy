import { Sparkles, Wrench, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type {
  ReleaseNote,
  ReleaseNotesSnapshot
} from '../../shared/release-notes-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import type { UiLocale } from './i18n'

type ReleaseNotesDialogProps = {
  locale: UiLocale
  snapshot: ReleaseNotesSnapshot
  onAcknowledge: (version: string) => Promise<void>
  onClose: () => void
}

function ReleaseSection({
  locale,
  release,
  showVersion
}: {
  locale: UiLocale
  release: ReleaseNote
  showVersion: boolean
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const notes = release.notes[locale]
  const releaseHeadingId = useId()
  const SectionHeading = showVersion ? 'h4' : 'h3'
  return (
    <section
      aria-labelledby={showVersion ? releaseHeadingId : undefined}
      className="release-notes-dialog__release"
    >
      {showVersion && (
        <h3
          className="release-notes-dialog__version"
          id={releaseHeadingId}
        >
          GoodBuddy {release.version}
        </h3>
      )}
      {notes.features.length > 0 && (
        <div className="release-notes-dialog__section">
          <SectionHeading>
            <Sparkles aria-hidden="true" size={16} />
            {t('releaseNotes.features')}
          </SectionHeading>
          <ul>
            {notes.features.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </div>
      )}
      {notes.fixes.length > 0 && (
        <div className="release-notes-dialog__section">
          <SectionHeading>
            <Wrench aria-hidden="true" size={16} />
            {t('releaseNotes.fixes')}
          </SectionHeading>
          <ul>
            {notes.fixes.map((fix) => (
              <li key={fix}>{fix}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export function ReleaseNotesDialog({
  locale,
  snapshot,
  onAcknowledge,
  onClose
}: ReleaseNotesDialogProps): React.JSX.Element {
  const { t } = useTranslation('app')
  const dialogRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState<string>()
  const titleId = useId()
  const descriptionId = useId()

  useEffect(
    () =>
      activateModalFocus(
        () => dialogRef.current?.querySelector<HTMLElement>('button') ?? null
      ),
    []
  )

  const close = async (): Promise<void> => {
    if (closing) {
      return
    }
    setClosing(true)
    setError(undefined)
    try {
      await onAcknowledge(snapshot.currentVersion)
      onClose()
    } catch {
      setError(t('releaseNotes.acknowledgeFailed'))
      setClosing(false)
    }
  }

  return createPortal(
    <div className="release-notes-backdrop">
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="release-notes-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !closing) {
            event.preventDefault()
            void close()
            return
          }
          trapTabFocus(event, dialogRef.current)
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="release-notes-dialog__header">
          <div>
            <span className="release-notes-dialog__eyebrow">
              {t('releaseNotes.eyebrow')}
            </span>
            <h2 id={titleId}>
              {t('releaseNotes.title', {
                version: snapshot.currentVersion
              })}
            </h2>
            <p id={descriptionId}>{t('releaseNotes.description')}</p>
          </div>
          <button
            aria-label={t('releaseNotes.close')}
            className="icon-button"
            disabled={closing}
            onClick={() => void close()}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="release-notes-dialog__content">
          {snapshot.releases.map((release) => (
            <ReleaseSection
              key={release.version}
              locale={locale}
              release={release}
              showVersion={snapshot.releases.length > 1}
            />
          ))}
        </div>
        <footer className="release-notes-dialog__footer">
          {error && <p role="alert">{error}</p>}
          <button
            autoFocus
            className="primary-button"
            disabled={closing}
            onClick={() => void close()}
            type="button"
          >
            {closing
              ? t('releaseNotes.closing')
              : t('releaseNotes.start')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
