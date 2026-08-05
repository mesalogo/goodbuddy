import { Bot, Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  AssistantExpert,
  ExpertCreateInput
} from '../../shared/assistant-contracts'
import { DestructiveConfirmActions } from './WorkspacePrimitives'

type ExpertDraft = Omit<ExpertCreateInput, 'routingKeywords'> & {
  id?: string
  routingKeywordsText: string
}

type RolePromptSettingsSectionProps = {
  onChanged: (experts: AssistantExpert[]) => void
}

const emptyDraft: ExpertDraft = {
  name: '',
  description: '',
  systemInstructions: '',
  routingKeywordsText: ''
}

function draftFromExpert(expert: AssistantExpert): ExpertDraft {
  return {
    id: expert.id,
    name: expert.name,
    description: expert.description,
    systemInstructions: expert.systemInstructions,
    routingKeywordsText: (expert.routingKeywords ?? []).join('、')
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

function validateRoutingKeywords(keywords: readonly string[]): string | undefined {
  if (keywords.length > 32) {
    return '路由关键词最多 32 个。'
  }
  const invalid = keywords.find(
    (keyword) => keyword.length < 2 || keyword.length > 48
  )
  return invalid
    ? `关键词“${invalid.slice(0, 48)}”需为 2 至 48 个字符。`
    : undefined
}

function sortExperts(experts: AssistantExpert[]): AssistantExpert[] {
  return [...experts].sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN')
  )
}

export function RolePromptSettingsSection({
  onChanged
}: RolePromptSettingsSectionProps): React.JSX.Element {
  const [experts, setExperts] = useState<AssistantExpert[]>([])
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
        const sorted = sortExperts(items)
        setExperts(sorted)
        if (sorted[0]) {
          setSelectedId(sorted[0].id)
          setDraft(draftFromExpert(sorted[0]))
        }
      })
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error ? reason.message : '读取角色失败'
        )
      })
  }, [])

  const selectExpert = (expert: AssistantExpert): void => {
    setSelectedId(expert.id)
    setDraft(draftFromExpert(expert))
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
    const keywordError = validateRoutingKeywords(routingKeywords)
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
        routingKeywords
      }
      const saved = draft.id
        ? await window.goodbuddy.experts.update(draft.id, input)
        : await window.goodbuddy.experts.create(input)
      const next = sortExperts(
        draft.id
          ? experts.map((expert) =>
              expert.id === saved.id ? saved : expert
            )
          : [...experts, saved]
      )
      setExperts(next)
      setSelectedId(saved.id)
      setDraft(draftFromExpert(saved))
      onChanged(next)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '保存角色失败'
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
        setDraft(draftFromExpert(next[0]))
      } else {
        setSelectedId(undefined)
        setDraft(undefined)
      }
      onChanged(next)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '删除角色失败'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section__title settings-section__title--actions">
        <Bot size={17} />
        <div>
          <strong>角色与提示词</strong>
          <small>管理聊天角色及其受信任系统提示词</small>
        </div>
        <button
          className="secondary-button role-prompt-add"
          disabled={busy}
          onClick={createDraft}
          type="button"
        >
          <Plus size={14} />
          新建角色
        </button>
      </div>

      <p className="settings-notice">
        选中的角色会把系统提示词加入本次文本对话。专家团队会并行使用最多
        3 个已启用角色；图像生成连接不使用角色提示词。
      </p>
      {error && <p className="settings-warning" role="alert">{error}</p>}

      <div className="model-connection-manager role-prompt-manager">
        <aside
          aria-label="角色列表"
          className="model-connection-list"
        >
          <div className="model-connection-list__header">
            <strong>角色列表</strong>
            <span>{experts.length}</span>
          </div>
          <div role="list">
            {experts.map((expert) => (
              <div key={expert.id} role="listitem">
                <button
                  aria-current={
                    selectedId === expert.id ? 'page' : undefined
                  }
                  aria-label={`编辑角色 ${expert.name}`}
                  onClick={() => selectExpert(expert)}
                  type="button"
                >
                  <span className="model-connection-list__name">
                    <strong>{expert.name}</strong>
                    <small>{expert.description || '暂无说明'}</small>
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
                <strong>{draft.id ? draft.name : '新建角色'}</strong>
                <small>角色详情</small>
              </div>
            </div>
            <label className="field">
              <span>角色名称</span>
              <input
                maxLength={80}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                value={draft.name}
              />
            </label>
            <label className="field">
              <span>角色说明</span>
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
              <span>系统提示词</span>
              <textarea
                aria-label="系统提示词"
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
                作为受信任指令发送给文本模型，请勿写入 API Key 或私人数据。
                已输入 {draft.systemInstructions.length.toLocaleString()} /
                20,000 字符。
              </small>
            </label>
            <label className="field">
              <span>路由关键词</span>
              <textarea
                aria-describedby={
                  routingKeywordsError
                    ? 'role-routing-keywords-error role-routing-keywords-help'
                    : 'role-routing-keywords-help'
                }
                aria-invalid={routingKeywordsError ? 'true' : undefined}
                aria-label="路由关键词"
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    routingKeywordsText: event.target.value
                  })
                  setRoutingKeywordsError(undefined)
                }}
                placeholder="例如：代码审查、TypeScript、性能分析"
                rows={3}
                value={draft.routingKeywordsText}
              />
              <small id="role-routing-keywords-help">
                使用逗号或换行分隔，保存时会去重并规范化。最多 32 个，
                每个 2 至 48 个字符。
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
                  confirmAriaLabel={`确认删除角色 ${draft.name}`}
                  confirmLabel="删除角色"
                  confirming={confirmingRemove}
                  disabled={busy}
                  icon={<Trash2 size={13} />}
                  message="删除后，该角色将从聊天选择和专家团队中移除。"
                  onCancel={() => setConfirmingRemove(false)}
                  onConfirm={() => void remove()}
                  onRequestConfirm={() => setConfirmingRemove(true)}
                  triggerAriaLabel={`删除角色 ${draft.name}`}
                  triggerLabel="删除角色"
                />
              ) : (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    const first = experts[0]
                    if (first) {
                      selectExpert(first)
                    } else {
                      setDraft(undefined)
                    }
                  }}
                  type="button"
                >
                  取消
                </button>
              )}
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void save()}
                type="button"
              >
                <Save size={14} />
                {busy ? '保存中…' : draft.id ? '保存角色' : '创建角色'}
              </button>
            </div>
          </div>
        ) : (
          <p className="settings-empty role-prompt-empty">
            还没有角色。新建角色后，可以为它配置系统提示词。
          </p>
        )}
      </div>
    </div>
  )
}
