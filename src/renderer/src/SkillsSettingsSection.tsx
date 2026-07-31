import { BookOpen, Download, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  CapabilityAssignments,
  CapabilitySnapshot,
  RuntimeTarget
} from '../../shared/capability-contracts'

const runtimeLabels: Record<RuntimeTarget, string> = {
  model: '模型',
  opencode: 'OpenCode',
  continue: 'Continue'
}

export function SkillsSettingsSection(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    void window.goodbuddy.capabilities
      .getSnapshot()
      .then(setSnapshot)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '读取 Skills 失败')
      })
  }, [])

  const run = async (
    key: string,
    operation: () => Promise<CapabilitySnapshot>
  ): Promise<void> => {
    setBusy(key)
    setError(undefined)
    try {
      setSnapshot(await operation())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Skill 操作失败')
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
    <div className="settings-section">
      <div className="settings-section__title settings-section__title--actions">
        <BookOpen size={17} />
        <div>
          <strong>Skills</strong>
          <small>离线能力说明，可独立分配给各 Agent Runtime</small>
        </div>
        <button
          className="secondary-button"
          disabled={Boolean(busy)}
          onClick={() =>
            void run('import', () =>
              window.goodbuddy.capabilities.importSkill()
            )
          }
          type="button"
        >
          <Download size={14} />
          导入 SKILL.md
        </button>
      </div>

      {error && <p className="settings-warning">{error}</p>}
      {!snapshot && !error && <p className="settings-empty">正在读取 Skills…</p>}
      <div className="capability-list">
        {snapshot?.skills.map((skill) => (
          <article className="capability-card" key={skill.id}>
            <div className="capability-card__header">
              <div>
                <strong>{skill.name}</strong>
                <small>
                  {skill.source === 'builtin' ? '内置' : '已导入'} ·{' '}
                  {skill.version ?? '未标注版本'}
                </small>
              </div>
              <label className="capability-switch">
                <input
                  aria-label={`启用 ${skill.name}`}
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
                <span>{skill.enabled ? '已启用' : '已停用'}</span>
              </label>
            </div>
            <p>{skill.description}</p>
            <div className="capability-tags">
              {skill.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <div className="runtime-assignments">
              <small>分配给</small>
              {(Object.keys(runtimeLabels) as RuntimeTarget[]).map(
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
                    {runtimeLabels[target]}
                  </label>
                )
              )}
              {skill.source === 'imported' && (
                <button
                  aria-label={`删除 ${skill.name}`}
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
                  删除
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
