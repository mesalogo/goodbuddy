import {
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  Plus,
  RadioTower,
  RefreshCw,
  Server,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantProject,
  ProjectCreateInput
} from '../../shared/assistant-contracts'
import {
  normalizeInteractiveWorkMode,
  projectChannelLabels
} from '../../shared/assistant-contracts'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  remoteProjectRootPathSchema,
  type RemoteProjectSavePhase
} from '../../shared/remote-project-candidate-contracts'
import type {
  SshDirectoryBrowseResult,
  SshHostsSnapshot
} from '../../shared/ssh-host-contracts'
import { trapTabFocus } from './dialog-focus'
import {
  getDefaultRuntimeSelection
} from './runtime-selection'
import {
  channelProjectDraft,
  ChannelProjectSettingsFields
} from './ChannelProjectSettingsFields'
import { getProjectDisplayText } from './project-display'
import { ProjectRuntimeSelector } from './ProjectRuntimeSelector'
import { ProjectWorkModeFields } from './ProjectWorkModeFields'
import { SegmentedControl } from './WorkspacePrimitives'
import { displayErrorMessage } from './error-message'

type ProjectSwitcherProps = {
  projects: AssistantProject[]
  activeProjectId: string
  remoteProjectsEnabled?: boolean
  runtimeSettings?: RuntimeSettings
  onArchive: (projectId: string) => Promise<void>
  onCreate: (input: ProjectCreateInput) => Promise<AssistantProject>
  onDelete: (projectId: string, confirmation: string) => Promise<void>
  onSelect: (projectId: string) => void
  onSelectRoot: () => Promise<string | undefined>
  onRemoteCommitted: (project: AssistantProject) => Promise<void>
  onUpdate: (
    projectId: string,
    input: ProjectCreateInput
  ) => Promise<AssistantProject>
}

const remoteProjectPhases: readonly RemoteProjectSavePhase[] = [
  'host',
  'agent',
  'workspace',
  'runtime',
  'saving'
]
type RemoteHostReadiness =
  | { status: 'ready' }
  | { status: 'unready' }

