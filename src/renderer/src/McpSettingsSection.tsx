import {
  ChevronDown,
  CircleAlert,
  Database,
  FlaskConical,
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
import { useTranslation } from 'react-i18next'
import { builtinMcpServers } from '../../shared/builtin-mcp-servers'
import { builtinModelToolGroups } from '../../shared/builtin-model-tools'
import type {
  BuiltinMcpServerId,
  CapabilityDiagnosticReport,
  CapabilityAssignments,
  CapabilitySnapshot,
  ComputerCapabilityId,
  McpServerInput,
  McpServerSummary,
  McpServerTestResult,
  McpTransport,
  RuntimeTarget,
  WebSearchTestResult
} from '../../shared/capability-contracts'
import { trapTabFocus } from './dialog-focus'
import {
  SettingsCategoryHeader,
  SettingsWarningList
} from './SettingsPrimitives'
import { PageTabs } from './WorkspacePrimitives'

const configurableMcpTargets: RuntimeTarget[] = [
  'model',
  'opencode',
  'continue',
  'deepseek-harness'
]
type McpSettingsTab =
  | 'builtin'
  | 'custom'
  | 'model-tools'
  | 'computer'

type McpEditor = {
  id?: string
  name: string
  description: string
  enabled: boolean
  allowDynamicTools: boolean
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
  allowDynamicTools: false,
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
    allowDynamicTools: server.allowDynamicTools,
    assignments: server.assignments,
    transport: server.transport,
    command: server.transport === 'stdio' ? server.command : '',
    args: server.transport === 'stdio' ? server.args.join('\n') : '',
    url: server.transport === 'stdio' ? '' : server.url,
    token: '',
    clearToken: false
  }
}

