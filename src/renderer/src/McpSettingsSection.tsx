import {
  ChevronDown,
  CircleAlert,
  Database,
  FlaskConical,
  Globe2,
  MonitorCog,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { builtinMcpServers } from '../../shared/builtin-mcp-servers'
import { builtinModelToolGroups } from '../../shared/builtin-model-tools'
import type {
  CapabilityDiagnosticReport,
  CapabilityAssignments,
  CapabilitySnapshot,
  ComputerCapabilityId,
  McpServerInput,
  McpServerSummary,
  McpServerTestResult,
  McpTransport,
  RuntimeTarget
} from '../../shared/capability-contracts'
import { trapTabFocus } from './dialog-focus'

const runtimeLabels: Record<RuntimeTarget, string> = {
  model: '模型',
  opencode: 'OpenCode',
  continue: 'Continue'
}
const configurableMcpTargets: RuntimeTarget[] = ['model']
const diagnosticStatusLabels: Record<
  CapabilityDiagnosticReport['status'],
  string
> = {
  available: '可用',
  degraded: '部分可用',
  unavailable: '不可用',
  disabled: '未启用'
}

type McpEditor = {
  id?: string
  name: string
  description: string
  enabled: boolean
  assignments: CapabilityAssignments
  transport: McpTransport
  command: string
  args: string
  url: string
  token: string
  clearToken: boolean
}

const emptyEditor: McpEditor = {
  name: '',
  description: '',
  enabled: true,
  assignments: ['model'],
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  token: '',
  clearToken: false
}

function editorFromServer(server: McpServerSummary): McpEditor {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    enabled: server.enabled,
    assignments: server.assignments.includes('model')
      ? ['model']
      : [],
    transport: server.transport,
    command: server.transport === 'stdio' ? server.command : '',
    args: server.transport === 'stdio' ? server.args.join('\n') : '',
    url: server.transport === 'stdio' ? '' : server.url,
    token: '',
    clearToken: false
  }
}

