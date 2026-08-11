import { Bot, Plus, Save, Trash2 } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantExpert,
  ExpertCreateInput
} from '../../shared/assistant-contracts'
import type { ModelConnectionSettings } from '../../shared/contracts'
import { DestructiveConfirmActions } from './WorkspacePrimitives'

type ExpertDraft = Omit<ExpertCreateInput, 'routingKeywords'> & {
  id?: string
  routingKeywordsText: string
}

type RolePromptSettingsSectionProps = {
  onChanged: (experts: AssistantExpert[]) => void
  modelProfiles?: ReadonlyArray<
    Pick<ModelConnectionSettings, 'id' | 'name'>
  >
  defaultModelProfileId?: string
}

const emptyDraft: ExpertDraft = {
  name: '',
  description: '',
  systemInstructions: '',
  routingKeywordsText: ''
}

function draftFromExpert(
  expert: AssistantExpert,
  keywordSeparator: string
): ExpertDraft {
  return {
    id: expert.id,
    name: expert.name,
    description: expert.description,
    systemInstructions: expert.systemInstructions,
    modelProfileId: expert.modelProfileId,
    routingKeywordsText: (expert.routingKeywords ?? []).join(
      keywordSeparator
    )
  }
}

export function normalizeRoutingKeywords(value: string): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const keyword of value.split(/[,，\r\n]+/u)) {
    const normalizedKeyword = keyword
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLocaleLowerCase('zh-CN')
    if (normalizedKeyword && !seen.has(normalizedKeyword)) {
      seen.add(normalizedKeyword)
      normalized.push(normalizedKeyword)
    }
  }
  return normalized
}

function validateRoutingKeywords(
  keywords: readonly string[],
  t: TFunction<'settingsSections'>
): string | undefined {
  if (keywords.length > 32) {
    return t('roles.validation.tooManyKeywords')
  }
  const invalid = keywords.find(
    (keyword) => keyword.length < 2 || keyword.length > 48
  )
  return invalid
    ? t('roles.validation.invalidKeyword', {
        keyword: invalid.slice(0, 48)
      })
    : undefined
}

function sortExperts(
  experts: AssistantExpert[],
  locale: string
): AssistantExpert[] {
  return [...experts].sort((left, right) =>
    left.name.localeCompare(right.name, locale)
  )
}

