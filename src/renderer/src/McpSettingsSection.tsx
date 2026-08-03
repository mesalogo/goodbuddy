import {
  FlaskConical,
  Network,
  Pencil,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  CapabilityAssignments,
  CapabilitySnapshot,
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
      setError(reason instanceof Error ? reason.message : 'MCP 操作失败')
      return false
    } finally {
      setBusy(undefined)
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

  return (
    <div className="settings-section">
      <div className="settings-section__title settings-section__title--actions">
        <Network size={17} />
        <div>
          <strong>MCP Servers</strong>
          <small>支持 stdio、Streamable HTTP 和兼容 SSE</small>
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
        MCP Server 及其工具具有当前用户权限。请仅添加可信服务；远程访问令牌将由系统安全存储加密。
        当前版本仅由直连模型在 Execute 模式加载 MCP 工具，并在每次调用前请求 GoodBuddy 审批。
      </p>
      {error && <p className="settings-warning">{error}</p>}

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
