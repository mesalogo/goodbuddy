import '@testing-library/jest-dom/vitest'
import {
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantHeartbeatConfig,
  AssistantHeartbeatEntry,
  AssistantHeartbeatRun,
  AssistantMemory,
  AssistantTask
} from '../../shared/assistant-contracts'
import {
  builtInDefaultProjectSeedDescription,
  builtInDefaultProjectSeedName
} from '../../shared/assistant-contracts'
import { HeartbeatCenter, type HeartbeatCenterProps } from './HeartbeatCenter'
import { supervisionRunRequestSchema } from '../../shared/supervision-contracts'
import { PageShell } from './WorkspacePrimitives'
import i18n from './i18n'
import { WorkspaceUnsavedChangesContext } from './workspace-unsaved-changes'
import { applicationSettingsSchema, defaultLocalToolEnvironmentSettings } from '../../shared/application-settings-contracts'
import type { RuntimeSettings } from '../../shared/contracts'

afterEach(cleanup)

const config: AssistantHeartbeatConfig = {
  id: 'heartbeat-1',
  scope: {
    kind: 'projects',
    projectIds: ['00000000-0000-4000-8000-000000000101']
  },
  name: '定期回顾',
  timezone: 'Asia/Shanghai',
  recurrence: {
    type: 'daily',
    localTime: '09:00'
  },
  enabled: true,
  lookbackHours: 48,
  retentionDays: 90,
  nextRunAt: '2026-08-02T01:00:00.000Z',
  lastRunAt: '2026-08-01T01:00:00.000Z',
  lastStatus: 'completed',
  createdAt: '2026-07-31T01:00:00.000Z',
  updatedAt: '2026-08-01T01:00:00.000Z'
}

const runs: AssistantHeartbeatRun[] = [
  {
    id: 'run-completed',
    configId: config.id,
    trigger: 'scheduled',
    scheduledFor: '2026-08-01T01:00:00.000Z',
    status: 'completed',
    attemptCount: 1,
    completedAt: '2026-08-01T01:00:30.000Z',
    entryId: 'entry-1',
    createdAt: '2026-08-01T01:00:00.000Z',
    updatedAt: '2026-08-01T01:00:30.000Z'
  },
  {
    id: 'run-failed',
    configId: config.id,
    trigger: 'manual',
    scheduledFor: '2026-07-31T01:00:00.000Z',
    status: 'failed',
    attemptCount: 2,
    error: '模型暂时不可用',
    createdAt: '2026-07-31T01:00:00.000Z',
    updatedAt: '2026-07-31T01:01:00.000Z'
  }
]

const entry: AssistantHeartbeatEntry = {
  id: 'entry-1',
  configId: config.id,
  runId: 'run-completed',
  scheduledFor: '2026-08-01T01:00:00.000Z',
  summary: '本次心跳发现用户偏好简洁回复，并建议整理交付计划。',
  highlights: ['回复偏好已经稳定', '项目存在一个待整理的交付计划'],
  proposedMemoryIds: ['memory-1'],
  followUpTaskIds: ['task-1'],
  createdAt: '2026-08-01T01:00:30.000Z'
}

const memory: AssistantMemory = {
  id: 'memory-1',
  scope: 'global',
  type: 'preference',
  content: '用户偏好简洁且可执行的中文回复。',
  confidence: 0.92,
  salience: 0.88,
  status: 'proposed',
  createdAt: '2026-08-01T01:00:30.000Z',
  updatedAt: '2026-08-01T01:00:30.000Z'
}

const task: AssistantTask = {
  id: 'task-1',
  title: '整理交付计划',
  instructions: '梳理当前任务并形成明确的交付步骤。',
  origin: 'assistant',
  status: 'paused',
  createdAt: '2026-08-01T01:00:30.000Z'
}

function createProps(
  overrides: Partial<HeartbeatCenterProps> = {}
): HeartbeatCenterProps {
  return {
    configs: [config],
    runs,
    entries: [entry],
    memories: [memory],
    projects: [
      {
        id: '00000000-0000-4000-8000-000000000101',
        name: builtInDefaultProjectSeedName,
        description: builtInDefaultProjectSeedDescription,
        rootPath: 'C:\\Workspace',
        executionSpace: {
          kind: 'local',
          rootPath: 'C:\\Workspace'
        },
        defaultWorkMode: 'ask',
        kind: 'user',
        builtInDefault: true,
        status: 'active',
        createdAt: '2026-07-31T01:00:00.000Z',
        updatedAt: '2026-07-31T01:00:00.000Z'
      }
    ],
    tasks: [task],
    onCreate: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => {}),
    onSetPaused: vi.fn(async () => {}),
    onRemove: vi.fn(async () => {}),
    onRunNow: vi.fn(async () => {}),
    onRefresh: vi.fn(async () => {}),
    onRetryLoad: vi.fn(async () => {}),
    onSetMemoryStatus: vi.fn(async () => {}),
    onSetTaskStatus: vi.fn(async () => {}),
    onUseFollowUpTask: vi.fn(),
    ...overrides
  }
}