export function RolePromptSettingsSection({
  onChanged,
  modelProfiles = [],
  defaultModelProfileId
}: RolePromptSettingsSectionProps): React.JSX.Element {
  const { i18n, t } = useTranslation('settingsSections')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const [initialLoadCopy] = useState(() => ({
    locale,
    readFailed: t('roles.errors.readFailed'),
    routingSeparator: t('roles.fields.routingSeparator')
  }))
  const [experts, setExperts] = useState<AssistantExpert[]>([])
  const sortedExperts = useMemo(
    () => sortExperts(experts, locale),
    [experts, locale]
  )
  const [selectedId, setSelectedId] = useState<string>()
  const [draft, setDraft] = useState<ExpertDraft>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [routingKeywordsError, setRoutingKeywordsError] =
    useState<string>()
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  useEffect(() => {
    void window.goodbuddy.experts
      .list()
      .then((items) => {
        const sorted = sortExperts(
          items,
          initialLoadCopy.locale
        )
        setExperts(sorted)
        if (sorted[0]) {
          setSelectedId(sorted[0].id)
          setDraft(
            draftFromExpert(
              sorted[0],
              initialLoadCopy.routingSeparator
            )
          )
        }
      })
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error
            ? reason.message
            : initialLoadCopy.readFailed
        )
      })
  }, [initialLoadCopy])

  const selectExpert = (expert: AssistantExpert): void => {
    setSelectedId(expert.id)
    setDraft(
      draftFromExpert(expert, t('roles.fields.routingSeparator'))
    )
    setConfirmingRemove(false)
    setError(undefined)
    setRoutingKeywordsError(undefined)
  }

  const createDraft = (): void => {
    setSelectedId(undefined)
    setDraft({ ...emptyDraft })
    setConfirmingRemove(false)
    setError(undefined)
    setRoutingKeywordsError(undefined)
  }

  const save = async (): Promise<void> => {
    if (!draft) {
      return
    }
    setBusy(true)
    setError(undefined)
    const routingKeywords = normalizeRoutingKeywords(
      draft.routingKeywordsText
    )
    const keywordError = validateRoutingKeywords(routingKeywords, t)
    if (keywordError) {
      setRoutingKeywordsError(keywordError)
      setBusy(false)
      return
    }
    setRoutingKeywordsError(undefined)
    try {
      const input: ExpertCreateInput = {
        name: draft.name,
        description: draft.description,
        systemInstructions: draft.systemInstructions,
        routingKeywords,
        ...(draft.modelProfileId
          ? { modelProfileId: draft.modelProfileId }
          : {})
      }
      const saved = draft.id
        ? await window.goodbuddy.experts.update(draft.id, input)
        : await window.goodbuddy.experts.create(input)
      const next = sortExperts(
        draft.id
          ? experts.map((expert) =>
              expert.id === saved.id ? saved : expert
            )
          : [...experts, saved],
        locale
      )
      setExperts(next)
      setSelectedId(saved.id)
      setDraft(
        draftFromExpert(saved, t('roles.fields.routingSeparator'))
      )
      onChanged(next)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('roles.errors.saveFailed')
      )
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!draft?.id) {
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await window.goodbuddy.experts.remove(draft.id)
      const next = experts.filter((expert) => expert.id !== draft.id)
      setExperts(next)
      setConfirmingRemove(false)
      if (next[0]) {
        setSelectedId(next[0].id)
        setDraft(
          draftFromExpert(
            next[0],
            t('roles.fields.routingSeparator')
          )
        )
      } else {
        setSelectedId(undefined)
        setDraft(undefined)
      }
      onChanged(next)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('roles.errors.deleteFailed')
      )
    } finally {
      setBusy(false)
    }
  }

  const defaultModelProfile = modelProfiles.find(
    (profile) => profile.id === defaultModelProfileId
  )
  const selectedModelProfileAvailable =
    !draft?.modelProfileId ||
    modelProfiles.some(
      (profile) => profile.id === draft.modelProfileId
    )
  const inheritedModelLabel = defaultModelProfile
    ? t('roles.fields.inheritDefaultNamed', {
        name: defaultModelProfile.name
      })
    : t('roles.fields.inheritDefault')

  return (
    <div className="settings-section">
      <div className="settings-section__title settings-section__title--actions">
        <Bot size={17} />
        <div>
          <strong>{t('roles.title')}</strong>
          <small>{t('roles.description')}</small>
        </div>
        <button
          className="secondary-button role-prompt-add"
          disabled={busy}
          onClick={createDraft}
          type="button"
        >
          <Plus size={14} />
          {t('roles.newRole')}
        </button>
      </div>

      <p className="settings-notice">
        {t('roles.notice')}
      </p>
      {error && <p className="settings-warning" role="alert">{error}</p>}

      <div className="model-connection-manager role-prompt-manager">
        <aside
          aria-label={t('roles.listLabel')}
          className="model-connection-list"
        >
          <div className="model-connection-list__header">
            <strong>{t('roles.listTitle')}</strong>
            <span>{sortedExperts.length}</span>
          </div>
          <div role="list">
            {sortedExperts.map((expert) => (
              <div key={expert.id} role="listitem">
                <button
                  aria-current={
                    selectedId === expert.id ? 'page' : undefined
                  }
                  aria-label={t('roles.editRole', {
                    name: expert.name
                  })}
                  onClick={() => selectExpert(expert)}
                  type="button"
                >
                  <span className="model-connection-list__name">
                    <strong>{expert.name}</strong>
                    <small>
                      {expert.description || t('roles.noDescription')}
                    </small>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </aside>

        {draft ? (
          <div className="model-connection-detail role-prompt-detail">
            <div className="settings-section__title">
              <div>
                <strong>
                  {draft.id ? draft.name : t('roles.newRole')}
                </strong>
                <small>{t('roles.details')}</small>
              </div>
            </div>
            <label className="field">
              <span>{t('roles.fields.name')}</span>
              <input
                maxLength={80}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                value={draft.name}
              />
            </label>
            <label className="field">
              <span>{t('roles.fields.description')}</span>
              <textarea
                maxLength={500}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    description: event.target.value
                  })
                }
                rows={3}
                value={draft.description}
              />
            </label>
            <label className="field">
              <span>{t('roles.fields.systemPrompt')}</span>
              <textarea
                aria-label={t('roles.fields.systemPrompt')}
                aria-describedby="role-system-prompt-help"
                className="role-prompt-detail__prompt"
                maxLength={20_000}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    systemInstructions: event.target.value
                  })
                }
                rows={12}
                value={draft.systemInstructions}
              />
              <small id="role-system-prompt-help">
                {t('roles.fields.systemPromptHelp', {
                  count: draft.systemInstructions.length.toLocaleString(
                    locale
                  )
                })}
              </small>
            </label>
            <label className="field">
              <span>{t('roles.fields.modelConnection')}</span>
              <select
                aria-describedby={
                  selectedModelProfileAvailable
                    ? 'role-model-profile-help'
                    : 'role-model-profile-fallback role-model-profile-help'
                }
                aria-label={t('roles.fields.modelConnectionAria')}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    modelProfileId: event.target.value || undefined
                  })
                }
                value={draft.modelProfileId ?? ''}
              >
                <option value="">{inheritedModelLabel}</option>
                {!selectedModelProfileAvailable &&
                  draft.modelProfileId && (
                    <option disabled value={draft.modelProfileId}>
                      {t('roles.fields.unavailableConnection')}
                    </option>
                  )}
                {modelProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <small id="role-model-profile-help">
                {t('roles.fields.modelHelp')}
              </small>
              {!selectedModelProfileAvailable && (
                <small
                  className="field-error"
                  id="role-model-profile-fallback"
                  role="status"
                >
                  {defaultModelProfile
                    ? t('roles.fields.modelFallbackNamed', {
                        name: defaultModelProfile.name
                      })
                    : t('roles.fields.modelFallback')}
                </small>
              )}
            </label>
            <label className="field">
              <span>{t('roles.fields.routingKeywords')}</span>
              <textarea
                aria-describedby={
                  routingKeywordsError
                    ? 'role-routing-keywords-error role-routing-keywords-help'
                    : 'role-routing-keywords-help'
                }
                aria-invalid={routingKeywordsError ? 'true' : undefined}
                aria-label={t('roles.fields.routingKeywords')}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    routingKeywordsText: event.target.value
                  })
                  setRoutingKeywordsError(undefined)
                }}
                placeholder={t('roles.fields.routingPlaceholder')}
                rows={3}
                value={draft.routingKeywordsText}
              />
              <small id="role-routing-keywords-help">
                {t('roles.fields.routingHelp')}
              </small>
              {routingKeywordsError && (
                <small
                  className="field-error"
                  id="role-routing-keywords-error"
                  role="alert"
                >
                  {routingKeywordsError}
                </small>
              )}
            </label>
            <div className="role-prompt-detail__actions">
              {draft.id ? (
                <DestructiveConfirmActions
                  confirmAriaLabel={t('roles.delete.confirmAria', {
                    name: draft.name
                  })}
                  confirmLabel={t('roles.delete.label')}
                  confirming={confirmingRemove}
                  disabled={busy}
                  icon={<Trash2 size={13} />}
                  message={t('roles.delete.message')}
                  onCancel={() => setConfirmingRemove(false)}
                  onConfirm={() => void remove()}
                  onRequestConfirm={() => setConfirmingRemove(true)}
                  triggerAriaLabel={t('roles.delete.triggerAria', {
                    name: draft.name
                  })}
                  triggerLabel={t('roles.delete.label')}
                />
              ) : (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    const first = sortedExperts[0]
                    if (first) {
                      selectExpert(first)
                    } else {
                      setDraft(undefined)
                    }
                  }}
                  type="button"
                >
                  {t('roles.actions.cancel')}
                </button>
              )}
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void save()}
                type="button"
              >
                <Save size={14} />
                {busy
                  ? t('roles.actions.saving')
                  : draft.id
                    ? t('roles.actions.save')
                    : t('roles.actions.create')}
              </button>
            </div>
          </div>
        ) : (
          <p className="settings-empty role-prompt-empty">
            {t('roles.empty')}
          </p>
        )}
      </div>
    </div>
  )
}
