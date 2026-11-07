import { Library } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChannelIcon } from './ChannelIcon'
import { useMessageExpansion } from './message-expansion'
import { referenceKey, type ExternalDocumentReference } from './external-references'
import './external-references.css'

export function MessageDocumentReferences({ references }: { references: readonly ExternalDocumentReference[] }): React.JSX.Element | null {
  const { t } = useTranslation('app')
  const [expanded, setExpanded] = useMessageExpansion('document-references')
  if (!references.length) return null
  return (
    <details className="message-citations message-document-references" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{t('composer.references.messageSummary', { count: references.length })}</summary>
      <ol>
        {references.map(reference => (
          <li key={referenceKey(reference)}>
            <span className="message-document-references__title">
              {reference.provider === 'local' ? <Library aria-hidden="true" size={16} /> : <ChannelIcon channel={reference.provider} size={16} />}
              <strong>{reference.title}</strong>
            </span>
            <small>{t(`composer.references.providers.${reference.provider}`)}{reference.libraryName ? ` · ${reference.libraryName}` : ''}</small>
            {(reference.path || reference.url) && <small>{reference.path || reference.url}</small>}
          </li>
        ))}
      </ol>
    </details>
  )
}
