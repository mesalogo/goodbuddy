import { Download, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CapabilityAssignments,
  CapabilitySnapshot,
  RuntimeTarget
} from '../../shared/capability-contracts'
import { SettingsCategoryHeader } from './SettingsPrimitives'

export function SkillsSettingsSection(): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    void window.goodbuddy.capabilities
      .getSnapshot()
      .then(setSnapshot)
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error
            ? reason.message
            : t('skills.errors.readFailed')
        )
      })
  }, [t])

  const run = async (
    key: string,
    operation: () => Promise<CapabilitySnapshot>
  ): Promise<void> => {
    setBusy(key)
    setError(undefined)
    try {
      setSnapshot(await operation())
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('skills.errors.operationFailed')
      )
    } finally {
      setBusy(undefined)
    }
  }

  const updateAssignment = (
    skillId: string,
    assignments: CapabilityAssignments,
    target: RuntimeTarget,
    enabled: boolean
  ): void => {
    const next = enabled
      ? [...assignments, target]
      : assignments.filter((item) => item !== target)
    void run(`assign:${skillId}`, () =>
      window.goodbuddy.capabilities.setSkillAssignments(skillId, next)
    )
  }

  return (
    <>
      <SettingsCategoryHeader
        actions={
          <>
            <button
              className="secondary-button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run('import', () =>
                  window.goodbuddy.capabilities.importSkill('directory')
                )
              }
              type="button"
            >
              <Download aria-hidden="true" size={14} />
              {t('skills.actions.importDirectory')}
            </button>
            <button
              className="secondary-button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run('import', () =>
                  window.goodbuddy.capabilities.importSkill('zip')
                )
              }
              type="button"
            >
              <Download aria-hidden="true" size={14} />
              {t('skills.actions.importZip')}
            </button>
          </>
        }
        category="skills"
        error={error}
        headingId="skills-settings-heading"
      />
      <section
        aria-label={t('skills.listLabel')}
        className="settings-section"
      >

      <p className="settings-notice">
        {t('skills.notice')}
      </p>
      {!snapshot && !error && (
        <p className="settings-empty">{t('skills.loading')}</p>
      )}
      <div className="capability-list">
        {snapshot?.skills.map((skill) => (
          <article className="capability-card" key={skill.id}>
            <div className="capability-card__header">
              <div>
                <strong>{skill.name}</strong>
                <small>
                  {skill.source === 'builtin'
                    ? t('skills.source.builtin')
                    : t('skills.source.imported')}{' '}
                  · {skill.version ?? t('skills.versionMissing')}
                </small>
              </div>
              <label className="capability-switch">
                <input
                  aria-label={t('skills.enableAria', {
                    name: skill.name
                  })}
                  checked={skill.enabled}
                  disabled={Boolean(busy)}
                  onChange={(event) =>
                    void run(`toggle:${skill.id}`, () =>
                      window.goodbuddy.capabilities.setSkillEnabled(
                        skill.id,
                        event.target.checked
                      )
                    )
                  }
                  type="checkbox"
                />
                <span>
                  {skill.enabled
                    ? t('skills.enabled')
                    : t('skills.disabled')}
                </span>
              </label>
            </div>
            <p>{skill.description}</p>
            <div className="capability-tags">
              {skill.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <div className="runtime-assignments">
              <small>{t('skills.assignedTo')}</small>
              {(['model', 'opencode', 'continue'] as RuntimeTarget[]).map(
                (target) => (
                  <label key={target}>
                    <input
                      checked={skill.assignments.includes(target)}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        updateAssignment(
                          skill.id,
                          skill.assignments,
                          target,
                          event.target.checked
                        )
                      }
                      type="checkbox"
                    />
                    {t(`skills.runtimeLabels.${target}`)}
                  </label>
                )
              )}
              {skill.source === 'imported' && (
                <button
                  aria-label={t('skills.deleteAria', {
                    name: skill.name
                  })}
                  className="capability-remove"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(`remove:${skill.id}`, () =>
                      window.goodbuddy.capabilities.removeSkill(skill.id)
                    )
                  }
                  type="button"
                >
                  <Trash2 size={13} />
                  {t('skills.actions.delete')}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      </section>
    </>
  )
}