export function McpSettingsSection(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>()
  const [editor, setEditor] = useState<McpEditor>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [testResults, setTestResults] = useState<
    Record<string, McpServerTestResult>
  >({})
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(
    () => new Set()
  )
  const [diagnostics, setDiagnostics] = useState<
    Partial<Record<ComputerCapabilityId, CapabilityDiagnosticReport>>
  >({})
  const [newProfileName, setNewProfileName] = useState('')
  const [profileNames, setProfileNames] = useState<Record<string, string>>(
    {}
  )
  const editorDialogRef = useRef<HTMLDivElement>(null)
  const editorNameRef = useRef<HTMLInputElement>(null)
  const editorTriggerRef = useRef<HTMLButtonElement | undefined>(
    undefined
  )
  const editorOpen = Boolean(editor)
  const toggleItem = (itemId: string): void => {
    setExpandedItemIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) {
        next.delete(itemId)
      } else {
        next.add(itemId)
      }
      return next
    })
  }

  useEffect(() => {
    void window.goodbuddy.capabilities
      .getSnapshot()
      .then(setSnapshot)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '读取 MCP 设置失败')
      })
  }, [])

  useEffect(() => {
    if (!editorOpen) {
      return
    }
    const frame = requestAnimationFrame(() =>
      editorNameRef.current?.focus()
    )
    return () => cancelAnimationFrame(frame)
  }, [editorOpen])

  const run = async (
    key: string,
    operation: () => Promise<CapabilitySnapshot>
  ): Promise<boolean> => {
    setBusy(key)
    setError(undefined)
    try {
      setSnapshot(await operation())
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '能力设置操作失败')
      return false
    } finally {
      setBusy(undefined)
    }
  }

  const diagnose = async (
    capabilityId: ComputerCapabilityId
  ): Promise<void> => {
    setBusy(`diagnose:${capabilityId}`)
    setError(undefined)
    try {
      const diagnoseCapability =
        window.goodbuddy.capabilities.diagnoseComputerCapability
      if (!diagnoseCapability) {
        throw new Error('当前版本不支持电脑控制能力诊断')
      }
      const report = await diagnoseCapability(capabilityId)
      setDiagnostics((current) => ({
        ...current,
        [capabilityId]: report
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '能力诊断失败')
    } finally {
      setBusy(undefined)
    }
  }

  const createProfile = async (): Promise<void> => {
    const name = newProfileName.trim()
    if (!name) {
      return
    }
    if (
      await run('profile:create', () =>
        window.goodbuddy.capabilities.createBrowserProfile?.({ name }) ??
        Promise.reject(new Error('当前版本不支持托管浏览器配置'))
      )
    ) {
      setNewProfileName('')
    }
  }

  const save = async (): Promise<void> => {
    if (!editor) {
      return
    }
    const secret: McpServerInput['secret'] = editor.clearToken
      ? { action: 'clear' }
      : editor.token.trim()
        ? { action: 'replace', value: editor.token }
        : { action: 'keep' }
    const common = {
      name: editor.name,
      description: editor.description,
      enabled: editor.enabled,
      assignments: editor.assignments,
      secret
    }
    const input: McpServerInput =
      editor.transport === 'stdio'
        ? {
            ...common,
            transport: 'stdio',
            command: editor.command,
            args: editor.args
              .split(/\r?\n/u)
              .map((value) => value.trim())
              .filter(Boolean)
          }
        : {
            ...common,
            transport: editor.transport,
            url: editor.url
          }
    const saved = await run('save', () =>
      window.goodbuddy.capabilities.saveMcpServer(editor.id, input)
    )
    if (saved) {
      closeEditor()
    }
  }

  const test = async (server: McpServerSummary): Promise<void> => {
    setBusy(`test:${server.id}`)
    setError(undefined)
    try {
      const result =
        await window.goodbuddy.capabilities.testMcpServer(server.id)
      setTestResults((current) => ({
        ...current,
        [server.id]: result
      }))
      setExpandedItemIds((current) => {
        const next = new Set(current)
        next.add(`custom:${server.id}`)
        return next
      })
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'MCP 连接测试失败'
      )
    } finally {
      setBusy(undefined)
    }
  }

  const updateAssignment = (
    target: RuntimeTarget,
    checked: boolean
  ): void => {
    if (!editor) {
      return
    }
    setEditor({
      ...editor,
      assignments: checked
        ? [...editor.assignments, target]
        : editor.assignments.filter((item) => item !== target)
    })
  }

  const openEditor = (
    nextEditor: McpEditor,
    trigger: HTMLButtonElement
  ): void => {
    editorTriggerRef.current = trigger
    setError(undefined)
    setEditor(nextEditor)
  }

  const closeEditor = (): void => {
    if (busy === 'save') {
      return
    }
    const trigger = editorTriggerRef.current
    editorTriggerRef.current = undefined
    setError(undefined)
    setEditor(undefined)
    requestAnimationFrame(() => trigger?.focus())
  }

  const handleEditorKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>
  ): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
      return
    }
    trapTabFocus(event, editorDialogRef.current)
  }

  const computerCapabilities = snapshot?.computerCapabilities ?? []
  const browserProfiles = snapshot?.browserProfiles ?? {
    profiles: [],
    defaultProfileId: null
  }

  return (
    <div className="settings-section">
      <div className="settings-section__title settings-section__title--actions">
        <Network size={17} />
        <div>
          <strong>工具与 MCP</strong>
          <small>查看内置工具、内置 MCP 并管理外部 MCP Server</small>
        </div>
        <button
          className="secondary-button"
          disabled={Boolean(busy) || Boolean(editor)}
          onClick={(event) =>
            openEditor({ ...emptyEditor }, event.currentTarget)
          }
          type="button"
        >
          <Plus size={14} />
          添加 Server
        </button>
      </div>

      <p className="settings-notice">
        自定义 MCP 当前仅用于直连模型，新建时默认分配给直连模型，并仅在 Execute
        模式加载。内置共享 MCP 提供知识库与全局笔记只读搜索，可供直连模型、
        OpenCode 和 Continue 使用。Runtime 自有 MCP 配置不在此处管理。
      </p>
      <p className="settings-notice">
        内置工具由 GoodBuddy 提供，不属于 MCP Server。自定义 MCP Server
        及其工具具有当前用户权限，请仅添加可信服务；远程访问令牌将由系统安全存储加密，
        工具调用前仍需 GoodBuddy 审批。
      </p>
      {error && !editor && <p className="settings-warning">{error}</p>}

      <section
        aria-labelledby="computer-capabilities-heading"
        className="mcp-tool-section"
      >
        <div className="mcp-subsection-heading">
          <div>
            <MonitorCog size={15} />
            <strong id="computer-capabilities-heading">电脑控制能力</strong>
          </div>
          <small>默认停用，启用后仍遵循审批</small>
        </div>
        <div className="capability-list">
          {computerCapabilities.map((capability) => {
            const report = diagnostics[capability.id]
            return (
              <article className="capability-card" key={capability.id}>
                <div className="capability-card__header">
                  <div>
                    <strong>{capability.name}</strong>
                    <small>
                      {capability.supported ? '当前设备支持' : '当前设备不支持'} ·{' '}
                      {capability.enabled ? '已启用' : '已停用'}
                    </small>
                  </div>
                  <label className="capability-switch">
                    <input
                      aria-label={`启用 ${capability.name}`}
                      checked={capability.enabled}
                      disabled={Boolean(busy) || !capability.supported}
                      onChange={(event) =>
                        void run(`computer:${capability.id}`, () =>
                          window.goodbuddy.capabilities.setComputerCapabilityEnabled?.(
                            capability.id,
                            event.target.checked
                          ) ??
                          Promise.reject(
                            new Error('当前版本不支持电脑控制能力')
                          )
                        )
                      }
                      type="checkbox"
                    />
                    <span>{capability.enabled ? '已启用' : '已停用'}</span>
                  </label>
                </div>
                <p>{capability.description}</p>
                <p className="computer-capability-risk">
                  <CircleAlert aria-hidden="true" size={13} />
                  {capability.riskSummary}
                </p>
                {capability.id === 'host-browser-control' && (
                  <label className="field computer-capability-profile">
                    <span>托管浏览器配置</span>
                    <select
                      aria-label="浏览器控制使用的托管配置"
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        void run('computer:profile', () =>
                          window.goodbuddy.capabilities.setComputerCapabilityBrowserProfile?.(
                            capability.id,
                            event.target.value || null
                          ) ??
                          Promise.reject(
                            new Error('当前版本不支持托管浏览器配置')
                          )
                        )
                      }
                      value={capability.browserProfileId ?? ''}
                    >
                      <option value="">使用默认托管配置</option>
                      {browserProfiles.profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="capability-diagnostic">
                  <button
                    aria-label={`诊断 ${capability.name}`}
                    className="secondary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void diagnose(capability.id)}
                    type="button"
                  >
                    <RefreshCw size={13} />
                    {busy === `diagnose:${capability.id}`
                      ? '诊断中…'
                      : '运行诊断'}
                  </button>
                  {report && (
                    <div aria-live="polite" className="capability-diagnostic__result">
                      <strong>
                        诊断结果：{diagnosticStatusLabels[report.status]}
                      </strong>
                      {report.checks.map((check) => (
                        <p key={check.id}>
                          {check.summary}
                          {check.remedy ? ` 处理建议：${check.remedy}` : ''}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section
        aria-labelledby="browser-profiles-heading"
        className="mcp-tool-section"
      >
        <div className="mcp-subsection-heading">
          <div>
            <Globe2 size={15} />
            <strong id="browser-profiles-heading">托管浏览器配置</strong>
          </div>
          <small>{browserProfiles.profiles.length} 个</small>
        </div>
        <p className="settings-notice">
          每个配置使用 GoodBuddy 管理的隔离存储；界面不会接收或显示可执行路径、命令参数与环境变量。
        </p>
        <div className="browser-profile-create">
          <label className="field">
            <span>新配置名称</span>
            <input
              onChange={(event) => setNewProfileName(event.target.value)}
              placeholder="例如：工作网站"
              value={newProfileName}
            />
          </label>
          <button
            className="secondary-button"
            disabled={Boolean(busy) || !newProfileName.trim()}
            onClick={() => void createProfile()}
            type="button"
          >
            <Plus size={13} />
            创建托管配置
          </button>
        </div>
        <div className="browser-profile-list">
          {browserProfiles.profiles.length === 0 && (
            <p className="settings-empty">尚未创建托管浏览器配置</p>
          )}
          {browserProfiles.profiles.map((profile) => {
            const referenced = computerCapabilities.some(
              (capability) =>
                capability.browserProfileId === profile.id
            )
            return (
              <article className="browser-profile-row" key={profile.id}>
                <label className="field">
                  <span>配置名称</span>
                  <input
                    aria-label={`配置名称 ${profile.name}`}
                    onChange={(event) =>
                      setProfileNames((current) => ({
                        ...current,
                        [profile.id]: event.target.value
                      }))
                    }
                    value={profileNames[profile.id] ?? profile.name}
                  />
                </label>
                <label className="browser-profile-default">
                  <input
                    aria-label={`设为默认配置 ${profile.name}`}
                    checked={
                      browserProfiles.defaultProfileId === profile.id
                    }
                    disabled={Boolean(busy)}
                    name="default-browser-profile"
                    onChange={() =>
                      void run(`profile:default:${profile.id}`, () =>
                        window.goodbuddy.capabilities.setDefaultBrowserProfile?.(
                          profile.id
                        ) ??
                        Promise.reject(
                          new Error('当前版本不支持托管浏览器配置')
                        )
                      )
                    }
                    type="radio"
                  />
                  默认
                </label>
                <button
                  aria-label={`重命名配置 ${profile.name}`}
                  className="secondary-button"
                  disabled={
                    Boolean(busy) ||
                    !(profileNames[profile.id] ?? '').trim() ||
                    profileNames[profile.id] === profile.name
                  }
                  onClick={() =>
                    void run(`profile:rename:${profile.id}`, () =>
                      window.goodbuddy.capabilities.renameBrowserProfile?.({
                        profileId: profile.id,
                        name: profileNames[profile.id] ?? profile.name
                      }) ??
                      Promise.reject(
                        new Error('当前版本不支持托管浏览器配置')
                      )
                    )
                  }
                  type="button"
                >
                  <Pencil size={13} />
                  重命名
                </button>
                <button
                  aria-label={`删除配置 ${profile.name}`}
                  className="danger-ghost"
                  disabled={Boolean(busy) || referenced}
                  onClick={() =>
                    void run(`profile:remove:${profile.id}`, () =>
                      window.goodbuddy.capabilities.removeBrowserProfile?.(
                        profile.id
                      ) ??
                      Promise.reject(
                        new Error('当前版本不支持托管浏览器配置')
                      )
                    )
                  }
                  title={referenced ? '此配置正被电脑控制能力使用' : undefined}
                  type="button"
                >
                  <Trash2 size={13} />
                  删除
                </button>
              </article>
            )
          })}
        </div>
      </section>

      <section
        aria-labelledby="builtin-mcp-heading"
        className="mcp-tool-section"
      >
        <div className="mcp-subsection-heading">
          <div>
            <Database size={15} />
            <span className="mcp-subsection-heading__title">
              <strong id="builtin-mcp-heading">GoodBuddy 内置 MCP</strong>
              <small>可用于：模型、OpenCode、Continue</small>
            </span>
          </div>
          <small>{builtinMcpServers.length} 个</small>
        </div>
        <p className="settings-notice">
          内置 MCP 由 GoodBuddy 在主进程按当前对话签发短期权限，不公开服务地址或凭据。
        </p>
        <div className="mcp-server-list">
          {builtinMcpServers.map((server) => {
            const expansionId = `builtin:${server.id}`
            const expanded = expandedItemIds.has(expansionId)
            const panelId = `mcp-server-tools-${server.id}`
            return (
              <article className="mcp-server-card" key={server.id}>
                <button
                  aria-controls={panelId}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? '收起' : '展开'}服务器 ${server.name}`}
                  className="mcp-server-card__toggle"
                  onClick={() => toggleItem(expansionId)}
                  type="button"
                >
                  <div>
                    <strong>{server.name}</strong>
                    <small>
                      内置 MCP Server · 只读 · 按对话授权
                    </small>
                  </div>
                  <span className="mcp-server-card__summary">
                    {server.tools.length} 个工具
                    <ChevronDown
                      aria-hidden="true"
                      className={
                        expanded
                          ? 'mcp-server-card__chevron mcp-server-card__chevron--expanded'
                          : 'mcp-server-card__chevron'
                      }
                      size={15}
                    />
                  </span>
                </button>
                {expanded && (
                  <div className="mcp-server-card__body" id={panelId}>
                    <p>{server.description}</p>
                    <section
                      aria-label={`${server.name} 工具`}
                      className="mcp-server-tools"
                    >
                      <div className="mcp-server-tools__heading">
                        <strong>工具</strong>
                        <small>{server.tools.length} 个</small>
                      </div>
                      <ul>
                        {server.tools.map((tool) => (
                          <li key={tool.name}>
                            <div>
                              <code>{tool.name}</code>
                              <span className="builtin-tool-badge">
                                只读
                              </span>
                            </div>
                            <p>{tool.description}</p>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </section>

      <div className="mcp-tool-section">
        <div className="mcp-subsection-heading">
          <div>
            <Wrench size={15} />
            <strong>直连模型内置工具</strong>
          </div>
          <small>{builtinModelToolGroups.length} 组</small>
        </div>
        <div className="mcp-server-list">
          {builtinModelToolGroups.map((group) => {
            const expansionId = `model-tools:${group.id}`
            const expanded = expandedItemIds.has(expansionId)
            const panelId = `model-tool-group-${group.id}`
            return (
              <article className="mcp-server-card" key={group.id}>
                <button
                  aria-controls={panelId}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? '收起' : '展开'}工具组 ${group.name}`}
                  className="mcp-server-card__toggle"
                  onClick={() => toggleItem(expansionId)}
                  type="button"
                >
                  <div>
                    <strong>{group.name}</strong>
                    <small>GoodBuddy 直连模型内置能力</small>
                  </div>
                  <span className="mcp-server-card__summary">
                    {group.tools.length} 个工具
                    <ChevronDown
                      aria-hidden="true"
                      className={
                        expanded
                          ? 'mcp-server-card__chevron mcp-server-card__chevron--expanded'
                          : 'mcp-server-card__chevron'
                      }
                      size={15}
                    />
                  </span>
                </button>
                {expanded && (
                  <div className="mcp-server-card__body" id={panelId}>
                    <p>{group.description}</p>
                    <section
                      aria-label={`${group.name} 工具`}
                      className="mcp-server-tools"
                    >
                      <div className="mcp-server-tools__heading">
                        <strong>工具</strong>
                        <small>{group.tools.length} 个</small>
                      </div>
                      <ul>
                        {group.tools.map((tool) => (
                          <li key={tool.name}>
                            <div>
                              <span className="mcp-server-tool__identity">
                                <strong>{tool.displayName}</strong>
                                <code>{tool.name}</code>
                              </span>
                              <span className="builtin-tool-badge">
                                {tool.access === 'write' ? '写入' : '只读'}
                              </span>
                            </div>
                            <p>{tool.description}</p>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </div>

      {editor &&
        createPortal(
          <div
            className="mcp-editor-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                closeEditor()
              }
            }}
          >
            <div
              aria-labelledby="mcp-editor-title"
              aria-modal="true"
              className="mcp-editor"
              onKeyDown={handleEditorKeyDown}
              ref={editorDialogRef}
              role="dialog"
            >
            <div className="mcp-editor__header">
            <strong id="mcp-editor-title">
              {editor.id ? '编辑 MCP Server' : '添加 MCP Server'}
            </strong>
            <button
              aria-label="关闭 MCP 编辑器"
              className="icon-button"
              disabled={busy === 'save'}
              onClick={closeEditor}
              type="button"
            >
              <X size={16} />
            </button>
          </div>
          {error && (
            <p className="settings-warning" role="alert">
              {error}
            </p>
          )}
          <label className="field">
            <span>名称</span>
            <input
              onChange={(event) =>
                setEditor({ ...editor, name: event.target.value })
              }
              ref={editorNameRef}
              value={editor.name}
            />
          </label>
          <label className="field">
            <span>说明</span>
            <input
              onChange={(event) =>
                setEditor({
                  ...editor,
                  description: event.target.value
                })
              }
              value={editor.description}
            />
          </label>
          <label className="field">
            <span>传输方式</span>
            <select
              onChange={(event) =>
                setEditor({
                  ...editor,
                  transport: event.target.value as McpTransport
                })
              }
              value={editor.transport}
            >
              <option value="stdio">stdio（本地进程）</option>
              <option value="http">Streamable HTTP</option>
              <option value="sse">SSE（兼容旧服务）</option>
            </select>
          </label>
          {editor.transport === 'stdio' ? (
            <>
              <label className="field">
                <span>可执行命令或绝对路径</span>
                <input
                  aria-label="MCP 可执行命令"
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      command: event.target.value
                    })
                  }
                  placeholder="例如 npx 或 C:\Tools\server.exe"
                  value={editor.command}
                />
              </label>
              <label className="field">
                <span>参数（每行一个）</span>
                <textarea
                  aria-label="MCP 命令参数"
                  onChange={(event) =>
                    setEditor({ ...editor, args: event.target.value })
                  }
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Workspace'}
                  rows={4}
                  value={editor.args}
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>Server URL</span>
                <input
                  inputMode="url"
                  onChange={(event) =>
                    setEditor({ ...editor, url: event.target.value })
                  }
                  placeholder="https://mcp.example.com/mcp"
                  value={editor.url}
                />
              </label>
              <label className="field">
                <span>Bearer Token</span>
                <input
                  autoComplete="off"
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      token: event.target.value,
                      clearToken: false
                    })
                  }
                  placeholder={
                    editor.id ? '留空保持已保存令牌' : '可选'
                  }
                  type="password"
                  value={editor.token}
                />
              </label>
              {editor.id && (
                <label className="check-field">
                  <input
                    checked={editor.clearToken}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        token: '',
                        clearToken: event.target.checked
                      })
                    }
                    type="checkbox"
                  />
                  <span>保存时清除已保存的 Bearer Token</span>
                </label>
              )}
            </>
          )}
          <label className="check-field">
            <input
              checked={editor.enabled}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  enabled: event.target.checked
                })
              }
              type="checkbox"
            />
            <span>启用此 MCP Server</span>
          </label>
          <div className="runtime-assignments">
            <small>分配给</small>
            {configurableMcpTargets.map(
              (target) => (
                <label key={target}>
                  <input
                    checked={editor.assignments.includes(target)}
                    onChange={(event) =>
                      updateAssignment(target, event.target.checked)
                    }
                    type="checkbox"
                  />
                  {runtimeLabels[target]}
                </label>
              )
            )}
          </div>
          <div className="mcp-editor__actions">
            <button
              className="secondary-button"
              disabled={busy === 'save'}
              onClick={closeEditor}
              type="button"
            >
              取消
            </button>
            <button
              className="primary-button"
              disabled={busy === 'save'}
              onClick={() => void save()}
              type="button"
            >
              {busy === 'save' ? '保存中…' : '保存 MCP Server'}
            </button>
          </div>
            </div>
          </div>,
          document.body
        )}

      <div className="mcp-subsection-heading">
        <div>
          <Network size={15} />
          <strong>自定义 MCP Servers（高级）</strong>
        </div>
        <small>{snapshot?.mcpServers.length ?? 0} 个</small>
      </div>
      <p className="settings-notice">
        自定义 stdio MCP 会以受限环境启动，不会获得桌面会话变量。需要电脑控制时请使用上方经过诊断的内置能力。
      </p>
      <div className="capability-list">
        {snapshot?.mcpServers.length === 0 && !editor && (
          <p className="settings-empty">尚未配置 MCP Server</p>
        )}
        {snapshot?.mcpServers.map((server) => {
          const result = testResults[server.id]
          const expansionId = `custom:${server.id}`
          const expanded = expandedItemIds.has(expansionId)
          const panelId = `mcp-custom-server-${server.id}`
          return (
            <article className="mcp-server-card" key={server.id}>
              <div className="mcp-server-card__header">
                <button
                  aria-controls={panelId}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? '收起' : '展开'}服务器 ${server.name}`}
                  className="mcp-server-card__toggle"
                  onClick={() => toggleItem(expansionId)}
                  type="button"
                >
                  <div>
                    <strong>{server.name}</strong>
                    <small>
                      {server.transport.toUpperCase()} MCP Server ·{' '}
                      {server.enabled ? '已启用' : '已停用'}
                      {server.secretConfigured ? ' · 已加密令牌' : ''}
                    </small>
                  </div>
                  <span className="mcp-server-card__summary">
                    {result ? `${result.toolCount} 个工具` : '工具未检测'}
                    <ChevronDown
                      aria-hidden="true"
                      className={
                        expanded
                          ? 'mcp-server-card__chevron mcp-server-card__chevron--expanded'
                          : 'mcp-server-card__chevron'
                      }
                      size={15}
                    />
                  </span>
                </button>
                <div className="capability-card__actions">
                  <button
                    aria-label={`测试 ${server.name}`}
                    disabled={Boolean(busy)}
                    onClick={() => void test(server)}
                    type="button"
                  >
                    <FlaskConical size={13} />
                    测试
                  </button>
                  <button
                    aria-label={`编辑 ${server.name}`}
                    disabled={Boolean(busy) || Boolean(editor)}
                    onClick={(event) =>
                      openEditor(
                        editorFromServer(server),
                        event.currentTarget
                      )
                    }
                    type="button"
                  >
                    <Pencil size={13} />
                    编辑
                  </button>
                  <button
                    aria-label={`删除 ${server.name}`}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run(`remove:${server.id}`, () =>
                        window.goodbuddy.capabilities.removeMcpServer(
                          server.id
                        )
                      )
                    }
                    type="button"
                  >
                    <Trash2 size={13} />
                    删除
                  </button>
                </div>
              </div>
              {expanded && (
                <div className="mcp-server-card__body" id={panelId}>
                  {server.description && <p>{server.description}</p>}
                  <code>
                    {server.transport === 'stdio'
                      ? [server.command, ...server.args].join(' ')
                      : server.url}
                  </code>
                  <div className="runtime-assignments">
                    <small>已分配：</small>
                    <span>
                      {server.assignments
                        .map((target) => runtimeLabels[target])
                        .join('、') || '无'}
                    </span>
                  </div>
                  {result ? (
                    <section
                      aria-label={`${server.name} 工具`}
                      className="mcp-server-tools"
                    >
                      <div className="mcp-server-tools__heading">
                        <strong>
                          {result.serverName || server.name}
                          {result.serverVersion
                            ? ` ${result.serverVersion}`
                            : ''}
                        </strong>
                        <small>{result.toolCount} 个工具</small>
                      </div>
                      {result.tools.length > 0 ? (
                        <ul>
                          {result.tools.map((tool) => (
                            <li key={tool.name}>
                              <div>
                                <code>{tool.name}</code>
                              </div>
                              {tool.description && (
                                <p>{tool.description}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="settings-empty">
                          服务器未公开可用工具。
                        </p>
                      )}
                    </section>
                  ) : (
                    <p className="settings-empty">
                      点击“测试”连接服务器并读取其工具列表。
                    </p>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}
