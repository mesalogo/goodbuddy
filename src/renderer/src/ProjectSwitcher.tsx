import { Archive, FolderOpen, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  AssistantProject,
  InteractiveWorkMode,
  ProjectCreateInput,
  WorkMode
} from '../../shared/assistant-contracts'
import { interactiveWorkModes } from '../../shared/assistant-contracts'
import { trapTabFocus } from './dialog-focus'

type ProjectSwitcherProps = {
  projects: AssistantProject[]
  activeProjectId: string
  onArchive: (projectId: string) => Promise<void>
  onCreate: (input: ProjectCreateInput) => Promise<AssistantProject>
  onSelect: (projectId: string) => void
  onSelectRoot: () => Promise<string | undefined>
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
  onSelect,
  onSelectRoot
}: ProjectSwitcherProps): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string>()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreCreateButtonFocus = useRef(false)
  const [draft, setDraft] = useState<ProjectCreateInput>({
    name: '',
    description: '',
    rootPath: '',
    defaultWorkMode: 'ask'
  })

  useEffect(() => {
    if (!creating) {
      if (restoreCreateButtonFocus.current) {
        createButtonRef.current?.focus()
        restoreCreateButtonFocus.current = false
      }
      return
    }
    restoreCreateButtonFocus.current = true
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving && !archiving) {
        setError(undefined)
        setCreating(false)
        return
      }
      trapTabFocus(event, dialogRef.current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [archiving, creating, saving])

  const create = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const project = await onCreate(draft)
      onSelect(project.id)
      setDraft({
        name: '',
        description: '',
        rootPath: '',
        defaultWorkMode: 'ask'
      })
      setCreating(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建项目失败')
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
      setCreating(false)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '归档项目失败'
      )
    } finally {
      setArchiving(false)
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
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <button
          aria-label="新建项目"
          className="icon-button"
          onClick={() => {
            setError(undefined)
            setCreating(true)
          }}
          ref={createButtonRef}
          type="button"
        >
          <Plus size={15} />
        </button>
      </div>
      {creating && (
        <div
          className="project-create-backdrop"
          onMouseDown={(event) => {
            if (
              event.currentTarget === event.target &&
              !saving &&
              !archiving
            ) {
              setError(undefined)
              setCreating(false)
            }
          }}
        >
          <div
            aria-labelledby="project-create-title"
            aria-modal="true"
            className="project-create-card"
            ref={dialogRef}
            role="dialog"
          >
            <header>
              <strong id="project-create-title">新建项目</strong>
              <button
                aria-label="关闭新建项目"
                className="icon-button"
                disabled={saving || archiving}
                onClick={() => {
                  setError(undefined)
                  setCreating(false)
                }}
                type="button"
              >
                <X size={14} />
              </button>
            </header>
            <label>
              <span>名称</span>
              <input
                autoFocus
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
                  disabled={saving || archiving}
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
            <div className="project-create-card__actions">
              {projects.length > 1 && activeProjectId && (
                <button
                  className="secondary-button"
                  disabled={saving || archiving}
                  onClick={() => void archive()}
                  type="button"
                >
                  <Archive size={13} />
                  {archiving ? '归档中' : '归档当前'}
                </button>
              )}
              <button
                className="primary-button"
                disabled={
                  saving || archiving || !draft.name.trim()
                }
                onClick={() => void create()}
                type="button"
              >
                {saving ? '创建中' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
