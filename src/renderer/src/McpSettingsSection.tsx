import {
  CircleAlert,
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
import { useEffect, useState } from 'react'
import { builtinModelTools } from '../../shared/builtin-model-tools'
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
  const [diagnostics, setDiagnostics] = useState<
    Partial<Record<ComputerCapabilityId, CapabilityDiagnosticReport>>
  >({})
  const [newProfileName, setNewProfileName] = useState('')
  const [profileNames, setProfileNames] = useState<Record<string, string>>(
    {}
  )

  useEffect(() => {
    void window.goodbuddy.capabilities
      .getSnapshot()
      .then(setSnapshot)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '读取 MCP 设置失败')
      })
  }, [])

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
        ? { action: 'replace', value: editor.token.trim() }
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
      setEditor(undefined)
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
          <small>查看直连模型内置工具并管理外部 MCP Server</small>
        </div>
        <button
          className="secondary-button"
          disabled={Boolean(busy) || Boolean(editor)}
          onClick={() => setEditor({ ...emptyEditor })}
          type="button"
        >
          <Plus size={14} />
          添加 Server
        </button>
      </div>

      <p className="settings-notice">
        内置工具由 GoodBuddy 提供，不属于 MCP Server。外部 MCP Server
        及其工具具有当前用户权限，请仅添加可信服务；远程访问令牌将由系统安全存储加密。
        当前版本仅由直连模型在 Execute 模式加载这些工具，并在每次调用前请求
        GoodBuddy 审批。
      </p>
      {error && <p className="settings-warning">{error}</p>}

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

      <div className="mcp-tool-section">
        <div className="mcp-subsection-heading">
          <div>
            <Wrench size={15} />
            <strong>直连模型内置工具</strong>
          </div>
          <small>{builtinModelTools.length} 个</small>
        </div>
        <div className="capability-list capability-list--tools">
          {builtinModelTools.map((tool) => (
            <article className="capability-card" key={tool.name}>
              <div className="capability-card__header">
                <div>
                  <strong>{tool.displayName}</strong>
                  <small>
                    GoodBuddy 内置 ·{' '}
                    {tool.access === 'write' ? '写入工具' : '只读工具'}
                  </small>
                </div>
                <span className="builtin-tool-badge">直连模型</span>
              </div>
              <p>{tool.description}</p>
              <code>{tool.name}</code>
            </article>
          ))}
        </div>
      </div>

      {editor && (
        <div className="mcp-editor">
          <div className="mcp-editor__header">
            <strong>{editor.id ? '编辑 MCP Server' : '添加 MCP Server'}</strong>
            <button
              aria-label="关闭 MCP 编辑器"
              className="icon-button"
              onClick={() => setEditor(undefined)}
              type="button"
            >
              <X size={16} />
            </button>
          </div>
          <label className="field">
            <span>名称</span>
            <input
              onChange={(event) =>
                setEditor({ ...editor, name: event.target.value })
              }
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
              onClick={() => setEditor(undefined)}
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
          return (
            <article className="capability-card" key={server.id}>
              <div className="capability-card__header">
                <div>
                  <strong>{server.name}</strong>
                  <small>
                    {server.transport.toUpperCase()} ·{' '}
                    {server.enabled ? '已启用' : '已停用'}
                    {server.secretConfigured ? ' · 已加密令牌' : ''}
                  </small>
                </div>
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
                    onClick={() => setEditor(editorFromServer(server))}
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
              {result && (
                <p className="mcp-test-result">
                  连接成功
                  {result.serverName ? `：${result.serverName}` : ''}
                  {result.serverVersion ? ` ${result.serverVersion}` : ''}，共{' '}
                  {result.toolCount} 个工具
                  {result.tools.length > 0
                    ? `（${result.tools.map((tool) => tool.name).join('、')}）`
                    : ''}
                </p>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}
