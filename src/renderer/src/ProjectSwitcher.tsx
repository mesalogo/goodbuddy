import {
  Archive,
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  Plus,
  RadioTower,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantProject,
  ProjectCreateInput,
  WorkMode
} from '../../shared/assistant-contracts'
import {
  interactiveWorkModes,
  normalizeInteractiveWorkMode,
  projectChannelLabels
} from '../../shared/assistant-contracts'
import type { RuntimeSettings } from '../../shared/contracts'
import { trapTabFocus } from './dialog-focus'
import {
  getDefaultRuntimeSelection,
  getRuntimeSelectionForProvider
} from './runtime-selection'
import {
  channelProjectDraft,
  ChannelProjectSettingsFields
} from './ChannelProjectSettingsFields'

type ProjectSwitcherProps = {
  projects: AssistantProject[]
  activeProjectId: string
  runtimeSettings?: RuntimeSettings
  onArchive: (projectId: string) => Promise<void>
  onCreate: (input: ProjectCreateInput) => Promise<AssistantProject>
  onDelete: (projectId: string, confirmation: string) => Promise<void>
  onSelect: (projectId: string) => void
  onSelectRoot: () => Promise<string | undefined>
  onUpdate: (
    projectId: string,
    input: ProjectCreateInput
  ) => Promise<AssistantProject>
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  runtimeSettings,
  onArchive,
  onCreate,
  onDelete,
  onSelect,
  onSelectRoot,
  onUpdate
}: ProjectSwitcherProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const [dialogMode, setDialogMode] = useState<
    'create' | 'settings'
  >()
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [error, setError] = useState<string>()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const projectPickerRef = useRef<HTMLDivElement>(null)
  const projectPickerButtonRef = useRef<HTMLButtonElement>(null)
  const projectPickerMenuRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusTarget = useRef<
    'create' | 'settings' | undefined
  >(undefined)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [draft, setDraft] = useState<ProjectCreateInput>({
    name: '',
    description: '',
    rootPath: '',
    defaultWorkMode: 'ask'
  })
  const activeProject = projects.find(
    (project) => project.id === activeProjectId
  )
  const userProjects = projects.filter(
    (project) => project.kind === 'user'
  )
  const channelProjects = projects.filter(
    (project) => project.kind === 'channel'
  )
  const busy = saving || archiving || deleting

  useEffect(() => {
    if (!projectMenuOpen) {
      return
    }
    const focusFrame = requestAnimationFrame(() => {
      const items = Array.from(
        projectPickerMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]'
        ) ?? []
      )
      const initialItem =
        items.find((item) => item.getAttribute('aria-checked') === 'true') ??
        items[0]
      initialItem?.focus()
    })
    const closeOutside = (event: Event): void => {
      if (
        event.target instanceof Node &&
        !projectPickerRef.current?.contains(event.target)
      ) {
        setProjectMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [projectMenuOpen])

  useEffect(() => {
    if (!dialogMode) {
      if (restoreFocusTarget.current === 'create') {
        createButtonRef.current?.focus()
      } else if (restoreFocusTarget.current === 'settings') {
        settingsButtonRef.current?.focus()
      }
      restoreFocusTarget.current = undefined
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        setError(undefined)
        setConfirmingDelete(false)
        setDeleteConfirmation('')
        setDialogMode(undefined)
        return
      }
      trapTabFocus(event, dialogRef.current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, dialogMode])

  const closeDialog = (): void => {
    setError(undefined)
    setConfirmingDelete(false)
    setDeleteConfirmation('')
    setDialogMode(undefined)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const input =
        draft.runtimeSelection || !runtimeSettings
          ? draft
          : {
              ...draft,
              runtimeSelection: getDefaultRuntimeSelection(runtimeSettings)
            }
      if (dialogMode === 'settings' && activeProject) {
        await onUpdate(activeProject.id, input)
      } else {
        await onCreate(input)
      }
      closeDialog()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : dialogMode === 'settings'
            ? t('projectSwitcher.errors.save')
            : t('projectSwitcher.errors.create')
      )
    } finally {
      setSaving(false)
    }
  }

  const selectRoot = async (): Promise<void> => {
    setError(undefined)
    try {
      const rootPath = await onSelectRoot()
      if (rootPath) {
        setDraft((current) => ({
          ...current,
          rootPath
        }))
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('projectSwitcher.errors.selectRoot')
      )
    }
  }

  const archive = async (): Promise<void> => {
    setArchiving(true)
    setError(undefined)
    try {
      await onArchive(activeProjectId)
      closeDialog()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('projectSwitcher.errors.archive')
      )
    } finally {
      setArchiving(false)
    }
  }

  const deleteProject = async (): Promise<void> => {
    if (!activeProject) {
      return
    }
    setDeleting(true)
    setError(undefined)
    try {
      await onDelete(activeProject.id, deleteConfirmation)
      closeDialog()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('projectSwitcher.errors.delete')
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="project-switcher">
      <div className="project-switcher__row">
        <div
          className="project-switcher__picker"
          ref={projectPickerRef}
        >
          <button
            aria-expanded={projectMenuOpen}
            aria-haspopup="menu"
            aria-label={t('projectSwitcher.selector.ariaLabel')}
            className="project-switcher__trigger"
            onClick={() => setProjectMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (
                !projectMenuOpen &&
                (event.key === 'ArrowDown' ||
                  event.key === 'Enter' ||
                  event.key === ' ')
              ) {
                event.preventDefault()
                setProjectMenuOpen(true)
              }
            }}
            ref={projectPickerButtonRef}
            title={activeProject?.name}
            type="button"
          >
            <span>{activeProject?.name ?? t('projectSwitcher.selector.empty')}</span>
            <ChevronDown aria-hidden="true" size={14} />
          </button>
          {projectMenuOpen && (
            <div
              aria-label={t('projectSwitcher.selector.ariaLabel')}
              className="project-switcher__menu"
              onKeyDown={(event) => {
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitemradio"]'
                  )
                )
                const currentIndex = items.indexOf(
                  document.activeElement as HTMLButtonElement
                )
                let nextIndex: number | undefined
                if (event.key === 'ArrowDown') {
                  nextIndex = (currentIndex + 1) % items.length
                } else if (event.key === 'ArrowUp') {
                  nextIndex =
                    (currentIndex - 1 + items.length) % items.length
                } else if (event.key === 'Home') {
                  nextIndex = 0
                } else if (event.key === 'End') {
                  nextIndex = items.length - 1
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setProjectMenuOpen(false)
                  projectPickerButtonRef.current?.focus()
                }
                const nextItem =
                  nextIndex === undefined ? undefined : items.at(nextIndex)
                if (nextItem) {
                  event.preventDefault()
                  items.forEach((item) => {
                    item.tabIndex = item === nextItem ? 0 : -1
                  })
                  nextItem.focus()
                }
              }}
              ref={projectPickerMenuRef}
              role="menu"
            >
              {[
                {
                  projects: userProjects,
                  label: t('projectSwitcher.selector.userProjects'),
                  icon: Folder
                },
                {
                  projects: channelProjects,
                  label: t('projectSwitcher.selector.channelProjects'),
                  icon: RadioTower
                }
              ].map((group) =>
                group.projects.length > 0 ? (
                  <div
                    aria-label={group.label}
                    className="project-switcher__group"
                    key={group.label}
                    role="group"
                  >
                    <strong>{group.label}</strong>
                    {group.projects.map((project) => {
                      const selected = project.id === activeProjectId
                      const ProjectIcon = group.icon
                      const detail =
                        project.kind === 'channel'
                          ? t('projectSwitcher.selector.remoteDetail', {
                              channel: project.channel
                                ? projectChannelLabels[project.channel]
                                : t(
                                    'projectSwitcher.selector.remoteChannel'
                                  ),
                              path: project.rootPath
                            })
                          : t('projectSwitcher.selector.localDetail', {
                              path: project.rootPath
                            })
                      return (
                        <button
                          aria-checked={selected}
                          key={project.id}
                          onClick={() => {
                            if (!selected) {
                              onSelect(project.id)
                            }
                            setProjectMenuOpen(false)
                            requestAnimationFrame(() =>
                              projectPickerButtonRef.current?.focus()
                            )
                          }}
                          role="menuitemradio"
                          tabIndex={selected ? 0 : -1}
                          type="button"
                        >
                          <ProjectIcon aria-hidden="true" size={16} />
                          <span>
                            <b>{project.name}</b>
                            <small>{detail}</small>
                          </span>
                          {selected && (
                            <Check aria-hidden="true" size={14} />
                          )}
                        </button>
                      )
                    })}
                  </div>
                ) : null
              )}
            </div>
          )}
        </div>
        <button
          aria-label={t('projectSwitcher.selector.create')}
          className="icon-button"
          onClick={() => {
            setProjectMenuOpen(false)
            setError(undefined)
            setConfirmingDelete(false)
            setDeleteConfirmation('')
            setDraft({
              name: '',
              description: '',
              rootPath: '',
              defaultWorkMode: 'ask',
              runtimeSelection: runtimeSettings
                ? getDefaultRuntimeSelection(runtimeSettings)
                : undefined
            })
            restoreFocusTarget.current = 'create'
            setDialogMode('create')
          }}
          ref={createButtonRef}
          type="button"
        >
          <Plus size={15} />
        </button>
        <button
          aria-label={t('projectSwitcher.selector.settings')}
          className="icon-button"
          disabled={!activeProject}
          onClick={() => {
            if (!activeProject) {
              return
            }
            setProjectMenuOpen(false)
            setError(undefined)
            setConfirmingDelete(false)
            setDeleteConfirmation('')
            const nextDraft: ProjectCreateInput = {
              name: activeProject.name,
              description: activeProject.description,
              rootPath: activeProject.rootPath,
              defaultWorkMode: normalizeInteractiveWorkMode(
                activeProject.defaultWorkMode
              ),
              runtimeSelection:
                activeProject.runtimeSelection ??
                (runtimeSettings
                  ? getDefaultRuntimeSelection(runtimeSettings)
                  : undefined)
            }
            setDraft(
              activeProject.kind === 'channel' && runtimeSettings
                ? channelProjectDraft(nextDraft, runtimeSettings)
                : nextDraft
            )
            restoreFocusTarget.current = 'settings'
            setDialogMode('settings')
          }}
          ref={settingsButtonRef}
          type="button"
        >
          <Settings size={15} />
        </button>
      </div>
      {dialogMode && (
        <div
          className="project-create-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !busy) {
              closeDialog()
            }
          }}
        >
          <div
            aria-labelledby="project-dialog-title"
            aria-modal="true"
            className="project-create-card"
            ref={dialogRef}
            role="dialog"
          >
            <header>
              <strong id="project-dialog-title">
                {dialogMode === 'create'
                  ? t('projectSwitcher.dialog.createTitle')
                  : t('projectSwitcher.dialog.settingsTitle')}
              </strong>
              <button
                aria-label={
                  dialogMode === 'create'
                    ? t('projectSwitcher.dialog.closeCreate')
                    : t('projectSwitcher.dialog.closeSettings')
                }
                className="icon-button"
                disabled={busy}
                onClick={closeDialog}
                type="button"
              >
                <X size={14} />
              </button>
            </header>
            {dialogMode === 'settings' &&
            activeProject?.kind === 'channel' &&
            runtimeSettings ? (
              <ChannelProjectSettingsFields
                autoFocus
                disabled={busy}
                onChange={setDraft}
                onSelectRoot={() => void selectRoot()}
                runtimeSettings={runtimeSettings}
                value={draft}
                variant="dialog"
              />
            ) : (
              <>
              <label>
              <span>{t('projectSwitcher.dialog.fields.name')}</span>
              <input
                autoFocus={!confirmingDelete}
                disabled={busy}
                maxLength={120}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value
                  }))
                }
                value={draft.name}
              />
            </label>
            <label>
              <span>
                {t('projectSwitcher.dialog.fields.description')}
              </span>
              <textarea
                maxLength={2_000}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value
                  }))
                }
                rows={3}
                value={draft.description}
              />
            </label>
            <label>
              <span>
                {t('projectSwitcher.dialog.fields.rootPath')}
              </span>
              <div className="project-create-card__path">
                <input readOnly value={draft.rootPath} />
                <button
                  aria-label={t('projectSwitcher.dialog.selectRoot')}
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void selectRoot()}
                  type="button"
                >
                  <FolderOpen size={14} />
                </button>
              </div>
            </label>
            <label>
              <span>
                {t('projectSwitcher.dialog.fields.defaultMode')}
              </span>
              <select
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    defaultWorkMode: event.target.value as WorkMode
                  }))
                }
                value={draft.defaultWorkMode}
              >
                {interactiveWorkModes.map((value) => (
                  <option key={value} value={value}>
                    {t(`projectSwitcher.workModes.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            {runtimeSettings && (
              <label>
                <span>
                  {t('projectSwitcher.dialog.fields.defaultRuntime')}
                </span>
                <select
                  aria-label={t(
                    'projectSwitcher.dialog.fields.defaultRuntime'
                  )}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      runtimeSelection: getRuntimeSelectionForProvider(
                        event.target.value as
                          | 'model'
                          | 'opencode'
                          | 'continue',
                        runtimeSettings
                      )
                    }))
                  }
                  value={
                    draft.runtimeSelection?.provider === 'auto'
                      ? 'model'
                      : (draft.runtimeSelection?.provider ??
                        getDefaultRuntimeSelection(runtimeSettings)
                          .provider)
                  }
                >
                  <option value="model">
                    {t(
                      'projectSwitcher.dialog.runtimeOptions.direct'
                    )}
                  </option>
                  <option value="opencode">OpenCode</option>
                  <option value="continue">Continue</option>
                </select>
                <small>
                  {t('projectSwitcher.dialog.defaultRuntimeHelp')}
                </small>
              </label>
            )}
              </>
            )}
            {error && (
              <p className="project-create-card__error" role="alert">
                {error}
              </p>
            )}
            {dialogMode === 'settings' &&
              activeProject?.kind !== 'channel' && (
                <section
                  aria-labelledby="project-danger-title"
                  className="project-danger-zone"
                >
                  <div>
                    <strong id="project-danger-title">
                      {t('projectSwitcher.dialog.danger.title')}
                    </strong>
                    <p>
                      {t('projectSwitcher.dialog.danger.description')}
                    </p>
                  </div>
                  {!confirmingDelete ? (
                    <button
                      className="danger-button danger-button--quiet"
                      disabled={busy || userProjects.length <= 1}
                      onClick={() => {
                        setError(undefined)
                        setDeleteConfirmation('')
                        setConfirmingDelete(true)
                      }}
                      type="button"
                    >
                      <Trash2 size={13} />
                      {t('projectSwitcher.dialog.danger.delete')}
                    </button>
                  ) : (
                    <div className="project-delete-confirmation">
                      <label>
                        <span>
                          {t(
                            'projectSwitcher.dialog.danger.confirmation',
                            { projectName: activeProject?.name }
                          )}
                        </span>
                        <input
                          autoFocus
                          disabled={busy}
                          onChange={(event) =>
                            setDeleteConfirmation(event.target.value)
                          }
                          value={deleteConfirmation}
                        />
                      </label>
                      <div>
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => {
                            setError(undefined)
                            setDeleteConfirmation('')
                            setConfirmingDelete(false)
                          }}
                          type="button"
                        >
                          {t('projectSwitcher.dialog.danger.cancel')}
                        </button>
                        <button
                          className="danger-button"
                          disabled={
                            busy ||
                            deleteConfirmation !== activeProject?.name
                          }
                          onClick={() => void deleteProject()}
                          type="button"
                        >
                          <Trash2 size={13} />
                          {deleting
                            ? t(
                                'projectSwitcher.dialog.danger.deleting'
                              )
                            : t(
                                'projectSwitcher.dialog.danger.permanentlyDelete'
                              )}
                        </button>
                      </div>
                    </div>
                  )}
                  {userProjects.length <= 1 && (
                    <small>
                      {t('projectSwitcher.dialog.danger.keepOne')}
                    </small>
                  )}
                </section>
              )}
            <div className="project-create-card__actions">
              {dialogMode === 'settings' &&
                activeProject?.kind !== 'channel' &&
                userProjects.length > 1 &&
                activeProjectId && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void archive()}
                    type="button"
                  >
                    <Archive size={13} />
                    {archiving
                      ? t('projectSwitcher.dialog.archiving')
                      : t('projectSwitcher.dialog.archive')}
                  </button>
                )}
              <button
                className="secondary-button"
                disabled={busy}
                onClick={closeDialog}
                type="button"
              >
                {t('projectSwitcher.dialog.cancel')}
              </button>
              <button
                className="primary-button"
                disabled={
                  busy || !draft.name.trim() || confirmingDelete
                }
                onClick={() => void save()}
                type="button"
              >
                {saving
                  ? dialogMode === 'create'
                    ? t('projectSwitcher.dialog.creating')
                    : t('projectSwitcher.dialog.saving')
                  : dialogMode === 'create'
                    ? t('projectSwitcher.dialog.create')
                    : t('projectSwitcher.dialog.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