function RemoteProjectProgress({
  phase,
  phases = remoteProjectPhases,
  title
}: {
  phase: RemoteProjectSavePhase
  phases?: readonly RemoteProjectSavePhase[]
  title: string
}): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const phaseIndex = phases.indexOf(phase)
  return (
    <section
      aria-live="polite"
      className="remote-project-progress"
      role="status"
    >
      <div className="remote-project-progress__header">
        <strong>{title}</strong>
        <span>
          {t('projectSwitcher.remote.phaseStatus', {
            phase: t(
              `projectSwitcher.remote.phases.${phase}`
            )
          })}
        </span>
      </div>
      <progress
        aria-label={t(
          'projectSwitcher.remote.progress.progressLabel'
        )}
        max={phases.length}
        value={phaseIndex + 1}
      />
      <ol
        aria-label={t(
          'projectSwitcher.remote.progress.stepsLabel'
        )}
      >
        {phases.map((candidate, index) => {
          const state =
            index < phaseIndex
              ? 'complete'
              : index === phaseIndex
                ? 'current'
                : 'pending'
          return (
            <li
              aria-current={
                state === 'current' ? 'step' : undefined
              }
              data-state={state}
              key={candidate}
            >
              <span aria-hidden="true">
                {state === 'complete' ? (
                  <Check size={11} />
                ) : (
                  index + 1
                )}
              </span>
              <small>
                {t(
                  `projectSwitcher.remote.phases.${candidate}`
                )}
              </small>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function isRemoteAbsolutePath(value: string): boolean {
  return remoteProjectRootPathSchema.safeParse(value).success
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  remoteProjectsEnabled = false,
  runtimeSettings,
  onArchive,
  onCreate,
  onDelete,
  onRemoteCommitted,
  onSelect,
  onSelectRoot,
  onUpdate
}: ProjectSwitcherProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const [dialogMode, setDialogMode] = useState<
    'create' | 'settings'
  >()
  const [settingsProjectId, setSettingsProjectId] =
    useState<string>()
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [error, setError] = useState<string>()
  const [executionSpaceKind, setExecutionSpaceKind] = useState<
    'local' | 'ssh'
  >('local')
  const [sshHosts, setSshHosts] = useState<SshHostsSnapshot>()
  const [loadingSshHosts, setLoadingSshHosts] = useState(false)
  const [remoteHostReadiness, setRemoteHostReadiness] = useState<
    Record<string, RemoteHostReadiness>
  >({})
  const [remoteHostId, setRemoteHostId] = useState('')
  const [remoteRootPath, setRemoteRootPath] = useState('')
  const [remoteSaving, setRemoteSaving] = useState(false)
  const [remoteSavePhase, setRemoteSavePhase] =
    useState<RemoteProjectSavePhase>()
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false)
  const [directoryPickerLoading, setDirectoryPickerLoading] =
    useState(false)
  const [directoryPickerError, setDirectoryPickerError] =
    useState<string>()
  const [remoteDirectoryListing, setRemoteDirectoryListing] =
    useState<SshDirectoryBrowseResult>()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const directoryPickerTriggerRef = useRef<HTMLButtonElement>(null)
  const directoryPickerRef = useRef<HTMLDivElement>(null)
  const directoryBrowseRequestRef = useRef(0)
  const projectPickerRef = useRef<HTMLDivElement>(null)
  const projectPickerButtonRef = useRef<HTMLButtonElement>(null)
  const projectPickerMenuRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusTarget = useRef<
    'create' | 'settings' | 'picker' | undefined
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
  const activeProjectDisplay = activeProject
    ? getProjectDisplayText(activeProject, t)
    : undefined
  const settingsProject = projects.find(
    (project) => project.id === settingsProjectId
  )
  const localProjects = projects.filter(
    (project) =>
      project.kind === 'user' &&
      project.executionSpace.kind === 'local'
  )
  const remoteProjects = projects.filter(
    (project) =>
      project.kind === 'user' &&
      project.executionSpace.kind === 'ssh'
  )
  const channelProjects = projects.filter(
    (project) => project.kind === 'channel'
  )
  const userProjects = [
    ...localProjects,
    ...(remoteProjectsEnabled ? remoteProjects : [])
  ]
  const busy =
    saving ||
    remoteSaving ||
    archiving ||
    deleting
  const remoteFieldsDisabled = busy
  const remoteDirectoryBrowseDisabled =
    remoteFieldsDisabled ||
    loadingSshHosts ||
    !remoteHostId ||
    remoteHostReadiness[remoteHostId]?.status !== 'ready' ||
    dialogMode === 'settings'
  const selectedRemoteHostReadiness =
    remoteHostReadiness[remoteHostId]
  const remoteDraftReady =
    Boolean(
      draft.name.trim() &&
        remoteHostId &&
        selectedRemoteHostReadiness?.status === 'ready' &&
        isRemoteAbsolutePath(remoteRootPath)
    )

  useEffect(() => {
    if (
      !remoteProjectsEnabled ||
      !dialogMode ||
      executionSpaceKind !== 'ssh'
    ) {
      return
    }
    let active = true
    const api = window.goodbuddy.sshHosts
    if (!api) {
      queueMicrotask(() => {
        if (active) {
          setError(
            t('projectSwitcher.remote.errors.hostsUnavailable')
          )
          setLoadingSshHosts(false)
        }
      })
      return
    }
    void api.getSnapshot().then(
      (snapshot) => {
        if (!active) {
          return
        }
        setSshHosts(snapshot)
        const readiness: Record<string, RemoteHostReadiness> =
          Object.fromEntries(
            snapshot.hosts.map((host) => [
              host.id,
              host.hostKey.state === 'verified' &&
              host.lastValidatedAt !== undefined
                ? { status: 'ready' as const }
                : { status: 'unready' as const }
            ])
          )
        setRemoteHostReadiness(readiness)
        setRemoteHostId((current) =>
          current &&
          snapshot.hosts.some((host) => host.id === current)
            ? current
            : snapshot.hosts.find(
                (host) =>
                  readiness[host.id]?.status === 'ready'
              )?.id ??
              snapshot.hosts[0]?.id ??
              ''
        )
        setLoadingSshHosts(false)
      },
      () => {
        if (active) {
          setError(t('projectSwitcher.remote.errors.loadHosts'))
          setLoadingSshHosts(false)
        }
      }
    )
    return () => {
      active = false
    }
  }, [dialogMode, executionSpaceKind, remoteProjectsEnabled, t])

  useEffect(() => {
    if (
      !remoteProjectsEnabled ||
      !dialogMode ||
      executionSpaceKind !== 'ssh'
    ) {
      return
    }
    const remoteApi = window.goodbuddy.projects.remote
    if (!remoteApi) {
      return
    }
    return remoteApi.onSaveProgress((progress) =>
      setRemoteSavePhase(progress.phase)
    )
  }, [dialogMode, executionSpaceKind, remoteProjectsEnabled])

  useEffect(() => {
    if (
      remoteProjectsEnabled ||
      dialogMode !== 'settings' ||
      settingsProject?.executionSpace.kind !== 'ssh'
    ) {
      return
    }
    let active = true
    queueMicrotask(() => {
      if (active) {
        setConfirmingDelete(false)
        setDeleteConfirmation('')
        setDialogMode(undefined)
      }
    })
    return () => {
      active = false
    }
  }, [dialogMode, remoteProjectsEnabled, settingsProject])

  const resetRemoteDraft = (): void => {
    directoryBrowseRequestRef.current += 1
    setSshHosts(undefined)
    setLoadingSshHosts(false)
    setRemoteHostReadiness({})
    setRemoteHostId('')
    setRemoteRootPath('')
    setRemoteSaving(false)
    setRemoteSavePhase(undefined)
    setDirectoryPickerOpen(false)
    setDirectoryPickerLoading(false)
    setDirectoryPickerError(undefined)
    setRemoteDirectoryListing(undefined)
  }

  const cancelRemoteDirectoryBrowse = useCallback((): void => {
    directoryBrowseRequestRef.current += 1
    const api = remoteProjectsEnabled
      ? window.goodbuddy.sshHosts
      : undefined
    if (api) {
      void api.cancelDirectoryBrowse().catch(() => undefined)
    }
    setDirectoryPickerOpen(false)
    setDirectoryPickerLoading(false)
    setDirectoryPickerError(undefined)
    setRemoteDirectoryListing(undefined)
    requestAnimationFrame(() =>
      directoryPickerTriggerRef.current?.focus()
    )
  }, [remoteProjectsEnabled])

  const browseRemoteDirectories = async (
    path?: string
  ): Promise<void> => {
    if (!remoteProjectsEnabled) {
      return
    }
    const api = window.goodbuddy.sshHosts
    if (!api || !remoteHostId) {
      return
    }
    const requestId = ++directoryBrowseRequestRef.current
    setDirectoryPickerLoading(true)
    setDirectoryPickerError(undefined)
    try {
      const response = await api.browseDirectories(remoteHostId, path)
      if (requestId !== directoryBrowseRequestRef.current) {
        return
      }
      setRemoteDirectoryListing(response)
    } catch (reason) {
      if (requestId !== directoryBrowseRequestRef.current) {
        return
      }
      const message = displayErrorMessage(
        reason,
        t('projectSwitcher.remote.directoryPicker.unknownError')
      )
      setDirectoryPickerError(
        t('projectSwitcher.remote.directoryPicker.loadError', {
          message
        })
      )
    } finally {
      if (requestId === directoryBrowseRequestRef.current) {
        setDirectoryPickerLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!projectMenuOpen) {
      return
    }
    const focusFrame = requestAnimationFrame(() => {
      const items = Array.from(
        projectPickerMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role^="menuitem"]'
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
    if (!directoryPickerOpen) {
      return
    }
    const focusFrame = requestAnimationFrame(() => {
      const target =
        directoryPickerRef.current?.querySelector<HTMLButtonElement>(
          'button:not(:disabled)'
        )
      target?.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [directoryPickerOpen])

  useEffect(() => {
    if (!dialogMode) {
      if (restoreFocusTarget.current === 'create') {
        createButtonRef.current?.focus()
      } else if (restoreFocusTarget.current === 'settings') {
        settingsButtonRef.current?.focus()
      } else if (restoreFocusTarget.current === 'picker') {
        projectPickerButtonRef.current?.focus()
      }
      restoreFocusTarget.current = undefined
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (directoryPickerOpen) {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelRemoteDirectoryBrowse()
          return
        }
        trapTabFocus(event, directoryPickerRef.current)
        return
      }
      if (event.key === 'Escape' && !archiving && !deleting) {
        if (remoteProjectsEnabled && remoteSaving) {
          void window.goodbuddy.projects.remote
            .cancelCurrent()
            .catch(() => undefined)
        }
        setConfirmingDelete(false)
        setDeleteConfirmation('')
        setDialogMode(undefined)
        return
      }
      trapTabFocus(event, dialogRef.current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    archiving,
    cancelRemoteDirectoryBrowse,
    deleting,
    dialogMode,
    directoryPickerOpen,
    remoteProjectsEnabled,
    remoteSaving
  ])

  const closeDialog = (): void => {
    directoryBrowseRequestRef.current += 1
    if (directoryPickerOpen) {
      const api = remoteProjectsEnabled
        ? window.goodbuddy.sshHosts
        : undefined
      if (api) {
        void api.cancelDirectoryBrowse().catch(() => undefined)
      }
    }
    if (remoteProjectsEnabled && remoteSaving) {
      void window.goodbuddy.projects.remote
        .cancelCurrent()
        .catch(() => undefined)
    }
    setConfirmingDelete(false)
    setDeleteConfirmation('')
    setDialogMode(undefined)
    setSettingsProjectId(undefined)
  }

  const openProjectSettings = (
    project: AssistantProject,
    restoreTarget: 'settings' | 'picker'
  ): void => {
    if (
      !remoteProjectsEnabled &&
      project.executionSpace.kind === 'ssh'
    ) {
      return
    }
    setProjectMenuOpen(false)
    setError(undefined)
    setConfirmingDelete(false)
    setDeleteConfirmation('')
    resetRemoteDraft()
    setSettingsProjectId(project.id)
    const nextExecutionSpaceKind =
      project.executionSpace.kind === 'ssh' ? 'ssh' : 'local'
    setExecutionSpaceKind(nextExecutionSpaceKind)
    if (project.executionSpace.kind === 'ssh') {
      setLoadingSshHosts(true)
      setRemoteHostId(project.executionSpace.hostId)
      setRemoteRootPath(project.executionSpace.remoteRootPath)
    }
    const nextDraft: ProjectCreateInput = {
      name: project.name,
      description: project.description,
      rootPath: project.rootPath,
      defaultWorkMode: normalizeInteractiveWorkMode(
        project.defaultWorkMode
      ),
      runtimeSelection:
        project.runtimeSelection ??
        (runtimeSettings
          ? getDefaultRuntimeSelection(runtimeSettings)
          : undefined)
    }
    setDraft(
      project.kind === 'channel' && runtimeSettings
        ? channelProjectDraft(nextDraft, runtimeSettings)
        : nextDraft
    )
    restoreFocusTarget.current = restoreTarget
    setDialogMode('settings')
  }

  const validateRemoteDraft = (): boolean => {
    if (!remoteHostId) {
      setError(t('projectSwitcher.remote.validation.host'))
      return false
    }
    if (remoteHostReadiness[remoteHostId]?.status !== 'ready') {
      setError(
        t('projectSwitcher.remote.readiness.saveBlocked')
      )
      return false
    }
    if (!isRemoteAbsolutePath(remoteRootPath)) {
      setError(t('projectSwitcher.remote.validation.root'))
      return false
    }
    return true
  }

  const saveRemoteProject = async (): Promise<void> => {
    setError(undefined)
    if (
      !remoteProjectsEnabled ||
      !draft.name.trim() ||
      !validateRemoteDraft()
    ) {
      return
    }
    setRemoteSaving(true)
    setRemoteSavePhase('host')
    try {
      const commonDraft = {
        name: draft.name,
        description: draft.description,
        runtimeSelection:
          draft.runtimeSelection?.provider === 'opencode'
            ? draft.runtimeSelection
            : ({ provider: 'opencode' } as const),
        hostId: remoteHostId,
        remoteRootPath
      }
      const modeDraft = {
        ...commonDraft,
        defaultWorkMode: draft.defaultWorkMode
      }
      const result =
        await window.goodbuddy.projects.remote.save(
          dialogMode === 'settings' && settingsProject
            ? {
                intent: 'update',
                draft: {
                  ...modeDraft,
                  projectId: settingsProject.id
                }
              }
            : {
                intent: 'create',
                draft: modeDraft
              }
        )
      await onRemoteCommitted(result)
      closeDialog()
    } catch (reason) {
      setError(
        displayErrorMessage(
          reason,
          t('projectSwitcher.remote.errors.save')
        )
      )
    } finally {
      setRemoteSaving(false)
      setRemoteSavePhase(undefined)
    }
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
      if (dialogMode === 'settings' && settingsProject) {
        await onUpdate(settingsProject.id, input)
      } else {
        await onCreate(input)
      }
      closeDialog()
    } catch (reason) {
      setError(
        displayErrorMessage(
          reason,
          dialogMode === 'settings'
            ? t('projectSwitcher.errors.save')
            : t('projectSwitcher.errors.create')
        )
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
        displayErrorMessage(
          reason,
          t('projectSwitcher.errors.selectRoot')
        )
      )
    }
  }

  const archive = async (): Promise<void> => {
    if (!settingsProject) {
      return
    }
    setArchiving(true)
    setError(undefined)
    try {
      await onArchive(settingsProject.id)
      closeDialog()
    } catch (reason) {
      setError(
        displayErrorMessage(
          reason,
          t('projectSwitcher.errors.archive')
        )
      )
    } finally {
      setArchiving(false)
    }
  }

  const deleteProject = async (): Promise<void> => {
    if (!settingsProject) {
      return
    }
    setDeleting(true)
    setError(undefined)
    try {
      await onDelete(settingsProject.id, deleteConfirmation)
      closeDialog()
    } catch (reason) {
      setError(
        displayErrorMessage(
          reason,
          t('projectSwitcher.errors.delete')
        )
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
            title={activeProjectDisplay?.name}
            type="button"
          >
            <span>
              {activeProjectDisplay?.name ??
                t('projectSwitcher.selector.empty')}
            </span>
            <ChevronDown aria-hidden="true" size={14} />
          </button>
          {projectMenuOpen && (
            <div
              aria-label={t('projectSwitcher.selector.ariaLabel')}
              className="project-switcher__menu"
              onKeyDown={(event) => {
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role^="menuitem"]'
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
                  const currentItem = items.at(currentIndex)
                  if (currentItem) {
                    currentItem.tabIndex = -1
                  }
                  nextItem.tabIndex = 0
                  nextItem.focus()
                }
              }}
              ref={projectPickerMenuRef}
              role="menu"
            >
              {[
                {
                  projects: localProjects,
                  label: t('projectSwitcher.selector.userProjects'),
                  icon: Folder
                },
                ...(remoteProjectsEnabled
                  ? [
                      {
                        projects: remoteProjects,
                        label: t(
                          'projectSwitcher.selector.remoteProjects'
                        ),
                        icon: Server
                      }
                    ]
                  : []),
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
                      const projectDisplay = getProjectDisplayText(
                        project,
                        t
                      )
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
                          : project.executionSpace.kind === 'ssh'
                            ? t(
                                'projectSwitcher.selector.managedSshDetail',
                                { path: project.rootPath }
                              )
                            : t(
                                'projectSwitcher.selector.localDetail',
                                { path: project.rootPath }
                              )
                      return (
                        <div
                          className="project-switcher__menu-item"
                          key={project.id}
                        >
                          <button
                            aria-checked={selected}
                            onClick={() => {
                              if (
                                !selected ||
                                project.executionSpace.kind === 'ssh'
                              ) {
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
                              <b>{projectDisplay.name}</b>
                              <small>{detail}</small>
                            </span>
                            {selected && (
                              <Check aria-hidden="true" size={14} />
                            )}
                          </button>
                          <button
                            aria-label={t(
                              'projectSwitcher.selector.settingsNamed',
                              { name: projectDisplay.name }
                            )}
                            className="project-switcher__menu-settings"
                            onClick={() =>
                              openProjectSettings(project, 'picker')
                            }
                            role="menuitem"
                            tabIndex={-1}
                            type="button"
                          >
                            <Settings aria-hidden="true" size={14} />
                          </button>
                        </div>
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
            setSettingsProjectId(undefined)
            resetRemoteDraft()
            setExecutionSpaceKind('local')
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
          disabled={
            !activeProject ||
            (!remoteProjectsEnabled &&
              activeProject.executionSpace.kind === 'ssh')
          }
          onClick={() => {
            if (!activeProject) {
              return
            }
            openProjectSettings(activeProject, 'settings')
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
                className="icon-button project-create-card__close"
                disabled={busy}
                onClick={() => closeDialog()}
                type="button"
              >
                <X size={14} />
              </button>
            </header>
            {dialogMode === 'settings' &&
            settingsProject?.kind === 'channel' &&
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
                    disabled={
                      executionSpaceKind === 'ssh'
                        ? remoteFieldsDisabled
                        : busy
                    }
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
                    disabled={
                      executionSpaceKind === 'ssh'
                        ? remoteFieldsDisabled
                        : busy
                    }
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
                <div className="project-execution-space">
                  <span>
                    {t(
                      'projectSwitcher.dialog.fields.executionSpace'
                    )}
                  </span>
                  <SegmentedControl
                    ariaLabel={t(
                      'projectSwitcher.dialog.fields.executionSpace'
                    )}
                    disabled={dialogMode === 'settings' || busy}
                    onChange={(kind) => {
                      setError(undefined)
                      setRemoteSavePhase(undefined)
                      setExecutionSpaceKind(kind)
                      if (kind === 'ssh') {
                        setLoadingSshHosts(true)
                        setDraft((current) => ({
                          ...current,
                          runtimeSelection:
                            current.runtimeSelection?.provider ===
                            'opencode'
                              ? current.runtimeSelection
                              : { provider: 'opencode' }
                        }))
                      }
                    }}
                    options={[
                      {
                        value: 'local',
                        label: t(
                          'projectSwitcher.remote.executionSpaces.local'
                        )
                      },
                      ...(remoteProjectsEnabled
                        ? [
                            {
                              value: 'ssh' as const,
                              label: t(
                                'projectSwitcher.remote.executionSpaces.ssh'
                              )
                            }
                          ]
                        : [])
                    ]}
                    value={executionSpaceKind}
                  />
                  {dialogMode === 'settings' && (
                    <small>
                      {t(
                        'projectSwitcher.remote.executionSpaceFixed'
                      )}
                    </small>
                  )}
                </div>
                {executionSpaceKind === 'local' ? (
                  <>
                    <label>
                      <span>
                        {t('projectSwitcher.dialog.fields.rootPath')}
                      </span>
                      <div className="project-create-card__path">
                        <input readOnly value={draft.rootPath} />
                        <button
                          aria-label={t(
                            'projectSwitcher.dialog.selectRoot'
                          )}
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => void selectRoot()}
                          type="button"
                        >
                          <FolderOpen size={14} />
                        </button>
                      </div>
                    </label>
                    <ProjectWorkModeFields
                      ariaLabel={t(
                        'projectSwitcher.dialog.fields.defaultMode'
                      )}
                      disabled={busy}
                      labels={{
                        ask: t('projectSwitcher.workModes.ask'),
                        execute: t('projectSwitcher.workModes.execute')
                      }}
                      legend={t(
                        'projectSwitcher.dialog.fields.defaultMode'
                      )}
                      onChange={(defaultWorkMode) =>
                        setDraft((current) => ({
                          ...current,
                          defaultWorkMode
                        }))
                      }
                      value={draft.defaultWorkMode}
                    />
                    {runtimeSettings && (
                      <>
                        <ProjectRuntimeSelector
                          ariaLabel={t(
                            'projectSwitcher.dialog.fields.defaultRuntime'
                          )}
                          disabled={busy}
                          label={t(
                            'projectSwitcher.dialog.fields.defaultRuntime'
                          )}
                          onChange={(runtimeSelection) =>
                            setDraft((current) => ({
                              ...current,
                              runtimeSelection
                            }))
                          }
                          runtimeSettings={runtimeSettings}
                          selection={draft.runtimeSelection}
                        />
                        <small className="project-runtime-selector__scope-help">
                          {t(
                            'projectSwitcher.dialog.defaultRuntimeHelp'
                          )}
                        </small>
                      </>
                    )}
                  </>
                ) : (
                  <div className="remote-project-fields">
                    <label>
                      <span>
                        {t('projectSwitcher.remote.fields.host')}
                      </span>
                      <select
                        aria-label={t(
                          'projectSwitcher.remote.fields.host'
                        )}
                        disabled={
                          remoteFieldsDisabled ||
                          loadingSshHosts ||
                          dialogMode === 'settings'
                        }
                        onChange={(event) => {
                          setError(undefined)
                          setRemoteHostId(event.target.value)
                        }}
                        value={remoteHostId}
                      >
                        {loadingSshHosts && (
                          <option value="">
                            {t(
                              'projectSwitcher.remote.loadingHosts'
                            )}
                          </option>
                        )}
                        {!loadingSshHosts &&
                          sshHosts?.hosts.length === 0 && (
                            <option value="">
                              {t(
                                'projectSwitcher.remote.noHosts'
                              )}
                            </option>
                          )}
                        {sshHosts?.hosts.map((host) => {
                          const readiness =
                            remoteHostReadiness[host.id]
                          const readinessLabel = readiness
                            ? t(
                                `projectSwitcher.remote.readiness.options.${readiness.status}`
                              )
                            : t(
                                'projectSwitcher.remote.readiness.options.loading'
                              )
                          return (
                            <option
                              disabled={readiness?.status !== 'ready'}
                              key={host.id}
                              value={host.id}
                            >
                              {host.name} · {host.username}@
                              {host.hostname} · {readinessLabel}
                            </option>
                          )
                        })}
                      </select>
                      <small>
                        {t('projectSwitcher.remote.hostHelp')}
                      </small>
                      {remoteHostId &&
                        selectedRemoteHostReadiness && (
                          <small
                            aria-live="polite"
                            role={
                              selectedRemoteHostReadiness.status ===
                              'unready'
                                ? 'alert'
                                : 'status'
                            }
                          >
                            {t(
                              `projectSwitcher.remote.readiness.${selectedRemoteHostReadiness.status}`
                            )}
                          </small>
                        )}
                    </label>
                    <label>
                      <span>
                        {t('projectSwitcher.remote.fields.root')}
                      </span>
                      <div className="project-create-card__path">
                        <input
                          aria-label={t(
                            'projectSwitcher.remote.fields.root'
                          )}
                          disabled={
                            remoteFieldsDisabled ||
                            dialogMode === 'settings'
                          }
                          maxLength={4_096}
                          onChange={(event) =>
                            setRemoteRootPath(event.target.value)
                          }
                          placeholder="/home/user/project"
                          value={remoteRootPath}
                        />
                        <button
                          aria-label={t(
                            'projectSwitcher.remote.directoryPicker.browse'
                          )}
                          className="secondary-button"
                          disabled={remoteDirectoryBrowseDisabled}
                          onClick={() => {
                            setDirectoryPickerOpen(true)
                            setRemoteDirectoryListing(undefined)
                            void browseRemoteDirectories(
                              isRemoteAbsolutePath(remoteRootPath)
                                ? remoteRootPath
                                : undefined
                            )
                          }}
                          ref={directoryPickerTriggerRef}
                          title={t(
                            'projectSwitcher.remote.directoryPicker.browse'
                          )}
                          type="button"
                        >
                          <FolderOpen aria-hidden="true" size={14} />
                        </button>
                      </div>
                      <small>
                        {t('projectSwitcher.remote.rootHelp')}
                      </small>
                    </label>
                    <div className="remote-project-runtime">
                      <span>
                        {t(
                          'projectSwitcher.dialog.fields.defaultRuntime'
                        )}
                      </span>
                      <strong>OpenCode</strong>
                      <small>
                        {t(
                          'projectSwitcher.remote.runtimeHelp'
                        )}
                      </small>
                    </div>
                    <ProjectWorkModeFields
                      ariaLabel={t(
                        'projectSwitcher.dialog.fields.defaultMode'
                      )}
                      disabled={remoteFieldsDisabled}
                      labels={{
                        ask: t('projectSwitcher.workModes.ask'),
                        execute: t('projectSwitcher.workModes.execute')
                      }}
                      legend={t(
                        'projectSwitcher.dialog.fields.defaultMode'
                      )}
                      onChange={(defaultWorkMode) =>
                        setDraft((current) => ({
                          ...current,
                          defaultWorkMode
                        }))
                      }
                      value={draft.defaultWorkMode}
                    />
                    {remoteSaving && remoteSavePhase && (
                      <RemoteProjectProgress
                        phase={remoteSavePhase}
                        title={t(
                          'projectSwitcher.remote.actions.saving'
                        )}
                      />
                    )}
                  </div>
                )}
                {directoryPickerOpen && (
                  <div
                    className="remote-directory-picker-backdrop"
                    onMouseDown={(event) => {
                      if (event.currentTarget === event.target) {
                        cancelRemoteDirectoryBrowse()
                      }
                    }}
                  >
                    <section
                      aria-labelledby="remote-directory-picker-title"
                      aria-modal="true"
                      className="remote-directory-picker"
                      ref={directoryPickerRef}
                      role="dialog"
                    >
                      <header>
                        <strong id="remote-directory-picker-title">
                          {t(
                            'projectSwitcher.remote.directoryPicker.title'
                          )}
                        </strong>
                        <button
                          aria-label={t(
                            'projectSwitcher.remote.directoryPicker.close'
                          )}
                          className="icon-button"
                          onClick={() =>
                            cancelRemoteDirectoryBrowse()
                          }
                          title={t(
                            'projectSwitcher.remote.directoryPicker.close'
                          )}
                          type="button"
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      </header>
                      <div className="remote-directory-picker__location">
                        <span>
                          {t(
                            'projectSwitcher.remote.directoryPicker.currentPath'
                          )}
                        </span>
                        <code>
                          {remoteDirectoryListing?.path ??
                            (isRemoteAbsolutePath(remoteRootPath)
                              ? remoteRootPath
                              : '…')}
                        </code>
                      </div>
                      <div className="remote-directory-picker__toolbar">
                        <button
                          aria-label={t(
                            'projectSwitcher.remote.directoryPicker.parent'
                          )}
                          className="icon-button"
                          disabled={
                            directoryPickerLoading ||
                            !remoteDirectoryListing ||
                            !remoteDirectoryListing.parentPath
                          }
                          onClick={() => {
                            const parentPath =
                              remoteDirectoryListing?.parentPath
                            if (parentPath) {
                              void browseRemoteDirectories(parentPath)
                            }
                          }}
                          title={t(
                            'projectSwitcher.remote.directoryPicker.parent'
                          )}
                          type="button"
                        >
                          <ArrowUp aria-hidden="true" size={15} />
                        </button>
                        <button
                          aria-label={t(
                            'projectSwitcher.remote.directoryPicker.refresh'
                          )}
                          className="icon-button"
                          disabled={directoryPickerLoading}
                          onClick={() =>
                            void browseRemoteDirectories(
                              remoteDirectoryListing?.path ??
                                (isRemoteAbsolutePath(
                                  remoteRootPath
                                )
                                  ? remoteRootPath
                                  : undefined)
                            )
                          }
                          title={t(
                            'projectSwitcher.remote.directoryPicker.refresh'
                          )}
                          type="button"
                        >
                          <RefreshCw aria-hidden="true" size={15} />
                        </button>
                      </div>
                      <div
                        aria-busy={directoryPickerLoading}
                        className="remote-directory-picker__content"
                      >
                        {directoryPickerLoading ? (
                          <p aria-live="polite" role="status">
                            {t(
                              'projectSwitcher.remote.directoryPicker.loading'
                            )}
                          </p>
                        ) : directoryPickerError ? (
                          <p role="alert">{directoryPickerError}</p>
                        ) : remoteDirectoryListing?.entries.length ? (
                          <ul
                            aria-label={t(
                              'projectSwitcher.remote.directoryPicker.title'
                            )}
                          >
                            {remoteDirectoryListing.entries.map(
                              (directory) => (
                                <li key={directory.path}>
                                  <button
                                    aria-label={t(
                                      'projectSwitcher.remote.directoryPicker.directory',
                                      { name: directory.name }
                                    )}
                                    onClick={() =>
                                      void browseRemoteDirectories(
                                        directory.path
                                      )
                                    }
                                    type="button"
                                  >
                                    <Folder
                                      aria-hidden="true"
                                      size={16}
                                    />
                                    <span>{directory.name}</span>
                                  </button>
                                </li>
                              )
                            )}
                          </ul>
                        ) : (
                          <p>
                            {t(
                              'projectSwitcher.remote.directoryPicker.empty'
                            )}
                          </p>
                        )}
                      </div>
                      <div className="remote-directory-picker__actions">
                        <button
                          className="secondary-button"
                          onClick={() =>
                            cancelRemoteDirectoryBrowse()
                          }
                          type="button"
                        >
                          {t(
                            'projectSwitcher.remote.directoryPicker.cancel'
                          )}
                        </button>
                        <button
                          className="primary-button"
                          disabled={
                            directoryPickerLoading ||
                            !remoteDirectoryListing
                          }
                          onClick={() => {
                            if (!remoteDirectoryListing) {
                              return
                            }
                            setRemoteRootPath(
                              remoteDirectoryListing.path
                            )
                            cancelRemoteDirectoryBrowse()
                          }}
                          type="button"
                        >
                          {t(
                            'projectSwitcher.remote.directoryPicker.select'
                          )}
                        </button>
                      </div>
                    </section>
                  </div>
                )}
              </>
            )}
            {error && (
              <p className="project-create-card__error" role="alert">
                {error}
              </p>
            )}
            {dialogMode === 'settings' &&
              settingsProject?.kind !== 'channel' && (
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
                            { projectName: settingsProject?.name }
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
                            deleteConfirmation !== settingsProject?.name
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
                settingsProject?.kind !== 'channel' &&
                userProjects.length > 1 &&
                settingsProject && (
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
                disabled={archiving || deleting}
                onClick={() => closeDialog()}
                type="button"
              >
                {t('projectSwitcher.dialog.cancel')}
              </button>
              {executionSpaceKind === 'ssh' ? (
                <button
                  className="primary-button"
                  disabled={
                    busy ||
                    confirmingDelete ||
                    !remoteDraftReady
                  }
                  onClick={() => void saveRemoteProject()}
                  type="button"
                >
                  {remoteSaving
                    ? t('projectSwitcher.remote.actions.saving')
                    : t('projectSwitcher.remote.actions.save')}
                </button>
              ) : (
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
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