it('graph navigation reopens the graph tab on repeated requests and preserves normal tab changes', async () => {
  const graph = vi.fn(async () => ({ storyLine: null, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
  window.goodbuddy = { supervision: { execution: async () => ({ active: false }), overview: async () => [], graph } } as never
  const props = createProps({ graphNavigation: { resultId: 'A' } })
  const view = renderComponent(<HeartbeatCenter {...props} />)
  const tab = screen.getByRole('tab', { name: '故事线图谱' })
  expect(tab).toHaveAttribute('aria-selected', 'true')
  expect(tab).toHaveFocus()
  await waitFor(() => expect(graph).toHaveBeenCalledTimes(1))
  fireEvent.keyDown(tab, { key: 'ArrowLeft' })
  expect(screen.getByRole('tab', { name: '工作回顾' })).toHaveAttribute('aria-selected', 'true')
  view.rerender(<HeartbeatCenter {...props} />)
  expect(screen.getByRole('tab', { name: '工作回顾' })).toHaveAttribute('aria-selected', 'true')
  view.rerender(<HeartbeatCenter {...props} graphNavigation={{ resultId: 'A' }} />)
  expect(tab).toHaveAttribute('aria-selected', 'true')
  expect(tab).toHaveFocus()
  await waitFor(() => expect(graph).toHaveBeenCalledTimes(2))
})

describe('HeartbeatCenter', () => {
  beforeEach(() => {
    vi.stubGlobal('goodbuddy', { supervision: {
      execution: vi.fn(async () => ({ active: false })),
      overview: vi.fn(async () => []),
      graph: vi.fn(async () => ({ storyLine: null, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    } })
  })
  function render(ui: React.ReactElement, overview = false) {
    const result = renderComponent(ui)
    fireEvent.click(screen.getByRole('tab', { name: i18n.t(overview ? 'activity.title' : 'supervisor.automatic', { ns: 'heartbeat' }) }))
    return result
  }
  afterEach(async () => {
    vi.unstubAllGlobals()
    await i18n.changeLanguage('zh-CN')
  })

  it.each(['zh-CN', 'en-US'])('keeps tab titles unique and preserves content titles, scope and actions (%s)', async (language) => {
    await i18n.changeLanguage(language)
    const t = (key: string) => i18n.t(key, { ns: 'heartbeat' })
    vi.stubGlobal('goodbuddy', { supervision: {
      execution: vi.fn(async () => ({ active: false })),
      overview: vi.fn(async () => [{ id: 'result', storyLineId: 'story', sourceId: null, summary: 'Review summary', changeDigest: '', createdAt: '2026-09-22T00:00:00Z', scope: { kind: 'global' }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z' }, openItems: [] }]),
      activity: vi.fn(async () => []),
      graph: vi.fn(async () => ({ storyLine: { id: 'story', scope_json: JSON.stringify({ kind: 'global' }) }, events: [
        { id: 'event', title: 'Review event', description: 'Progress', occurred_at: '2026-09-21T00:00:00.000Z' }
      ], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    } })
    const props = createProps()
    renderComponent(<PageShell variant="supervisor"><HeartbeatCenter {...props} /></PageShell>)
    await screen.findByText('Review summary')
    expect(screen.getByRole('heading', { level: 1, name: t('center.title') }).closest('.page-shell')).toHaveClass('page-shell--supervisor')
    expect(screen.getByRole('heading', { name: t('supervisor.latest') })).toBeVisible()
    expect(screen.getByRole('button', { name: t('supervisor.run') })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: t('supervisor.scope') })).toBeVisible()
    expect(screen.queryByText(t('supervisor.sourcesHint'))).not.toBeInTheDocument()
    const pageTabKeys = ['supervisor.recap', 'supervisor.graph', 'supervisor.automatic', 'activity.title', 'supervisor.settings']
    for (const key of pageTabKeys) {
      const navigation = screen.getByRole('tablist', { name: t('supervisor.navigation') })
      expect(within(navigation).getAllByRole('tab')).toEqual(pageTabKeys.map((tabKey) => within(navigation).getByRole('tab', { name: t(tabKey) })))
      const activeTab = within(navigation).getByRole('tab', { name: t(key) })
      fireEvent.click(activeTab)
      const panel = screen.getByRole('tabpanel', { name: t(key) })
      expect(within(navigation).getAllByRole('tab', { selected: true })).toEqual([activeTab])
      expect(activeTab).toHaveAttribute('aria-controls', panel.id)
      expect(panel).toHaveAttribute('aria-labelledby', activeTab.id)
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(within(panel).queryByRole('heading', { name: t(key) })).not.toBeInTheDocument()
      expect(within(panel).queryByRole('tablist', { name: t('supervisor.navigation') })).not.toBeInTheDocument()
      if (key === 'supervisor.settings') {
        const settingsNavigation = within(panel).getByRole('tablist', { name: t('settingsTabs.label') })
        expect(screen.getAllByRole('tablist')).toEqual([navigation, settingsNavigation])
        expect(within(settingsNavigation).getAllByRole('tab').map((tab) => tab.textContent))
          .toEqual(['model', 'review', 'stories', 'suggestions'].map((id) => t(`settingsTabs.${id}`)))
      } else if (key !== 'supervisor.graph') {
        expect(screen.getAllByRole('tablist')).toEqual([navigation])
        expect(within(panel).queryByRole('tablist')).not.toBeInTheDocument()
      }
      if (key === 'supervisor.settings') {
        expect(within(panel).queryByRole('button', { name: t('center.actions.refreshAriaLabel') })).not.toBeInTheDocument()
        expect(panel.querySelector('.scope-badge')).not.toBeInTheDocument()
        expect(within(panel).queryByRole('heading', { name: t('center.history.timelineTitle') })).not.toBeInTheDocument()
      } else if (key !== 'supervisor.automatic') {
        expect(within(panel).getByRole('button', { name: t('center.actions.refresh') })).toBeVisible()
      }
      if (key === 'supervisor.graph') {
        const graphNavigation = within(panel).getByRole('tablist', { name: t('supervisor.selection') })
        expect(screen.getAllByRole('tablist')).toEqual([navigation, graphNavigation])
        expect(within(panel).getAllByRole('tablist')).toEqual([graphNavigation])
        const graphTabs = ['event', 'entity', 'relation'].map((kind) =>
          within(graphNavigation).getByRole('tab', { name: `${t(`supervisor.listTabs.${kind}`)} ${kind === 'event' ? 1 : 0}` })
        )
        expect(within(graphNavigation).getAllByRole('tab')).toEqual(graphTabs)
        expect(within(graphNavigation).getAllByRole('tab', { selected: true })).toEqual([graphTabs[0]])
        for (const [index, graphTab] of graphTabs.entries()) {
          if (index > 0) fireEvent.keyDown(graphTabs[index - 1]!, { key: 'ArrowRight' })
          expect(within(graphNavigation).getAllByRole('tab', { selected: true })).toEqual([graphTab])
          expect(graphTab).toHaveAttribute('tabindex', '0')
          if (index > 0) expect(graphTab).toHaveFocus()
          const graphPanel = within(panel).getByRole('tabpanel')
          expect(graphPanel).toHaveAccessibleName(graphTab.textContent!)
          expect(graphTab).toHaveAttribute('aria-controls', graphPanel.id)
          expect(graphPanel).toHaveAttribute('aria-labelledby', graphTab.id)
          if (index === 0) {
            expect(within(graphPanel).getByRole('button', { name: /Review event/ })).toBeVisible()
          } else {
            expect(within(graphPanel).getByText(t('supervisor.listEmpty'))).toBeVisible()
          }
          expect(within(navigation).getAllByRole('tab', { selected: true })).toEqual([activeTab])
        }
        expect(within(panel).getByRole('region', { name: t('supervisor.canvas') })).toBeVisible()
        expect(within(panel).getByRole('heading', { name: t('supervisor.inspector') })).toBeVisible()
        expect(within(panel).getByText(new RegExp(`^${t('supervisor.graphScope')}: ${t('center.scope.global')} · `))).toBeVisible()
      }
      if (key === 'activity.title') {
        await screen.findByText(t('activity.empty'))
        expect(within(panel).queryByText(t('activity.description'))).not.toBeInTheDocument()
        expect(panel.querySelector('.scope-badge')).toBeVisible()
      }
    }
    expect(screen.queryByLabelText(t('settings.nameLabel'))).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: t('supervisor.automatic') }))
    expect(screen.getByText(t('settings.scheduleHelp'))).toBeVisible()
    expect(screen.getByRole('button', { name: t('settings.createTitle') })).toBeEnabled()
    expect(screen.getByRole('button', { name: i18n.t('settings.runNowAriaLabel', { ns: 'heartbeat', name: config.name }) })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: t('settings.refreshPlans') }))
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce())
  })

  it('opens an Activity result outside the latest reviews and stops activity reads on tab exit', async () => {
    const old = { id: 'old', storyLineId: 'story', sourceId: null, summary: 'Older review body', changeDigest: '', createdAt: '2026-09-01T00:00:00Z', scope: { kind: 'global' }, timeRange: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }, openItems: [] }
    const overview = vi.fn(async (input?: { resultId?: string }) => input?.resultId === 'old' ? [old] : [])
    const graph = vi.fn(async () => ({ storyLine: null, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    const activity = vi.fn(async () => [{ id: 'run', kind: 'supervision', trigger: 'manual', status: 'completed', scope: old.scope, startedAt: old.createdAt, completedAt: old.createdAt, timeRange: old.timeRange, error: null, summary: 'Activity summary', resultId: 'old', heartbeatStatus: null, supervisionStatus: 'completed' }])
    vi.stubGlobal('goodbuddy', { supervision: { execution: async () => ({ active: false }), overview, graph, activity } })
    renderComponent(<HeartbeatCenter {...createProps()} />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['工作回顾', '故事线图谱', '智能心跳', '活动记录', '设置'])
    fireEvent.click(screen.getByRole('tab', { name: '活动记录' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看回顾' }))
    expect(await screen.findByText('Older review body')).toBeVisible()
    expect(screen.getByRole('tab', { name: '工作回顾' })).toHaveAttribute('aria-selected', 'true')
    expect(overview).toHaveBeenCalledWith({ resultId: 'old' })
    expect(graph).toHaveBeenLastCalledWith({ resultId: 'old', storyLineId: 'story' })
    fireEvent.click(screen.getByRole('tab', { name: '活动记录' }))
    fireEvent.click(await screen.findByRole('button', { name: '在图谱中查看' }))
    expect(screen.getByRole('tab', { name: '故事线图谱' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(graph).toHaveBeenCalledTimes(2))
  })

  it.each(['zh-CN', 'en-US'])('edits the supervision timeout and concurrency and preserves failed edits (%s)', async (language) => {
    await i18n.changeLanguage(language)
    const onUpdateApplicationSettings = vi.fn(async () => false)
    const applicationSettings = applicationSettingsSchema.parse({ checkUpdatesOnStartup: true, updateSource: 'github', modelDownloadSource: 'modelscope', localToolEnvironment: defaultLocalToolEnvironmentSettings, conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false })
    const props = createProps({ applicationSettings, onUpdateApplicationSettings })
    const view = render(<HeartbeatCenter {...props} />, false)
    fireEvent.click(screen.getByRole('tab', { name: i18n.t('supervisor.settings', { ns: 'heartbeat' }) }))
    const t = (key: string) => i18n.t(key, { ns: 'heartbeat' })
    // The heartbeat no longer runs its own report model call.
    expect(screen.queryByLabelText(t('timeouts.report'))).not.toBeInTheDocument()
    const organize = screen.getByLabelText(t('timeouts.organize'))
    const concurrency = screen.getByLabelText(t('timeouts.concurrency'))
    expect(concurrency).toHaveValue(1)
    expect(screen.getByText(t('timeouts.concurrencyHelp'))).toBeVisible()
    expect(organize).toHaveValue(240)
    expect(screen.getByText(t('timeouts.transport'))).toBeVisible()
    for (const value of ['', '29', '601', '30.5']) {
      fireEvent.change(organize, { target: { value } })
      expect(screen.getByRole('button', { name: t('timeouts.save') })).toBeDisabled()
    }
    fireEvent.change(organize, { target: { value: '30' } })
    for (const value of ['', '0', '5', '1.5']) {
      fireEvent.change(concurrency, { target: { value } })
      expect(screen.getByRole('button', { name: t('timeouts.save') })).toBeDisabled()
    }
    fireEvent.change(concurrency, { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: t('timeouts.save') }))
    await waitFor(() => expect(onUpdateApplicationSettings).toHaveBeenCalledExactlyOnceWith({ supervisorOrganizeTimeoutSeconds: 30, supervisorModelConcurrency: 4 }))
    view.rerender(<HeartbeatCenter {...props} applicationSettingsError="Save failed" />)
    expect(organize).toHaveValue(30)
    expect(concurrency).toHaveValue(4)
    expect(screen.getByText('Save failed')).toBeVisible()
    view.rerender(<HeartbeatCenter {...props} applicationSettings={{ ...applicationSettings, supervisorOrganizeTimeoutSeconds: 30, supervisorModelConcurrency: 4 }} />)
    expect(screen.getByRole('button', { name: t('timeouts.save') })).toBeDisabled()
  })
  it.each(['zh-CN', 'en-US'])('saves an existing text model reference, retains failed drafts, and restores app default (%s)', async language => {
    await i18n.changeLanguage(language)
    const t = (key: string) => i18n.t(key, { ns: 'heartbeat' })
    const profileId = '00000000-0000-4000-8000-000000000201'
    const applicationSettings = applicationSettingsSchema.parse({ checkUpdatesOnStartup: true, updateSource: 'github', modelDownloadSource: 'modelscope', localToolEnvironment: defaultLocalToolEnvironmentSettings, conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false })
    const runtimeSettings = { modelProfiles: [
      { id: profileId, name: 'Reviewer', modelName: 'review-model', protocol: 'openai-chat-completions' },
      { id: 'image', name: 'Image only', modelName: 'image-model', protocol: 'openai-images-generations' }
    ] } as RuntimeSettings
    const onUpdateApplicationSettings = vi.fn(async () => false)
    const props = createProps({ applicationSettings, runtimeSettings, onUpdateApplicationSettings })
    const view = render(<HeartbeatCenter {...props} />, false)
    fireEvent.click(screen.getByRole('tab', { name: t('supervisor.settings') }))
    const selector = screen.getByRole('combobox', { name: t('timeouts.model') })
    expect(selector).toHaveValue('')
    expect(within(selector).queryByText(/Image only/)).not.toBeInTheDocument()
    fireEvent.change(selector, { target: { value: profileId } })
    fireEvent.click(screen.getByRole('button', { name: t('timeouts.save') }))
    await waitFor(() => expect(onUpdateApplicationSettings).toHaveBeenCalledExactlyOnceWith({
      supervisorModelProfileId: profileId, supervisorOrganizeTimeoutSeconds: 240, supervisorModelConcurrency: 1
    }))
    view.rerender(<HeartbeatCenter {...props} applicationSettingsError="Save failed" />)
    expect(selector).toHaveValue(profileId)
    view.rerender(<HeartbeatCenter {...props} applicationSettings={{ ...applicationSettings, supervisorModelProfileId: profileId }} />)
    expect(screen.getByRole('button', { name: t('timeouts.save') })).toBeDisabled()
    view.rerender(<HeartbeatCenter {...props} runtimeSettings={{ ...runtimeSettings, modelProfiles: [] }} applicationSettings={{ ...applicationSettings, supervisorModelProfileId: profileId }} />)
    expect(within(selector).getByRole('option', { name: t('timeouts.unavailableModel') })).toBeDisabled()
    fireEvent.change(selector, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: t('timeouts.save') }))
    await waitFor(() => expect(onUpdateApplicationSettings).toHaveBeenLastCalledWith({
      supervisorModelProfileId: null, supervisorOrganizeTimeoutSeconds: 240, supervisorModelConcurrency: 1
    }))
  })

  it.each(['zh-CN', 'en-US'])('opens complete automatic supervision settings without creating defaults (%s)', async (language) => {
    await i18n.changeLanguage(language)
    const props = createProps({ configs: [], runs: [], entries: [] })
    render(<HeartbeatCenter {...props} />, false)
    const t = (key: string) => i18n.t(key, { ns: 'heartbeat' })
    expect(screen.getByRole('tab', { name: t('supervisor.automatic') })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(t('settings.empty'))).toBeVisible()
    // One status line only: the empty state replaces the generic help.
    expect(screen.queryByText(t('settings.scheduleHelp'))).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: t('settings.createTitle') }))
    expect(screen.getByLabelText(t('settings.recurrenceAriaLabel'))).toHaveValue('daily')
    expect(screen.getByLabelText(t('settings.timeAriaLabel'))).toHaveValue('09:00')
    expect(screen.getByLabelText(t('settings.lookbackAriaLabel'))).toHaveValue(48)
    expect(screen.getByLabelText(t('settings.retentionAriaLabel'))).toHaveValue(90)
    expect(screen.getByRole('button', { name: t('settings.scope.projects') })).toBeVisible()
    fireEvent.change(screen.getByLabelText(t('settings.recurrenceAriaLabel')), { target: { value: 'weekly' } })
    expect(screen.getByLabelText(t('settings.weekdayAriaLabel'))).toBeVisible()
    expect(props.onCreate).not.toHaveBeenCalled()
    expect(props.onUpdate).not.toHaveBeenCalled()
    expect(props.onRunNow).not.toHaveBeenCalled()
  })

  it.each(['unconfigured', 'enabled', 'paused'])('keeps %s plans usable without an empty activity dashboard', (state) => {
    const props = createProps({
      configs: state === 'unconfigured' ? [] : [{ ...config, enabled: state === 'enabled' }],
      runs: [],
      entries: []
    })
    const view = render(<HeartbeatCenter {...props} />)
    const t = (key: string) => i18n.t(key, { ns: 'heartbeat' })
    for (const key of ['center.metrics.ariaLabel', 'center.trend.title', 'center.suggestions.memoryTitle', 'center.suggestions.taskTitle', 'center.history.timelineTitle', 'center.history.auditTitle']) {
      expect(screen.queryByRole('heading', { name: t(key) })).not.toBeInTheDocument()
    }
    expect(screen.queryByLabelText(t('center.metrics.ariaLabel'))).not.toBeInTheDocument()
    expect(screen.getByText(t(state === 'unconfigured' ? 'settings.empty' : state === 'paused' ? 'settings.allPaused' : 'settings.scheduleHelp'))).toBeVisible()
    expect(screen.getByRole('button', { name: t('settings.refreshPlans') })).toBeEnabled()
    expect(screen.getByRole('button', { name: t('settings.createTitle') })).toBeEnabled()
    if (state !== 'unconfigured') {
      for (const key of ['settings.editAriaLabel', 'settings.runNowAriaLabel', 'settings.deleteAriaLabel', state === 'enabled' ? 'settings.pauseAriaLabel' : 'settings.resumeAriaLabel']) {
        expect(screen.getByRole('button', { name: i18n.t(key, { ns: 'heartbeat', name: config.name }) })).toBeEnabled()
      }
    }
    fireEvent.click(screen.getByRole('button', { name: t('settings.createTitle') }))
    expect(screen.getByLabelText(t('settings.recurrenceAriaLabel'))).toHaveValue('daily')
    fireEvent.click(screen.getByRole('button', { name: t('settings.close') }))
    expect(props.onRunNow).not.toHaveBeenCalled()
    expect(props.onCreate).not.toHaveBeenCalled()
    // Earlier reports stay readable; statistics and the run audit are not shown.
    view.rerender(<HeartbeatCenter {...props} runs={[runs[1]!]} entries={[entry]} />)
    expect(screen.getByText(entry.summary)).toBeVisible()
    expect(screen.queryByLabelText(t('center.metrics.ariaLabel'))).not.toBeInTheDocument()
    expect(screen.queryByText(runs[1]!.error!)).not.toBeInTheDocument()
  })
  it.each(['daily', 'weekly'])('saves the explicitly configured %s plan and rejects invalid windows', async (frequency) => {
    const props = createProps({ configs: [], runs: [], entries: [] })
    render(<HeartbeatCenter {...props} />, false)
    fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.createTitle', { ns: 'heartbeat' }) }))
    fireEvent.change(screen.getByLabelText('监督频率'), { target: { value: frequency } })
    if (frequency === 'weekly') fireEvent.change(screen.getByLabelText('监督星期'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('监督时间'), { target: { value: '16:35' } })
    fireEvent.change(screen.getByLabelText('回顾窗口（小时）'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: '保存并启用计划' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('回顾窗口（小时）'), { target: { value: '168' } })
    fireEvent.change(screen.getByLabelText('历史保留（天）'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并启用计划' }))
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledExactlyOnceWith({
      name: '定期回顾', scope: { kind: 'global' }, enabled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      recurrence: frequency === 'weekly'
        ? { type: 'weekly', localTime: '16:35', weekday: 5 }
        : { type: 'daily', localTime: '16:35' },
      lookbackHours: 168, retentionDays: 30, intervention: 'suggest'
    }))
    expect(props.onRunNow).not.toHaveBeenCalled()
  })

  it('preserves a paused weekly plan and its time zone across failed edits and retry', async () => {
    const saved: AssistantHeartbeatConfig = {
      ...config, enabled: false, timezone: 'Pacific/Honolulu',
      recurrence: { type: 'weekly', weekday: 3, localTime: '17:45' }
    }
    const onUpdate = vi.fn(async () => {}).mockRejectedValueOnce(new Error('保存失败，请重试'))
    const props = createProps({ configs: [saved], onUpdate })
    render(<HeartbeatCenter {...props} />, false)
    expect(screen.getByText('所有心跳计划已暂停，目前仅支持手动回顾。')).toBeVisible()
    expect(screen.getByText('周三 17:45 · Pacific/Honolulu')).toBeVisible()
    expect(screen.getByText('回顾最近 48 小时 · 运行历史保留 90 天 · 生成建议')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: `编辑 ${config.name}` }))
    expect(screen.getByLabelText('监督频率')).toHaveValue('weekly')
    expect(screen.getByLabelText('监督星期')).toHaveValue('3')
    expect(screen.getByText(/计划时区：Pacific\/Honolulu/)).toBeVisible()
    fireEvent.change(screen.getByLabelText('计划名称'), { target: { value: '每周复盘' } })
    fireEvent.click(screen.getByRole('button', { name: '保存心跳计划' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，请重试')
    expect(screen.getByLabelText('计划名称')).toHaveValue('每周复盘')
    fireEvent.click(screen.getByRole('button', { name: '保存心跳计划' }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2))
    expect(onUpdate).toHaveBeenLastCalledWith(config.id, {
      name: '每周复盘', scope: config.scope, timezone: saved.timezone,
      recurrence: saved.recurrence, enabled: false, lookbackHours: 48, retentionDays: 90, intervention: 'suggest'
    })
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  it('keeps pause, resume, run and confirmed deletion available directly in automatic supervision', async () => {
    const props = createProps()
    const view = render(<HeartbeatCenter {...props} />, false)
    fireEvent.click(screen.getByRole('button', { name: `暂停 ${config.name}` }))
    await waitFor(() => expect(props.onSetPaused).toHaveBeenCalledWith(config.id, true))
    view.rerender(<HeartbeatCenter {...props} configs={[{ ...config, enabled: false }]} />)
    fireEvent.click(screen.getByRole('button', { name: `恢复 ${config.name}` }))
    await waitFor(() => expect(props.onSetPaused).toHaveBeenCalledWith(config.id, false))
    fireEvent.click(screen.getByRole('button', { name: `立即运行 ${config.name}` }))
    await waitFor(() => expect(props.onRunNow).toHaveBeenCalledWith(config.id))
    fireEvent.click(screen.getByRole('button', { name: `删除 ${config.name}` }))
    expect(props.onRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `确认删除 ${config.name}` }))
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith(config.id))
  })

  it('renders English interface copy while preserving heartbeat content', async () => {
    await i18n.changeLanguage('en-US')
    render(<HeartbeatCenter {...createProps()} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Supervisor' })).toBeInTheDocument()
    expect(screen.queryByText('SMART HEARTBEAT')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument()
    expect(screen.getByText(entry.summary)).toBeVisible()
    expect(screen.getByText('Project: Default project')).toHaveClass('scope-badge')
    expect(screen.getByText(/Supervisor suggestions|Suggest/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.createTitle', { ns: 'heartbeat' }) }))
    expect(screen.getByRole('button', { name: 'Update memory only' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Selected projects' }))
    expect(screen.getByLabelText('Default project')).toBeInTheDocument()
  })

  it('shows plan status and keeps earlier reports readable without statistics', () => {
    render(<HeartbeatCenter {...createProps()} />)
    expect(screen.getByRole('heading', { level: 1, name: '监督者' })).toBeInTheDocument()
    expect(screen.getByText('项目：默认项目')).toHaveClass('scope-badge')
    expect(screen.getByText('1 个计划运行中')).toBeInTheDocument()
    expect(screen.queryByText('50%')).not.toBeInTheDocument()
    expect(screen.getByText(entry.summary)).toBeVisible()
    expect(screen.getByRole('region', { name: '心跳计划' })).toBeInTheDocument()
  })
  it('distinguishes multi-project-only scope from global and project scope', async () => {
    const secondProject = {
      ...createProps().projects[0]!,
      id: '00000000-0000-4000-8000-000000000102',
      name: '第二项目',
      rootPath: 'C:\\Second'
    }
    const projectConfig: AssistantHeartbeatConfig = {
      ...config,
      scope: {
        kind: 'projects',
        projectIds: [createProps().projects[0]!.id, secondProject.id]
      }
    }
    const { rerender } = render(
      <HeartbeatCenter
        {...createProps({
          configs: [projectConfig],
          projects: [...createProps().projects, secondProject]
        })}
      />
    )

    expect(screen.getByLabelText('2 个项目')).toHaveTextContent(
      '2 个项目'
    )
    expect(within(screen.getByRole('region', { name: '运行概览' })).queryByText(/全局/u)).not.toBeInTheDocument()

    rerender(
      <HeartbeatCenter
        {...createProps({
          configs: [
            projectConfig,
            {
              ...config,
              id: 'heartbeat-global',
              scope: { kind: 'global' }
            }
          ],
          projects: [...createProps().projects, secondProject]
        })}
      />
    )
    expect(within(screen.getByRole('region', { name: '运行概览' })).getByLabelText('项目 + 全局')).toBeInTheDocument()

    await i18n.changeLanguage('en-US')
    rerender(
      <HeartbeatCenter
        {...createProps({
          configs: [projectConfig],
          projects: [...createProps().projects, secondProject]
        })}
      />
    )
    expect(screen.getByLabelText('2 projects')).toBeInTheDocument()
  })

  it('uses level-two headings for direct tab panel sections', () => {
    render(<HeartbeatCenter {...createProps()} />)
    expect(screen.getByRole('heading', { level: 2, name: '心跳计划' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '历史心跳报告' })).toBeInTheDocument()
    for (const name of ['报告趋势', '待确认记忆', '行动建议', '运行记录', '最近回顾']) {
      expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.getByRole('heading', { level: 2, name: '模型超时与并发' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '回顾整理' }))
    expect(screen.getByRole('heading', { level: 2, name: '回顾算法' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '模型超时与并发' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '故事与经验' }))
    expect(screen.getByRole('switch', { name: '跨项目关联' })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: '建议' }))
    expect(screen.getByLabelText(/故事多少天没有新进展/)).toBeVisible()
    expect(screen.queryByRole('button', { name: '新建计划' })).not.toBeInTheDocument()
  })

  it('turns supervisor suggestions into explicit actions with evidence', async () => {
    const suggestion = { id: '00000000-0000-4000-8000-000000000901', resultId: 'result-1', heartbeatRunId: 'run-completed',
      scope: { kind: 'global' }, kind: 'open_item', title: '决定每页读取条数', detail: '50 还是 100 仍未决定', sourceIds: ['source-1'],
      entityId: null, relationId: null, taskId: null, status: 'pending', createdAt: '2026-09-23T10:00:00Z' }
    const suggestions = vi.fn(async () => [suggestion, { ...suggestion, id: '00000000-0000-4000-8000-000000000902', kind: 'conflict', title: '暂停与持续执行存在分歧' }])
    const suggestionAction = vi.fn(async () => ({ ...suggestion, status: 'accepted', taskId: task.id }))
    const source = vi.fn(async () => ({ title: '监督者回顾调度', content: '每页读取多少条消息还没定', sourceType: 'conversation', sourceId: 'conversation-1' }))
    Object.assign(window.goodbuddy.supervision, { suggestions, suggestionAction, source })
    const onUseFollowUpTask = vi.fn()
    const onOpenConversation = vi.fn()
    render(<HeartbeatCenter {...createProps({ onUseFollowUpTask, onOpenConversation })} />)
    const panel = await screen.findByRole('region', { name: '监督建议' })
    expect(within(panel).getByText('未决事项')).toBeVisible()
    expect(within(panel).getAllByText('50 还是 100 仍未决定')[0]).toBeVisible()
    fireEvent.click(within(panel).getAllByRole('button', { name: '查看依据（1 处）' })[0]!)
    expect(await within(panel).findByText('每页读取多少条消息还没定')).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: '打开会话' }))
    expect(onOpenConversation).toHaveBeenCalledWith('conversation-1')
    fireEvent.click(within(panel).getByRole('button', { name: '转为任务' }))
    await waitFor(() => expect(suggestionAction).toHaveBeenCalledWith({ id: suggestion.id, action: 'accept' }))
    expect(onUseFollowUpTask).toHaveBeenCalledWith(task)
    await waitFor(() => expect(within(panel).queryByText('决定每页读取条数')).not.toBeInTheDocument())
    fireEvent.click(within(panel).getByRole('button', { name: '忽略' }))
    await waitFor(() => expect(suggestionAction).toHaveBeenLastCalledWith({ id: '00000000-0000-4000-8000-000000000902', action: 'dismiss' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: '监督建议' })).not.toBeInTheDocument())
  })

  it('runs and refreshes plans and keeps earlier reports expandable and paged', async () => {
    const props = createProps({ entries: Array.from({ length: 21 }, (_, index) => ({ ...entry, id: `entry-${index}`, summary: `Report ${index}` })) })
    render(<HeartbeatCenter {...props} />)
    fireEvent.click(screen.getByRole('button', { name: `立即运行 ${config.name}` }))
    await waitFor(() => expect(props.onRunNow).toHaveBeenCalledWith(config.id))
    fireEvent.click(screen.getByRole('button', { name: '刷新智能心跳' }))
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce())
    const reports = screen.getByRole('region', { name: '历史心跳报告' })
    expect(within(reports).queryByText('Report 20')).not.toBeInTheDocument()
    fireEvent.click(within(reports).getByRole('button', { name: i18n.t('center.history.loadMoreReports', { ns: 'heartbeat' }) }))
    expect(within(reports).getByText('Report 20')).toBeVisible()
    fireEvent.click(within(reports).getAllByRole('button', { name: '展开完整报告' })[20]!)
    expect(within(reports).getByText(entry.highlights[0]!)).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: '工作回顾' }))
    expect(screen.queryByRole('region', { name: '历史心跳报告' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '智能心跳' }))
    expect(within(screen.getByRole('region', { name: '历史心跳报告' })).getByText('Report 20')).toBeVisible()
    expect(screen.getByRole('button', { name: '收起报告' })).toHaveAttribute('aria-expanded', 'true')
  })
  it.each([false, true])('keeps successful supervision results independent of automatic reports (empty=%s)', async (empty) => {
    window.goodbuddy.supervision.overview = vi.fn(async () => [{ id: 'result', storyLineId: 'story', sourceId: null, summary: 'Successful work review', changeDigest: '', createdAt: '2026-09-22T00:00:00Z', scope: { kind: 'global' }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z' }, openItems: [] }]) as never
    renderComponent(<HeartbeatCenter {...createProps(empty ? { configs: [], entries: [], runs: [], memories: [], tasks: [] } : {})} />)
    expect(await screen.findByText('Successful work review')).toBeVisible()
    const recap = screen.getByRole('tabpanel', { name: '工作回顾' })
    expect(recap.querySelector('#heartbeat-panel-history, #heartbeat-panel-suggestions, .scope-badge')).toBeNull()
    expect(within(recap).getAllByRole('button', { name: '刷新' })).toHaveLength(1)
    expect(within(recap).queryByText(/暂无历史心跳报告|还没有成功回顾/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '智能心跳' }))
    if (empty) {
      expect(screen.queryByRole('region', { name: '历史心跳报告' })).not.toBeInTheDocument()
    } else {
      expect(within(screen.getByRole('region', { name: '历史心跳报告' })).getByText(entry.summary)).toBeVisible()
    }
    expect(screen.queryByText('Successful work review')).not.toBeInTheDocument()
  })

  it('explains the irreversible impact before deleting a plan', () => {
    render(<HeartbeatCenter {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '智能心跳' }))
    fireEvent.click(
      screen.getByRole('button', {
        name: `删除 ${config.name}`
      })
    )

    const confirmation = screen.getByRole('alertdialog', {
      name: `确认删除 ${config.name}`
    })
    expect(confirmation).toHaveTextContent(
      '将永久删除此计划、运行历史和关联结果，且无法恢复。'
    )
  })

  it('keeps scope choices visible while showing help for the selected scope', () => {
    render(<HeartbeatCenter {...createProps()} />)
    fireEvent.click(screen.getByRole('tab', { name: '智能心跳' }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.createTitle', { ns: 'heartbeat' }) }))
    const help = screen.getByRole('button', { name: '项目范围' })
    expect(help.closest('label, [role="tab"]')).toBeNull()
    fireEvent.click(help)
    expect(screen.getByRole('tooltip')).toHaveTextContent('回顾所有可用项目中的有界对话与任务')
    fireEvent.click(screen.getByRole('button', { name: '指定项目' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('一次运行共同回顾所选项目')
    expect(screen.getByRole('checkbox', { name: '默认项目' })).toBeVisible()
  })

  it('shows the missing supervisor bridge instead of falling back to the old overview', () => {
    vi.stubGlobal('goodbuddy', {})
    renderComponent(<HeartbeatCenter {...createProps()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('监督者服务暂不可用')
    expect(screen.queryByRole('region', { name: '心跳计划' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: '模型超时与并发' })).toBeInTheDocument()
  })

  it('keeps an unsaved draft when switching settings tabs', () => {
    renderComponent(<HeartbeatCenter {...createProps()} />)
    fireEvent.click(screen.getByRole('tab', { name: '设置' }))
    fireEvent.click(screen.getByRole('tab', { name: '回顾整理' }))
    fireEvent.change(screen.getByLabelText(/每批消息数/), { target: { value: '33' } })
    fireEvent.click(screen.getByRole('tab', { name: '建议' }))
    fireEvent.click(screen.getByRole('tab', { name: '回顾整理' }))
    expect(screen.getByLabelText(/每批消息数/)).toHaveValue(33)
  })

  it('passes manual project and time selections without requiring an automatic plan', async () => {
    const run = vi.fn(async () => undefined)
    window.goodbuddy.supervision.run = run
    const props = createProps({ configs: [] })
    renderComponent(<HeartbeatCenter {...props} />)
    await screen.findByText('还没有成功回顾')
    fireEvent.change(screen.getByLabelText('关注范围'), { target: { value: props.projects[0]!.id } })
    fireEvent.change(screen.getByLabelText('时间范围'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'manual', scope: { kind: 'projects', projectIds: [props.projects[0]!.id] }
    }))
    const request = supervisionRunRequestSchema.parse(vi.mocked(window.goodbuddy.supervision.run).mock.calls[0]![0])
    expect(Date.parse(request.timeRange.to) - Date.parse(request.timeRange.from)).toBe(30 * 86400_000)
  })

  it('creates one heartbeat plan for multiple selected projects', async () => {
    const onCreate = vi.fn(async () => {})
    const secondProject = {
      ...createProps().projects[0]!,
      id: '00000000-0000-4000-8000-000000000102',
      name: '第二项目',
      rootPath: 'C:\\Second'
    }
    render(
      <HeartbeatCenter
        {...createProps({
          configs: [],
          entries: [],
          runs: [],
          onCreate,
          projects: [...createProps().projects, secondProject]
        })}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: '创建心跳计划' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '指定项目' })
    )
    fireEvent.click(screen.getByLabelText('默认项目'))
    fireEvent.click(screen.getByLabelText('第二项目'))
    fireEvent.click(
      screen.getByRole('button', { name: '保存并启用计划' })
    )

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: {
            kind: 'projects',
            projectIds: [
              '00000000-0000-4000-8000-000000000101',
              '00000000-0000-4000-8000-000000000102'
            ]
          }
        })
      )
    )
  })

  it('edits an existing heartbeat plan from Heartbeat Plans', async () => {
    const onUpdate = vi.fn(async () => {})
    render(
      <HeartbeatCenter {...createProps({ onUpdate })} />
    )

    fireEvent.click(screen.getByRole('tab', { name: '智能心跳' }))
    fireEvent.click(
      screen.getByRole('button', { name: `编辑 ${config.name}` })
    )
    fireEvent.change(screen.getByLabelText('计划名称'), {
      target: { value: '更新后的回顾' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '保存心跳计划' })
    )

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        config.id,
        expect.objectContaining({
          name: '更新后的回顾',
          scope: config.scope
        })
      )
    )
  })

  it('guides first-time users to create a heartbeat plan', () => {
    render(
      <HeartbeatCenter
        {...createProps({
          configs: [],
          runs: [],
          entries: [],
          memories: [],
          tasks: []
        })}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: '创建心跳计划' })
    )
    expect(
      screen.getByRole('tab', { name: '智能心跳' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('button', { name: '保存并启用计划' })
    ).toBeInTheDocument()
  })

  it('keeps loading and load failure distinct from first-time empty state', () => {
    const emptyProps = {
      configs: [],
      runs: [],
      entries: [],
      memories: [],
      tasks: []
    }
    const { rerender } = render(
      <HeartbeatCenter
        {...createProps({
          ...emptyProps,
          loading: true
        })}
      />
    )

    expect(screen.getByText('正在加载监督者')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '运行概览' })).getByRole('status')).toHaveAttribute(
      'aria-busy',
      'true'
    )
    expect(
      screen.queryByRole('button', { name: '保存并启用计划' })
    ).not.toBeInTheDocument()

    rerender(
      <HeartbeatCenter
        {...createProps({
          ...emptyProps,
          loadError: '数据库暂时不可用'
        })}
      />
    )
    expect(screen.getByText('监督者加载失败')).toBeInTheDocument()
    expect(screen.getByText('数据库暂时不可用')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '保存并启用计划' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('keeps existing heartbeat data visible when refresh fails', () => {
    render(
      <HeartbeatCenter
        {...createProps({ loadError: '刷新连接失败' })}
      />
    )

    expect(screen.getByText('监督者刷新失败')).toBeInTheDocument()
    expect(screen.getByText(config.name)).toBeInTheDocument()
    expect(screen.getByText(entry.summary)).toBeVisible()
  })

  it.each(['zh-CN', 'en-US'])('uses the shared modal header and footer for create and edit (%s)', async (language) => {
    await i18n.changeLanguage(language)
    render(<HeartbeatCenter {...createProps()} />, false)
    const t = (key: string) => i18n.t(key, { ns: 'heartbeat' })
    for (const editing of [false, true]) {
      const opener = screen.getByRole('button', { name: editing
        ? i18n.t('settings.editAriaLabel', { ns: 'heartbeat', name: config.name })
        : t('settings.createTitle') })
      opener.focus()
      fireEvent.click(opener)
      const dialog = screen.getByRole('dialog', { name: t(editing ? 'settings.editTitle' : 'settings.createTitle') })
      const header = dialog.querySelector(':scope > header')!
      const footer = dialog.querySelector(':scope > footer')!
      expect(header).toHaveClass('custom-task-dialog__header')
      expect(footer).toHaveClass('custom-task-dialog__actions')
      expect(dialog.querySelector(':scope > .custom-task-dialog__content')).not.toBeNull()
      const close = within(header as HTMLElement).getByRole('button', { name: t('settings.close') })
      expect(close).toHaveClass('icon-button')
      expect(close).toHaveAttribute('title', t('settings.close'))
      expect(header.querySelectorAll('button')).toHaveLength(1)
      const cancel = within(footer as HTMLElement).getByRole('button', { name: t('supervisor.cancel') })
      const save = within(footer as HTMLElement).getByRole('button', { name: t(editing ? 'settings.saveAriaLabel' : 'settings.enableAriaLabel') })
      expect(cancel).toHaveClass('secondary-button')
      expect(save).toHaveClass('primary-button')
      expect(cancel.nextElementSibling).toBe(save)
      close.focus()
      fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
      expect(save).toHaveFocus()
      fireEvent.keyDown(save, { key: 'Tab' })
      expect(close).toHaveFocus()
      fireEvent.click(cancel)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    }
  })

  it.each(['X', 'cancel', 'Escape', 'backdrop'])('guards unsaved changes through %s for create and edit', async (action) => {
    const props = createProps()
    render(<HeartbeatCenter {...props} />, false)
    for (const editing of [false, true]) {
      const opener = screen.getByRole('button', { name: editing ? `编辑 ${config.name}` : '创建心跳计划' })
      opener.focus()
      fireEvent.click(opener)
      const dismiss = () => {
        if (action === 'Escape') fireEvent.keyDown(screen.getByLabelText('计划名称'), { key: 'Escape' })
        else if (action === 'backdrop') fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
        else fireEvent.click(screen.getByRole('button', { name: action === 'X' ? '关闭心跳计划' : '取消' }))
      }
      dismiss()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
      fireEvent.click(opener)
      fireEvent.change(screen.getByLabelText('计划名称'), { target: { value: 'Unsaved draft' } })
      dismiss()
      expect(screen.getByRole('dialog')).toHaveAccessibleName('放弃未保存的计划修改？')
      expect(screen.getByRole('button', { name: '继续编辑' })).toHaveFocus()
      fireEvent.click(screen.getByRole('button', { name: '关闭心跳计划' }))
      await waitFor(() => expect(screen.getByLabelText('计划名称')).toHaveFocus())
      expect(screen.getByLabelText('计划名称')).toHaveValue('Unsaved draft')
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
      expect(opener).toHaveFocus()
    }
    expect(props.onCreate).not.toHaveBeenCalled()
    expect(props.onUpdate).not.toHaveBeenCalled()
  })

  it('reports an edited plan draft as unsaved until the dialog closes', () => {
    const report = vi.fn()
    renderComponent(
      <WorkspaceUnsavedChangesContext.Provider value={report}>
        <HeartbeatCenter {...createProps()} />
      </WorkspaceUnsavedChangesContext.Provider>
    )
    fireEvent.click(screen.getByRole('tab', { name: i18n.t('supervisor.automatic', { ns: 'heartbeat' }) }))
    fireEvent.click(screen.getByRole('button', { name: '创建心跳计划' }))
    expect(report).not.toHaveBeenCalledWith(expect.any(String), true)
    fireEvent.change(screen.getByLabelText('计划名称'), { target: { value: 'Draft plan' } })
    expect(report).toHaveBeenLastCalledWith(expect.any(String), true)
    fireEvent.click(screen.getByRole('button', { name: '关闭心跳计划' }))
    fireEvent.click(screen.getByRole('button', { name: /放弃/ }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(report).toHaveBeenLastCalledWith(expect.any(String), false)
  })

  it('locks every close action and duplicate submission while saving, then keeps the failed draft', async () => {
    let rejectSave!: (reason: Error) => void
    const onCreate = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject }))
    render(<HeartbeatCenter {...createProps({ onCreate })} />, false)
    fireEvent.click(screen.getByRole('button', { name: '创建心跳计划' }))
    fireEvent.change(screen.getByLabelText('计划名称'), { target: { value: 'Pending draft' } })
    const save = screen.getByRole('button', { name: '保存并启用计划' })
    fireEvent.click(save)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-busy', 'true')
    for (const button of [save, screen.getByRole('button', { name: '关闭心跳计划' }), screen.getByRole('button', { name: '取消' })]) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.mouseDown(dialog.parentElement!)
    expect(dialog).toHaveAccessibleName('创建心跳计划')
    expect(onCreate).toHaveBeenCalledTimes(1)
    rejectSave(new Error('Save unavailable'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable')
    expect(screen.getByLabelText('计划名称')).toHaveValue('Pending draft')
    expect(save).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '关闭心跳计划' }))
    expect(dialog).toHaveAccessibleName('放弃未保存的计划修改？')
  })

  it('keeps a failed create draft, guards Escape/backdrop/cancel, traps focus and restores the opener', async () => {
    const onCreate = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Cannot save plan'))
    render(<HeartbeatCenter {...createProps({ onCreate })} />, false)
    const opener = screen.getByRole('button', { name: '创建心跳计划' })
    opener.focus()
    fireEvent.click(opener)
    const name = screen.getByLabelText('计划名称')
    expect(name).toHaveFocus()
    expect(document.querySelector('form form')).toBeNull()
    fireEvent.change(name, { target: { value: 'Draft plan' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并启用计划' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot save plan')
    expect(name).toHaveValue('Draft plan')
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toHaveAccessibleName('放弃未保存的计划修改？')
    expect(screen.getByRole('button', { name: '继续编辑' })).toHaveFocus()
    const discard = screen.getByRole('button', { name: '放弃修改' })
    discard.focus()
    fireEvent.keyDown(discard, { key: 'Tab' })
    expect(screen.getByRole('button', { name: '关闭心跳计划' })).toHaveFocus()
    fireEvent.keyDown(discard, { key: 'Escape' })
    expect(screen.getByLabelText('计划名称')).toHaveValue('Draft plan')
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
    fireEvent.click(opener)
    expect(screen.getByLabelText('计划名称')).toHaveValue('定期回顾')
    fireEvent.click(screen.getByRole('button', { name: '保存并启用计划' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }))
  })

  it('opens exact plan activity even for equal names without duplicate audit and clears back to all activity', async () => {
    const activity = vi.fn(async () => [])
    window.goodbuddy.supervision.activity = activity
    const other = { ...config, id: 'heartbeat-2' }
    const props = createProps({ configs: [config, other], runs: [...runs, { ...runs[1]!, id: 'other-run', configId: other.id, error: 'Other plan failure' }] })
    render(<HeartbeatCenter {...props} />, false)
    fireEvent.click(screen.getAllByRole('button', { name: '执行记录' })[1]!)
    await waitFor(() => expect(activity).toHaveBeenLastCalledWith({ limit: 50, offset: 0, configId: other.id }))
    expect(screen.getByRole('combobox', { name: '监督计划' })).toHaveValue(other.id)
    expect(screen.queryByText('Other plan failure')).not.toBeInTheDocument()
    expect(screen.queryByText('模型暂时不可用')).not.toBeInTheDocument()
    expect(await screen.findByText('此计划暂无执行记录')).toBeVisible()
    const filter = screen.getByRole('combobox', { name: '监督计划' })
    filter.focus()
    fireEvent.change(filter, { target: { value: config.id } })
    expect(filter).toHaveFocus()
    await waitFor(() => expect(activity).toHaveBeenLastCalledWith({ limit: 50, offset: 0, configId: config.id }))
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(filter).toHaveFocus()
    await waitFor(() => expect(activity).toHaveBeenLastCalledWith({ limit: 50, offset: 0 }))
    expect(screen.queryByText('模型暂时不可用')).not.toBeInTheDocument()
    // Execution history lives only in Activity records; plans no longer repeat an audit list.
    fireEvent.click(screen.getByRole('tab', { name: '智能心跳' }))
    expect(screen.queryByText('Other plan failure')).not.toBeInTheDocument()
  })

  it.each([false, true])('keeps the entire automatic overview with one create action out of activity (empty=%s)', async (empty) => {
    const activity = vi.fn(async () => [])
    window.goodbuddy.supervision.activity = activity
    const props = createProps(empty ? { configs: [], entries: [], runs: [], memories: [], tasks: [] } : {})
    render(<HeartbeatCenter {...props} />)
    const panel = screen.getByRole('tabpanel', { name: '智能心跳' })
    expect(within(panel).getByRole('heading', { name: '心跳计划' })).toBeVisible()
    for (const name of ['报告趋势', '运行记录']) {
      expect(within(panel).queryByRole('heading', { name })).not.toBeInTheDocument()
    }
    expect(panel.querySelector('.heartbeat-center__metrics')).toBeNull()
    expect(within(panel).queryByRole('heading', { name: '历史心跳报告' }) !== null).toBe(!empty)
    expect(panel.querySelector('.scope-badge')).toBeVisible()
    expect(within(panel).getAllByRole('button', { name: '创建心跳计划' })).toHaveLength(1)
    expect(panel.querySelectorAll('#heartbeat-panel-overview .empty-state')).toHaveLength(0)
    expect(within(panel).queryByText(i18n.t('settings.empty', { ns: 'heartbeat' })) !== null).toBe(empty)
    fireEvent.click(within(panel).getByRole('button', { name: '刷新智能心跳' }))
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('tab', { name: '活动记录' }))
    await waitFor(() => expect(activity).toHaveBeenCalledOnce())
    const activityPanel = screen.getByRole('tabpanel', { name: '活动记录' })
    expect(activityPanel.querySelector('#heartbeat-panel-overview, #heartbeat-panel-plans, #heartbeat-runs-title, .heartbeat-center__metrics')).toBeNull()
    expect(within(activityPanel).queryByRole('button', { name: '创建心跳计划' })).not.toBeInTheDocument()
    expect(within(activityPanel).queryByRole('button', { name: '刷新智能心跳' })).not.toBeInTheDocument()
    fireEvent.click(within(activityPanel).getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(activity).toHaveBeenCalledTimes(2))
    expect(props.onRefresh).toHaveBeenCalledOnce()
  })
})
