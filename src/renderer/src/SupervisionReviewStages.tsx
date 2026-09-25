import { useTranslation } from 'react-i18next'
import type { SupervisionActivity } from '../../shared/supervision-contracts'

const phases = ['collecting', 'extracting', 'summarizing', 'saving'] as const

export function SupervisionReviewStages({ row }: { row: SupervisionActivity }) {
  const { t } = useTranslation('heartbeat')
  const progress = row.reviewProgress!
  const current = progress.phase ? phases.indexOf(progress.phase) : -1
  return <div className="supervisor-activity__workflow">
    <ol className="supervisor-activity__steps" aria-label={t('activity.stages')}>
      {phases.map((phase, index) => {
        // Source coverage is not publication. Historical runs may have no saved phase.
        const state = progress.complete ? (row.supervisionStatus === 'no_change' && index > 0 ? 'skipped' : 'completed')
          : index === 0 && current !== 0 ? 'completed'
            : current > index ? 'completed'
              : current === index ? (row.supervisionStatus ?? row.status)
                : current < 0 ? 'unknown' : 'pending'
        return <li key={phase} data-phase={phase} data-state={state} aria-current={current === index && !progress.complete ? 'step' : undefined}>
          <span className="supervisor-activity__step-number" aria-hidden="true">{index + 1}</span>
          <span><strong>{t(`activity.phases.${phase}`)}</strong><small>{t(`activity.stageStates.${state}`)}</small></span>
        </li>
      })}
    </ol>
    <p className="supervisor-activity__coverage">{t('reviewSettings.progress', { batches: progress.batches, characters: progress.characters, remaining: progress.remainingSources })}</p>
    {progress.navigationNodes !== undefined && <p className="supervisor-activity__note">{t('activity.navigationSaved', { count: progress.navigationNodes })}</p>}
    {!progress.complete && !progress.phase && <p className="supervisor-activity__note">{t('activity.stageUnknown')}</p>}
    {row.supervisionStatus === 'running' && <p className="supervisor-activity__note">{t('reviewSettings.inFlight', { count: progress.inFlight ?? 0 })}</p>}
  </div>
}