export function McpSettingsSection({
  magicNotesEnabled = false
}: {
  magicNotesEnabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const runtimeLabels: Record<RuntimeTarget, string> = {
    model: t('mcp.runtimeLabels.model'),
    opencode: t('mcp.runtimeLabels.opencode'),
    continue: t('mcp.runtimeLabels.continue'),
    'deepseek-harness': 'DeepSeek Harness'
  }
  const diagnosticStatusLabels: Record<
    CapabilityDiagnosticReport['status'],
    string
  > = {
    available: t('mcp.diagnosticStatuses.available'),
    degraded: t('mcp.diagnosticStatuses.degraded'),
    unavailable: t('mcp.diagnosticStatuses.unavailable'),
    disabled: t('mcp.diagnosticStatuses.disabled')
  }
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>()
  const [editor, setEditor] = useState<McpEditor>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [testResults, setTestResults] = useState<
    Record<string, McpServerTestResult>
  >({})
  const [webSearchTestResult, setWebSearchTestResult] =
    useState<WebSearchTestResult>()
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(
    () => new Set()
  )
  const [diagnostics, setDiagnostics] = useState<
    Partial<Record<ComputerCapabilityId, CapabilityDiagnosticReport>>
  >({})
  const [activeTab, setActiveTab] =
    useState<McpSettingsTab>('builtin')
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
        setError(
          reason instanceof Error
            ? reason.message
            : tRef.current('mcp.errors.load')
        )
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
      setError(
        reason instanceof Error
          ? reason.message
          : t('mcp.errors.operation')
      )
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
        throw new Error(t('mcp.errors.unsupportedDiagnostics'))
      }
      const report = await diagnoseCapability(capabilityId)
      setDiagnostics((current) => ({
        ...current,
        [capabilityId]: report
      }))
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('mcp.errors.diagnostics')
      )
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
        ? { action: 'replace', value: editor.token }
        : { action: 'keep' }
    const common = {
      name: editor.name,
      description: editor.description,
      enabled: editor.enabled,
      allowDynamicTools: editor.allowDynamicTools,
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
        reason instanceof Error ? reason.message : t('mcp.errors.test')
      )
    } finally {
      setBusy(undefined)
    }
  }

  const testDirectModelWebSearch = async (): Promise<void> => {
    setBusy('test:web-search')
    setError(undefined)
    try {
      const testCapability =
        window.goodbuddy.capabilities.testWebSearch
      if (!testCapability) {
        throw new Error(t('mcp.webSearch.unsupported'))
      }
      setWebSearchTestResult(await testCapability())
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('mcp.webSearch.testFailed')
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

  const updateBuiltinAssignment = (
    serverId: BuiltinMcpServerId,
    assignments: CapabilityAssignments,
    target: RuntimeTarget,
    checked: boolean
  ): void => {
    const next = checked
      ? [...assignments, target]
      : assignments.filter((item) => item !== target)
    void run(`builtin:assign:${serverId}`, () =>
      window.goodbuddy.capabilities.setBuiltinMcpServerAssignments(
        serverId,
        next
      )
    )
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
  const browserCapability = computerCapabilities.find(
    (capability) => capability.id === 'host-browser-control'
  )
  const desktopCapabilities = computerCapabilities.filter(
    (capability) => capability.id !== 'host-browser-control'
  )
  const builtinMcpStates = new Map(
    snapshot?.builtinMcpServers?.map((server) => [server.id, server])
  )
  const webSearch = snapshot?.webSearch ?? {
    provider: 'exa' as const,
    enabled: true,
    availableIn: ['ask', 'execute'] as const,
    tools: ['web_search', 'web_fetch'] as const
  }

  return (
    <>
      <SettingsCategoryHeader
        actions={
          activeTab === 'custom' ? (
            <button
              className="secondary-button"
              disabled={Boolean(busy) || Boolean(editor)}
              onClick={(event) =>
                openEditor({ ...emptyEditor }, event.currentTarget)
              }
              type="button"
            >
              <Plus aria-hidden="true" size={14} />
              {t('mcp.addServer')}
            </button>
          ) : undefined
        }
        category="mcp"
        error={!editor ? error : undefined}
        headingId="mcp-settings-heading"
      />
      <SettingsWarningList warnings={snapshot?.warnings} />
      <div className="mcp-settings__tabs">
        <PageTabs
          ariaLabel={t('mcp.tabs.ariaLabel')}
          idPrefix="mcp-settings"
          onChange={(tab) => {
            setError(undefined)
            setActiveTab(tab)
          }}
          tabs={[
            {
              id: 'builtin',
              icon: <Database size={14} />,
              label: t('mcp.tabs.builtin')
            },
            {
              id: 'model-tools',
              icon: <Wrench size={14} />,
              label: t('mcp.tabs.modelTools')
            },
            {
              id: 'custom',
              icon: <Network size={14} />,
              label: t('mcp.tabs.custom')
            },
            {
              id: 'computer',
              icon: <MonitorCog size={14} />,
              label: t('mcp.tabs.computer')
            }
          ]}
          value={activeTab}
          variant="segmented"
        />
      </div>
      <section
        aria-labelledby={`mcp-settings-tab-${activeTab}`}
        className="settings-section mcp-settings__panel"
        id={`mcp-settings-panel-${activeTab}`}
        role="tabpanel"
      >

      {activeTab === 'custom' && (
        <p className="settings-notice">
          {t('mcp.customNotice')}
        </p>
      )}
      {activeTab === 'computer' && (
        <section
        aria-labelledby="computer-capabilities-heading"
        className="mcp-tool-section"
      >
        <div className="mcp-subsection-heading">
          <div>
            <MonitorCog size={15} />
            <strong id="computer-capabilities-heading">
              {t('mcp.computer.title')}
            </strong>
          </div>
        </div>
        <div className="capability-list">
          {desktopCapabilities.map((capability) => {
            const report = diagnostics[capability.id]
            return (
              <article className="capability-card" key={capability.id}>
                <div className="capability-card__header">
                  <div>
                    <strong>{capability.name}</strong>
                    <small>
                      {capability.supported
                        ? t('mcp.computer.supported')
                        : t('mcp.computer.unsupported')}
                    </small>
                  </div>
                </div>
                <label className="toggle-row">
                  <input
                    aria-label={t('mcp.computer.enableAriaLabel', {
                      name: capability.name
                    })}
                    checked={capability.enabled}
                    disabled={Boolean(busy) || !capability.supported}
                    onChange={(event) =>
                      void run(`computer:${capability.id}`, () =>
                        window.goodbuddy.capabilities.setComputerCapabilityEnabled?.(
                          capability.id,
                          event.target.checked
                        ) ??
                        Promise.reject(
                          new Error(
                            t('mcp.errors.unsupportedComputerControl')
                          )
                        )
                      )
                    }
                    role="switch"
                    type="checkbox"
                  />
                  <span>{t('mcp.computer.enable')}</span>
                </label>
                <p>{capability.description}</p>
                <p className="computer-capability-risk">
                  <CircleAlert aria-hidden="true" size={13} />
                  {capability.riskSummary}
                </p>
                <div className="capability-diagnostic">
                  <button
                    aria-label={t('mcp.computer.diagnoseAriaLabel', {
                      name: capability.name
                    })}
                    className="secondary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void diagnose(capability.id)}
                    type="button"
                  >
                    <RefreshCw size={13} />
                    {busy === `diagnose:${capability.id}`
                      ? t('mcp.computer.diagnosing')
                      : t('mcp.computer.diagnose')}
                  </button>
                  {report && (
                    <div aria-live="polite" className="capability-diagnostic__result">
                      <strong>
                        {t('mcp.computer.result', {
                          status: diagnosticStatusLabels[report.status]
                        })}
                      </strong>
                      {report.checks.map((check) => (
                        <p key={check.id}>
                          {check.summary}
                          {check.remedy
                            ? t('mcp.computer.remedy', {
                                remedy: check.remedy
                              })
                            : ''}
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
      )}

      {activeTab === 'builtin' && (
      <section
        aria-labelledby="builtin-mcp-heading"
        className="mcp-tool-section"
      >
        <div className="mcp-subsection-heading">
          <div>
            <Database size={15} />
            <strong id="builtin-mcp-heading">
              {t('mcp.builtin.title')}
            </strong>
          </div>
          <small>
            {t('mcp.profiles.count', {
              count: builtinMcpServers.length
            })}
          </small>
        </div>
        <div className="mcp-server-list">
          {builtinMcpServers.map((server) => {
            const expansionId = `builtin:${server.id}`
            const expanded = expandedItemIds.has(expansionId)
            const panelId = `mcp-server-tools-${server.id}`
            const state = builtinMcpStates.get(server.id) ?? {
              id: server.id,
              enabled: true,
              assignments:
                [...server.supportedAssignments] as CapabilityAssignments
            }
            const featureAvailable =
              !('requiresFeature' in server) ||
              magicNotesEnabled === true
            return (
              <article
                className={`capability-card builtin-mcp-card${
                  state.enabled && featureAvailable
                    ? ''
                    : ' capability-card--disabled'
                }`}
                key={server.id}
              >
                <div className="capability-card__header">
                  <div>
                    <strong>{server.name}</strong>
                    <small>
                      {!state.enabled
                        ? t('mcp.builtin.disabled')
                        : !featureAvailable
                        ? t('mcp.builtin.serverSummaryDisabled')
                        : server.access === 'mixed'
                          ? t('mcp.builtin.serverSummaryMixed')
                          : t('mcp.builtin.serverSummaryReadOnly')}
                    </small>
                  </div>
                </div>
                <label className="toggle-row">
                  <input
                    aria-label={t('mcp.builtin.enableAriaLabel', {
                      name: server.name
                    })}
                    checked={state.enabled}
                    disabled={Boolean(busy)}
                    onChange={(event) =>
                      void run(`builtin:toggle:${server.id}`, () =>
                        window.goodbuddy.capabilities.setBuiltinMcpServerEnabled(
                          server.id,
                          event.target.checked
                        )
                      )
                    }
                    role="switch"
                    type="checkbox"
                  />
                  <span>
                    {state.enabled
                      ? t('mcp.builtin.enabled')
                      : t('mcp.builtin.disabled')}
                  </span>
                </label>
                <p>{server.description}</p>
                {!featureAvailable && (
                  <p className="computer-capability-risk">
                    <CircleAlert aria-hidden="true" size={13} />
                    {t('mcp.builtin.featureDisabled')}
                  </p>
                )}
                <div className="runtime-assignments">
                  <small>{t('mcp.builtin.assignedTo')}</small>
                  {configurableMcpTargets.map((target) => {
                    const unsupported =
                      !server.supportedAssignments.some(
                        (supportedTarget) =>
                          supportedTarget === target
                      )
                    return (
                      <label
                        className={
                          unsupported
                            ? 'runtime-assignment--unsupported'
                            : undefined
                        }
                        key={target}
                        title={
                          unsupported
                            ? t('mcp.builtin.runtimeUnsupported')
                            : undefined
                        }
                      >
                        <input
                          aria-label={
                            unsupported
                              ? t(
                                  'mcp.builtin.runtimeAssignmentUnsupportedAriaLabel',
                                  {
                                    name: server.name,
                                    runtime: runtimeLabels[target]
                                  }
                                )
                              : undefined
                          }
                          checked={
                            !unsupported &&
                            state.assignments.includes(target)
                          }
                          disabled={Boolean(busy) || unsupported}
                          onChange={(event) =>
                            updateBuiltinAssignment(
                              server.id,
                              state.assignments,
                              target,
                              event.target.checked
                            )
                          }
                          type="checkbox"
                        />
                        {runtimeLabels[target]}
                        {unsupported
                          ? t('mcp.builtin.unsupportedSuffix')
                          : ''}
                      </label>
                    )
                  })}
                </div>
                <button
                  aria-controls={panelId}
                  aria-expanded={expanded}
                  aria-label={t(
                    expanded
                      ? 'mcp.builtin.collapseServer'
                      : 'mcp.builtin.expandServer',
                    { name: server.name }
                  )}
                  className="secondary-button builtin-mcp-card__details"
                  onClick={() => toggleItem(expansionId)}
                  type="button"
                >
                  {t('mcp.builtin.toolCount', {
                    count: server.tools.length
                  })}
                  <ChevronDown
                    aria-hidden="true"
                    className={
                      expanded
                        ? 'mcp-server-card__chevron mcp-server-card__chevron--expanded'
                        : 'mcp-server-card__chevron'
                    }
                    size={15}
                  />
                </button>
                {expanded && (
                  <div
                    className="builtin-mcp-card__tools"
                    id={panelId}
                  >
                    <section
                      aria-label={t('mcp.builtin.toolsAriaLabel', {
                        name: server.name
                      })}
                      className="mcp-server-tools"
                    >
                      <div className="mcp-server-tools__heading">
                        <strong>{t('mcp.builtin.tools')}</strong>
                        <small>
                          {t('mcp.profiles.count', {
                            count: server.tools.length
                          })}
                        </small>
                      </div>
                      <ul>
                        {server.tools.map((tool) => (
                          <li key={tool.name}>
                            <div>
                              <code>{tool.name}</code>
                              <span className="builtin-tool-badge">
                                {tool.access === 'write'
                                  ? t('mcp.builtin.write')
                                  : t('mcp.builtin.readOnly')}
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
      )}

      {activeTab === 'model-tools' && (
      <div className="mcp-tool-section">
        <div className="mcp-subsection-heading">
          <div>
            <Wrench size={15} />
            <strong>{t('mcp.modelTools.title')}</strong>
          </div>
          <small>
            {t('mcp.modelTools.groupCount', {
              count: builtinModelToolGroups.length
            })}
          </small>
        </div>
        <div className="mcp-server-list">
          {builtinModelToolGroups
            .filter((group) => group.id === 'web')
            .map((group) => {
              const expansionId = `model-tools:${group.id}`
              const expanded = expandedItemIds.has(expansionId)
              const panelId = `model-tool-group-${group.id}`
              return (
                <article className="mcp-server-card" key={group.id}>
                  <button
                    aria-controls={panelId}
                    aria-expanded={expanded}
                    aria-label={t(
                      expanded
                        ? 'mcp.modelTools.collapseGroup'
                        : 'mcp.modelTools.expandGroup',
                      { name: t('mcp.webSearch.title') }
                    )}
                    className="mcp-server-card__toggle"
                    onClick={() => toggleItem(expansionId)}
                    type="button"
                  >
                    <div>
                      <strong>{t('mcp.webSearch.title')}</strong>
                      <small>{t('mcp.webSearch.subtitle')}</small>
                    </div>
                    <span className="mcp-server-card__summary">
                      {t('mcp.builtin.toolCount', {
                        count: group.tools.length
                      })}
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
                      <label className="toggle-row">
                        <input
                          aria-label={t('mcp.webSearch.enableAriaLabel')}
                          checked={webSearch.enabled}
                          disabled={Boolean(busy)}
                          onChange={(event) =>
                            void run('web-search:toggle', () =>
                              window.goodbuddy.capabilities.setWebSearchEnabled?.(
                                event.target.checked
                              ) ??
                              Promise.reject(
                                new Error(t('mcp.webSearch.unsupported'))
                              )
                            )
                          }
                          role="switch"
                          type="checkbox"
                        />
                        <span>
                          {webSearch.enabled
                            ? t('mcp.webSearch.enabled')
                            : t('mcp.webSearch.disabled')}
                        </span>
                      </label>
                      <p>{t('mcp.webSearch.description')}</p>
                      <p className="computer-capability-risk">
                        <CircleAlert aria-hidden="true" size={13} />
                        {t('mcp.webSearch.privacy')}
                      </p>
                      <div className="capability-card__actions">
                        <button
                          className="secondary-button"
                          disabled={Boolean(busy)}
                          onClick={() => void testDirectModelWebSearch()}
                          type="button"
                        >
                          <FlaskConical aria-hidden="true" size={13} />
                          {busy === 'test:web-search'
                            ? t('mcp.webSearch.testing')
                            : t('mcp.webSearch.test')}
                        </button>
                      </div>
                      {webSearchTestResult && (
                        <div
                          aria-label={t(
                            'mcp.webSearch.resultAriaLabel'
                          )}
                          className="capability-diagnostic__result"
                        >
                          <strong>
                            {t('mcp.webSearch.result', {
                              duration:
                                webSearchTestResult.durationMs
                            })}
                          </strong>
                          <p>{webSearchTestResult.preview}</p>
                        </div>
                      )}
                      <section
                        aria-label={t(
                          'mcp.webSearch.toolsAriaLabel'
                        )}
                        className="mcp-server-tools"
                      >
                        <div className="mcp-server-tools__heading">
                          <strong>{t('mcp.builtin.tools')}</strong>
                          <small>
                            {t('mcp.profiles.count', {
                              count: group.tools.length
                            })}
                          </small>
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
                                  {t('mcp.builtin.readOnly')}
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
          {builtinModelToolGroups
            .filter((group) => group.id !== 'web')
            .map((group) => {
            const expansionId = `model-tools:${group.id}`
            const expanded = expandedItemIds.has(expansionId)
            const panelId = `model-tool-group-${group.id}`
            const groupName =
              group.id === 'browser'
                ? t('mcp.browser.title')
                : group.name
            const groupDescription =
              group.id === 'browser'
                ? t('mcp.browser.description')
                : group.description
            const report =
              group.id === 'browser' && browserCapability
                ? diagnostics[browserCapability.id]
                : undefined
            return (
              <article className="mcp-server-card" key={group.id}>
                <button
                  aria-controls={panelId}
                  aria-expanded={expanded}
                  aria-label={t(
                    expanded
                      ? 'mcp.modelTools.collapseGroup'
                      : 'mcp.modelTools.expandGroup',
                    { name: groupName }
                  )}
                  className="mcp-server-card__toggle"
                  onClick={() => toggleItem(expansionId)}
                  type="button"
                >
                  <div>
                    <strong>{groupName}</strong>
                    <small>
                      {group.id === 'browser'
                        ? t('mcp.browser.subtitle')
                        : t('mcp.modelTools.summary')}
                    </small>
                  </div>
                  <span className="mcp-server-card__summary">
                    {t('mcp.builtin.toolCount', {
                      count: group.tools.length
                    })}
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
                    {group.id === 'browser' && browserCapability ? (
                      <>
                        <label className="toggle-row">
                          <input
                            aria-label={t(
                              'mcp.browser.enableAriaLabel'
                            )}
                            checked={browserCapability.enabled}
                            disabled={
                              Boolean(busy) ||
                              !browserCapability.supported
                            }
                            onChange={(event) =>
                              void run(
                                `browser:${browserCapability.id}`,
                                () =>
                                  window.goodbuddy.capabilities.setComputerCapabilityEnabled?.(
                                    browserCapability.id,
                                    event.target.checked
                                  ) ??
                                  Promise.reject(
                                    new Error(
                                      t(
                                        'mcp.errors.unsupportedBuiltinBrowser'
                                      )
                                    )
                                  )
                              )
                            }
                            role="switch"
                            type="checkbox"
                          />
                          <span>
                            {browserCapability.enabled
                              ? t('mcp.browser.enabled')
                              : t('mcp.browser.disabled')}
                          </span>
                        </label>
                        <p>{groupDescription}</p>
                        <p className="computer-capability-risk">
                          <CircleAlert aria-hidden="true" size={13} />
                          {t('mcp.browser.control')}
                        </p>
                        <div className="capability-diagnostic">
                          <button
                            aria-label={t(
                              'mcp.browser.diagnoseAriaLabel'
                            )}
                            className="secondary-button"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              void diagnose(browserCapability.id)
                            }
                            type="button"
                          >
                            <RefreshCw size={13} />
                            {busy ===
                            `diagnose:${browserCapability.id}`
                              ? t('mcp.computer.diagnosing')
                              : t('mcp.computer.diagnose')}
                          </button>
                          {report && (
                            <div
                              aria-live="polite"
                              className="capability-diagnostic__result"
                            >
                              <strong>
                                {t('mcp.computer.result', {
                                  status:
                                    diagnosticStatusLabels[
                                      report.status
                                    ]
                                })}
                              </strong>
                              {report.checks.map((check) => (
                                <p key={check.id}>
                                  {check.summary}
                                  {check.remedy
                                    ? t('mcp.computer.remedy', {
                                        remedy: check.remedy
                                      })
                                    : ''}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <p>{groupDescription}</p>
                    )}
                    <section
                      aria-label={
                        group.id === 'browser'
                          ? t('mcp.browser.toolsAriaLabel')
                          : t('mcp.builtin.toolsAriaLabel', {
                              name: groupName
                            })
                      }
                      className="mcp-server-tools"
                    >
                      <div className="mcp-server-tools__heading">
                        <strong>{t('mcp.builtin.tools')}</strong>
                        <small>
                          {t('mcp.profiles.count', {
                            count: group.tools.length
                          })}
                        </small>
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
                                {tool.access === 'write'
                                  ? t('mcp.builtin.write')
                                  : t('mcp.builtin.readOnly')}
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
      )}

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
              {editor.id
                ? t('mcp.editor.editTitle')
                : t('mcp.editor.addTitle')}
            </strong>
            <button
              aria-label={t('mcp.editor.closeAriaLabel')}
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
            <span>{t('mcp.editor.name')}</span>
            <input
              onChange={(event) =>
                setEditor({ ...editor, name: event.target.value })
              }
              ref={editorNameRef}
              value={editor.name}
            />
          </label>
          <label className="field">
            <span>{t('mcp.editor.description')}</span>
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
            <span>{t('mcp.editor.transport')}</span>
            <select
              onChange={(event) =>
                setEditor({
                  ...editor,
                  transport: event.target.value as McpTransport
                })
              }
              value={editor.transport}
            >
              <option value="stdio">{t('mcp.editor.stdio')}</option>
              <option value="http">Streamable HTTP</option>
              <option value="sse">{t('mcp.editor.sse')}</option>
            </select>
          </label>
          {editor.transport === 'stdio' ? (
            <>
              <label className="field">
                <span>{t('mcp.editor.command')}</span>
                <input
                  aria-label={t('mcp.editor.commandAriaLabel')}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      command: event.target.value
                    })
                  }
                  placeholder={t('mcp.editor.commandPlaceholder')}
                  value={editor.command}
                />
              </label>
              <label className="field">
                <span>{t('mcp.editor.args')}</span>
                <textarea
                  aria-label={t('mcp.editor.argsAriaLabel')}
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
                    editor.id
                      ? t('mcp.editor.savedTokenPlaceholder')
                      : t('mcp.editor.optional')
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
                  <span>{t('mcp.editor.clearToken')}</span>
                </label>
              )}
            </>
          )}
          <label className="toggle-row">
            <input
              checked={editor.enabled}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  enabled: event.target.checked
                })
              }
              role="switch"
              type="checkbox"
            />
            <span>{t('mcp.editor.enable')}</span>
          </label>
          <label className="toggle-row">
            <input
              aria-label={t('mcp.editor.allowDynamicTools')}
              checked={editor.allowDynamicTools}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  allowDynamicTools: event.target.checked
                })
              }
              role="switch"
              type="checkbox"
            />
            <span>{t('mcp.editor.allowDynamicTools')}</span>
          </label>
          <p className="settings-notice">
            {t('mcp.editor.allowDynamicToolsDescription')}
          </p>
          <div className="runtime-assignments">
            <small>{t('mcp.editor.assignTo')}</small>
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
              {t('mcp.editor.cancel')}
            </button>
            <button
              className="primary-button"
              disabled={busy === 'save'}
              onClick={() => void save()}
              type="button"
            >
              {busy === 'save'
                ? t('mcp.editor.saving')
                : t('mcp.editor.save')}
            </button>
          </div>
            </div>
          </div>,
          document.body
        )}

      {activeTab === 'custom' && (
        <>
        <div className="mcp-subsection-heading">
        <div>
          <Network size={15} />
          <strong>{t('mcp.custom.title')}</strong>
        </div>
        <small>
          {t('mcp.custom.count', {
            count: snapshot?.mcpServers.length ?? 0
          })}
        </small>
      </div>
      <div className="capability-list">
        {snapshot?.mcpServers.length === 0 && !editor && (
          <p className="settings-empty">{t('mcp.custom.empty')}</p>
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
                  aria-label={t(
                    expanded
                      ? 'mcp.custom.collapseServer'
                      : 'mcp.custom.expandServer',
                    { name: server.name }
                  )}
                  className="mcp-server-card__toggle"
                  onClick={() => toggleItem(expansionId)}
                  type="button"
                >
                  <div>
                    <strong>{server.name}</strong>
                    <small>
                      {server.transport.toUpperCase()} MCP Server ·{' '}
                      {server.enabled
                        ? t('mcp.custom.enabled')
                        : t('mcp.custom.disabled')}
                      {server.secretConfigured
                        ? t('mcp.custom.encryptedToken')
                        : ''}
                      {server.allowDynamicTools
                        ? t('mcp.custom.dynamicToolsEnabled')
                        : ''}
                    </small>
                  </div>
                  <span className="mcp-server-card__summary">
                    {result
                      ? t('mcp.custom.contentCounts', {
                          tools: result.toolCount,
                          prompts: result.promptCount ?? 0,
                          resources: result.resourceCount ?? 0
                        })
                      : t('mcp.custom.toolsUndetected')}
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
                    aria-label={t('mcp.custom.testAriaLabel', {
                      name: server.name
                    })}
                    disabled={Boolean(busy)}
                    onClick={() => void test(server)}
                    type="button"
                  >
                    <FlaskConical size={13} />
                    {t('mcp.custom.test')}
                  </button>
                  <button
                    aria-label={t('mcp.custom.editAriaLabel', {
                      name: server.name
                    })}
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
                    {t('mcp.custom.edit')}
                  </button>
                  <button
                    aria-label={t('mcp.custom.deleteAriaLabel', {
                      name: server.name
                    })}
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
                    {t('mcp.custom.delete')}
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
                    <small>{t('mcp.custom.assigned')}</small>
                    <span>
                      {server.assignments
                        .map((target) => runtimeLabels[target])
                        .join(t('mcp.custom.assignmentSeparator')) ||
                        t('mcp.custom.none')}
                    </span>
                  </div>
                  {result ? (
                    <>
                      <p>
                        {result.dynamicToolsSupported
                          ? t('mcp.custom.dynamicToolsSupported')
                          : t('mcp.custom.dynamicToolsUnsupported')}
                      </p>
                      <section
                        aria-label={t('mcp.builtin.toolsAriaLabel', {
                          name: server.name
                        })}
                        className="mcp-server-tools"
                      >
                        <div className="mcp-server-tools__heading">
                          <strong>
                            {result.serverName || server.name}
                            {result.serverVersion
                              ? ` ${result.serverVersion}`
                              : ''}
                          </strong>
                          <small>
                            {t('mcp.builtin.toolCount', {
                              count: result.toolCount
                            })}
                          </small>
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
                            {t('mcp.custom.noTools')}
                          </p>
                        )}
                      </section>
                      <section
                        aria-label={t('mcp.custom.promptsAriaLabel', {
                          name: server.name
                        })}
                        className="mcp-server-tools"
                      >
                        <div className="mcp-server-tools__heading">
                          <strong>{t('mcp.custom.prompts')}</strong>
                          <small>
                            {result.promptsSupported
                              ? t('mcp.custom.promptCount', {
                                  count: result.promptCount ?? 0
                                })
                              : t('mcp.custom.notSupported')}
                          </small>
                        </div>
                        {result.prompts?.length ? (
                          <ul>
                            {result.prompts.map((prompt) => (
                              <li key={prompt.name}>
                                <div>
                                  <code>{prompt.name}</code>
                                </div>
                                {prompt.description && (
                                  <p>{prompt.description}</p>
                                )}
                                {prompt.arguments.length > 0 && (
                                  <small>
                                    {t('mcp.custom.promptArguments', {
                                      names: prompt.arguments
                                        .map((argument) =>
                                          argument.required
                                            ? `${argument.name}*`
                                            : argument.name
                                        )
                                        .join(', ')
                                    })}
                                  </small>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : result.promptsSupported ? (
                          <p className="settings-empty">
                            {t('mcp.custom.noPrompts')}
                          </p>
                        ) : null}
                      </section>
                      <section
                        aria-label={t('mcp.custom.resourcesAriaLabel', {
                          name: server.name
                        })}
                        className="mcp-server-tools"
                      >
                        <div className="mcp-server-tools__heading">
                          <strong>{t('mcp.custom.resources')}</strong>
                          <small>
                            {result.resourcesSupported
                              ? t('mcp.custom.resourceCount', {
                                  count: result.resourceCount ?? 0
                                })
                              : t('mcp.custom.notSupported')}
                          </small>
                        </div>
                        {result.resources?.length ? (
                          <ul>
                            {result.resources.map((resource) => (
                              <li key={`${resource.uri}\0${resource.name}`}>
                                <div>
                                  <strong>{resource.name}</strong>
                                  {resource.mimeType && (
                                    <small>{resource.mimeType}</small>
                                  )}
                                </div>
                                <code>{resource.uri}</code>
                                {resource.description && (
                                  <p>{resource.description}</p>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : result.resourcesSupported ? (
                          <p className="settings-empty">
                            {t('mcp.custom.noResources')}
                          </p>
                        ) : null}
                      </section>
                    </>
                  ) : (
                    <p className="settings-empty">
                      {t('mcp.custom.testHelp')}
                    </p>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
        </>
      )}
      </section>
    </>
  )
}
