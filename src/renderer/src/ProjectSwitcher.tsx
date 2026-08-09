import {
  Archive,
  FolderOpen,
  Plus,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  AssistantProject,
  InteractiveWorkMode,
  ProjectCreateInput,
  WorkMode
} from '../../shared/assistant-contracts'
import {
  interactiveWorkModes,
  normalizeInteractiveWorkMode
} from '../../shared/assistant-contracts'
import { trapTabFocus } from './dialog-focus'

type ProjectSwitcherProps = {
  projects: AssistantProject[]
  activeProjectId: string
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

export const workModeLabels: Record<InteractiveWorkMode, string> = {
  ask: 'Ask · 只读问答',
  execute: 'Execute · 受控执行'
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  onArchive,
  onCreate,
  onDelete,
  onSelect,
  onSelectRoot,
  onUpdate
}: ProjectSwitcherProps): React.JSX.Element {
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusTarget = useRef<
    'create' | 'settings' | undefined
  >(undefined)
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
      if (dialogMode === 'settings' && activeProject) {
        await onUpdate(activeProject.id, draft)
      } else {
        await onCreate(draft)
      }
      closeDialog()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : dialogMode === 'settings'
            ? '保存项目失败'
            : '创建项目失败'
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
          : '选择项目根目录失败'
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
        reason instanceof Error ? reason.message : '归档项目失败'
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
        reason instanceof Error ? reason.message : '删除项目失败'
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="project-switcher">
      <div className="project-switcher__row">
        <select
          aria-label="当前项目"
          onChange={(event) => onSelect(event.target.value)}
          value={activeProjectId}
        >
          {userProjects.length > 0 && (
            <optgroup label="普通项目">
              {userProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </optgroup>
          )}
          {channelProjects.length > 0 && (
            <optgroup label="远程通道">
              {channelProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          aria-label="新建项目"
          className="icon-button"
          onClick={() => {
            setError(undefined)
            setConfirmingDelete(false)
            setDeleteConfirmation('')
            setDraft({
              name: '',
              description: '',
              rootPath: '',
              defaultWorkMode: 'ask'
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
          aria-label="项目设置"
          className="icon-button"
          disabled={!activeProject}
          onClick={() => {
            if (!activeProject) {
              return
            }
            setError(undefined)
            setConfirmingDelete(false)
            setDeleteConfirmation('')
            setDraft({
              name: activeProject.name,
              description: activeProject.description,
              rootPath: activeProject.rootPath,
              defaultWorkMode: normalizeInteractiveWorkMode(
                activeProject.defaultWorkMode
              )
            })
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
                {dialogMode === 'create' ? '新建项目' : '项目设置'}
              </strong>
              <button
                aria-label={
                  dialogMode === 'create'
                    ? '关闭新建项目'
                    : '关闭项目设置'
                }
                className="icon-button"
                disabled={busy}
                onClick={closeDialog}
                type="button"
              >
                <X size={14} />
              </button>
            </header>
            <label>
              <span>名称</span>
              <input
                autoFocus={!confirmingDelete}
                disabled={busy || activeProject?.kind === 'channel'}
                maxLength={120}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value
                  }))
                }
                value={draft.name}
              />
              {activeProject?.kind === 'channel' && (
                <small>通道项目名称由 GoodBuddy 管理。</small>
              )}
            </label>
            <label>
              <span>说明</span>
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
              <span>根目录</span>
              <div className="project-create-card__path">
                <input readOnly value={draft.rootPath} />
                <button
                  aria-label="选择项目根目录"
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
              <span>默认模式</span>
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
                    {workModeLabels[value]}
                  </option>
                ))}
              </select>
            </label>
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
                    <strong id="project-danger-title">危险操作</strong>
                    <p>
                      删除项目会永久移除 GoodBuddy
                      中的项目、对话、任务、计划、心跳、记忆和成果，但不会删除磁盘上的项目目录或文件。
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
                      删除项目
                    </button>
                  ) : (
                    <div className="project-delete-confirmation">
                      <label>
                        <span>
                          输入“{activeProject?.name}”确认删除
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
                          取消删除
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
                          {deleting ? '删除中' : '永久删除项目'}
                        </button>
                      </div>
                    </div>
                  )}
                  {userProjects.length <= 1 && (
                    <small>至少需要保留一个可用项目。</small>
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
                    {archiving ? '归档中' : '归档项目'}
                  </button>
                )}
              <button
                className="secondary-button"
                disabled={busy}
                onClick={closeDialog}
                type="button"
              >
                取消
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
                    ? '创建中'
                    : '保存中'
                  : dialogMode === 'create'
                    ? '创建'
                    : '保存项目'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
