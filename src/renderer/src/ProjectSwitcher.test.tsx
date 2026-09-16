import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProject } from '../../shared/assistant-contracts'
import {
  defaultRuntimeSettings,
  type RuntimeSettings
} from '../../shared/contracts'
import { agentRuntimeSelectionKey } from '../../shared/runtime-selection-contracts'
import type {
  SshDirectoryBrowseResult,
  SshHost,
  SshHostAgentConnectionState,
  SshHostAgentConnectionStatus,
  SshHostRemoteEnvironment,
  SshHostsSnapshot
} from '../../shared/ssh-host-contracts'
import type {
  RemoteProjectRecoveryState
} from '../../shared/remote-project-recovery-contracts'
import i18n from './i18n'
import { ProjectSwitcher } from './ProjectSwitcher'

const profileId = '00000000-0000-4000-8000-000000000011'
const runtimeSettings: RuntimeSettings = {
  ...defaultRuntimeSettings,
  knowledgeEmbeddingApiKeyConfigured: false,
  knowledgeEmbeddingCredentialSource: 'none',
  workspacePath: 'C:\\Workspace',
  apiKeyConfigured: true,
  credentialSource: 'encrypted',
  modelProfiles: [
    {
      id: profileId,
      name: 'Text profile',
      baseUrl: 'https://example.com',
      modelName: 'text-model',
      protocol: 'openai-responses',
      authentication: 'api-key',
      imageGenerationQuality: 'auto',
      apiKeyConfigured: true,
      credentialSource: 'encrypted'
    }
  ],
  defaultModelProfileId: profileId,
  opencodeModelSource: { kind: 'platform' },
  continueModelSource: { kind: 'platform' },
  deepseekHarnessModelSource: { kind: 'platform' },
  secureStorageAvailable: true
}

const project: AssistantProject = {
  id: '00000000-0000-4000-8000-000000000101',
  name: 'Local project',
  description: 'Local description',
  rootPath: 'C:\\Workspace',
  executionSpace: {
    kind: 'local',
    rootPath: 'C:\\Workspace'
  },
  defaultWorkMode: 'ask',
  runtimeSelection: { provider: 'model', profileId },
  kind: 'user',
  status: 'active',
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z'
}

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await i18n.changeLanguage('zh-CN')
  vi.restoreAllMocks()
})

function renderSwitcher(
  currentProject: AssistantProject = project,
  {
    projects = [currentProject],
    remoteProjectsEnabled = true,
    recoveryByProjectId = {}
  }: {
    projects?: AssistantProject[]
    remoteProjectsEnabled?: boolean
    recoveryByProjectId?: Record<
      string,
      RemoteProjectRecoveryState
    >
  } = {}
): {
  onCreate: ReturnType<typeof vi.fn>
  onDelete: ReturnType<typeof vi.fn>
  onRemoteCommitted: ReturnType<typeof vi.fn>
  onSelect: ReturnType<typeof vi.fn>
  onSelectRoot: ReturnType<typeof vi.fn>
  onUpdate: ReturnType<typeof vi.fn>
} {
  const onCreate = vi.fn(async (input) => ({
    ...currentProject,
    ...input
  }))
  const onUpdate = vi.fn(async (_projectId, input) => ({
    ...currentProject,
    ...input
  }))
  const onRemoteCommitted = vi.fn(async () => undefined)
  const onSelectRoot = vi.fn(async () => undefined)
  const onDelete = vi.fn(async () => undefined)
  const onSelect = vi.fn()
  const onRetryRecovery = vi.fn(async () => undefined)
  render(
    <ProjectSwitcher
      activeProjectId={currentProject.id}
      onArchive={vi.fn(async () => undefined)}
      onCreate={onCreate}
      onDelete={onDelete}
      onRemoteCommitted={onRemoteCommitted}
      onRetryRecovery={onRetryRecovery}
      onSelect={onSelect}
      onSelectRoot={onSelectRoot}
      onUpdate={onUpdate}
      projects={projects}
      recoveryByProjectId={recoveryByProjectId}
      remoteProjectsEnabled={remoteProjectsEnabled}
      runtimeSettings={runtimeSettings}
    />
  )
  return {
    onCreate,
    onDelete,
    onRemoteCommitted,
    onSelect,
    onSelectRoot,
    onUpdate
  }
}

const hostId = '00000000-0000-4000-8000-000000000201'
const remoteProjectId = '00000000-0000-4000-8000-000000000203'

function directoryResult(
  path: string,
  entries: SshDirectoryBrowseResult['entries'] = []
): SshDirectoryBrowseResult {
  const separator = path.lastIndexOf('/')
  return {
    path,
    homeDirectory: '/home/builder',
    parentPath:
      path === '/' ? null : separator === 0 ? '/' : path.slice(0, separator),
    entries,
    truncated: false
  }
}

function installRemoteApi(
  options: {
    hostValidated?: boolean
    connectionState?: SshHostAgentConnectionState
  } = {}
) {
  let progress: ((value: { phase: 'host' | 'agent' }) => void) | undefined
  let connectionStatusListener:
    | ((status: SshHostAgentConnectionStatus) => void)
    | undefined
  const savedProject: AssistantProject = {
    ...project,
    id: remoteProjectId,
    name: 'Remote project',
    rootPath: '/srv/project',
    executionSpace: {
      kind: 'ssh',
      hostId,
      remoteRootPath: '/srv/project'
    },
    runtimeSelection: { provider: 'opencode' }
  }
  const save = vi.fn(async () => savedProject)
  const cancelCurrent = vi.fn(async () => undefined)
  const browseDirectories = vi.fn(async (_hostId, path?: string) =>
    directoryResult(path ?? '/home/builder', [
      {
        name: 'projects',
        path:
          path === '/srv'
            ? '/srv/projects'
            : '/home/builder/projects'
      }
    ])
  )
  const cancelDirectoryBrowse = vi.fn(async () => undefined)
  const hostValidated = options.hostValidated !== false
  const host: SshHost = {
    id: hostId,
    name: 'Build host',
    hostname: 'build.example.com',
    port: 22,
    username: 'builder',
    authentication: 'system-agent',
    credentialConfigured: true,
    credentialSource: 'system-agent',
    hostKey: {
      state: hostValidated ? 'verified' : 'unverified',
      generation: 1
    },
    ...(hostValidated
      ? { lastValidatedAt: '2026-08-04T00:00:00.000Z' }
      : {}),
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z'
  }
  const getSnapshot = vi.fn(async (): Promise<SshHostsSnapshot> => ({
    hosts: [host],
    secureStorageAvailable: true,
    agentConnectionStatusByHostId: {
      [hostId]: options.connectionState ?? 'disconnected'
    }
  }))
  const onAgentConnectionStatus = vi.fn(
    (listener: (status: SshHostAgentConnectionStatus) => void) => {
      connectionStatusListener = listener
      return vi.fn()
    }
  )
  const currentVersion = {
    version: '1.0.0',
    architecture: 'x64' as const
  }
  const getRemoteEnvironment = vi.fn(
    async (requestedHostId: string): Promise<SshHostRemoteEnvironment> => ({
      hostId: requestedHostId,
      checkedAt: '2026-08-24T00:00:00.000Z',
      architecture: 'x64',
      agent: {
        state: 'current',
        expected: currentVersion,
        installed: currentVersion
      },
      runtimes: [
        {
          runtimeId: 'opencode',
          provider: 'opencode',
          state: 'current',
          expected: currentVersion,
          installed: currentVersion
        }
      ],
      remoteDownload: {
        available: true,
        source: 'github',
        packageSize: 1024
      }
    })
  )
  const updateRemoteEnvironment = vi.fn(async () => undefined)
  const onSaveProgress = vi.fn(
    (listener: (value: { phase: 'host' | 'agent' }) => void) => {
    progress = listener
    return vi.fn()
    }
  )
  Object.defineProperty(window, 'goodbuddy', {
    configurable: true,
    value: {
      sshHosts: {
        browseDirectories,
        cancelDirectoryBrowse,
        getSnapshot,
        onAgentConnectionStatus,
        getRemoteEnvironment,
        updateRemoteEnvironment
      },
      projects: {
        remote: {
          save,
          cancelCurrent,
          onSaveProgress
        }
      }
    }
  })
  return {
    save,
    cancelCurrent,
    browseDirectories,
    cancelDirectoryBrowse,
    getSnapshot,
    host,
    onAgentConnectionStatus,
    getRemoteEnvironment,
    updateRemoteEnvironment,
    onSaveProgress,
    emitConnectionStatus: (
      state: SshHostAgentConnectionStatus['state'],
      requestedHostId = hostId
    ) =>
      connectionStatusListener?.({
        hostId: requestedHostId,
        state
      }),
    emit: (phase: 'host' | 'agent') => progress?.({ phase })
  }
}

describe('ProjectSwitcher project activity integration', () => {
  it('keeps per-project title counts and menu ordering stable across recovery and Host states', async () => {
    const api = installRemoteApi({ connectionState: 'connecting' })
    const remote: AssistantProject = {
      ...project, id: remoteProjectId, name: 'Remote activity',
      executionSpace: { kind: 'ssh', hostId, remoteRootPath: '/srv/project' }
    }
    const idle = { ...remote, id: 'idle-project', name: 'Idle remote' }
    const props = {
      activeProjectId: project.id, projects: [project, remote, idle],
      remoteProjectsEnabled: true, onArchive: vi.fn(), onCreate: vi.fn(),
      onDelete: vi.fn(), onRemoteCommitted: vi.fn(), onSelect: vi.fn(),
      onSelectRoot: vi.fn(), onUpdate: vi.fn(),
      activityByProjectId: {
        [project.id]: { running: 1, attention: 0 },
        [remote.id]: { running: 2, attention: 3 }
      }
    }
    const { rerender } = render(<ProjectSwitcher {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '当前项目' }))
    const menu = screen.getByRole('menu', { name: '当前项目' })
    await within(menu).findByRole('group', { name: 'SSH 主机：Build host' })
    for (const stage of ['agent', 'failed', 'completed'] as const) {
      rerender(<ProjectSwitcher {...props} recoveryByProjectId={{
        [remote.id]: { projectId: remote.id, requestId: 'activity-recovery', stage,
          message: 'Host unreachable', retryable: true }
      }} />)
      act(() => api.emitConnectionStatus(stage === 'agent' ? 'connecting' : stage === 'failed' ? 'disconnected' : 'ready'))
      const rows = within(menu).getAllByRole('menuitemradio')
      expect(rows.map((row) => row.querySelector('b')?.textContent))
        .toEqual(['Local project', 'Remote activity', 'Idle remote'])
      expect(rows[0]!.querySelector('.project-switcher__project-heading'))
        .toHaveTextContent('Local project 1 个运行中')
      const heading = rows[1]!.querySelector('.project-switcher__project-heading')!
      expect(heading).toHaveTextContent('Remote activity3 个待处理 2 个运行中')
      expect(heading.querySelector('b')?.nextElementSibling).toHaveClass('project-activity__counts')
      expect(rows[2]!.querySelector('.project-activity__counts')).toBeNull()
    }
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Remote activity/u }))
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(remote.id)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('ProjectSwitcher runtime fields', () => {
  it.each(['新建项目', '项目设置'])('keeps %s outside the sidebar and restores focus after closing', (name) => {
    renderSwitcher()
    const trigger = screen.getByRole('button', {
      name: name === '项目设置' ? '当前项目' : name
    })
    fireEvent.click(trigger)
    if (name === '项目设置') {
      fireEvent.click(screen.getByRole('menuitem', {
        name: '管理项目 Local project'
      }))
    }
    const dialog = screen.getByRole('dialog', { name })
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    const body = dialog.querySelector('.project-create-card__body')!
    const close = within(dialog).getByRole('button', { name: `关闭${name}` })
    expect(body).toContainElement(within(dialog).getByLabelText('名称'))
    expect(body).not.toContainElement(close)
    expect(body).not.toContainElement(within(dialog).getByRole('button', { name: '取消' }))
    fireEvent.scroll(body, { target: { scrollTop: 500 } })
    fireEvent.click(close)
    expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('creates an ordinary project with DeepSeek Harness', async () => {
    const { onCreate } = renderSwitcher()

    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'Harness project' }
    })
    const runtime = within(dialog).getByLabelText(
      '新对话默认 Runtime'
    )
    expect(
      within(runtime).getByRole('option', {
        name: 'DeepSeek Harness（预览 · OpenAI 兼容）'
      })
    ).toBeInTheDocument()
    fireEvent.change(runtime, {
      target: {
        value: agentRuntimeSelectionKey({
          provider: 'deepseek-harness'
        })
      }
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '创建' })
    )

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Harness project',
          runtimeSelection: { provider: 'deepseek-harness' }
        })
      )
    )
  })

  it('edits an ordinary project to use DeepSeek Harness and switches work mode by keyboard', async () => {
    const { onUpdate } = renderSwitcher()

    fireEvent.click(screen.getByRole('button', { name: '当前项目' }))
    fireEvent.click(screen.getByRole('menuitem', {
      name: '管理项目 Local project'
    }))
    const dialog = screen.getByRole('dialog', { name: '项目设置' })
    fireEvent.change(
      within(dialog).getByLabelText('新对话默认 Runtime'),
      {
        target: {
          value: agentRuntimeSelectionKey({
            provider: 'deepseek-harness'
          })
        }
      }
    )
    const modeGroup = within(dialog)
      .getAllByRole('group', { name: '默认模式' })
      .find((candidate) =>
        candidate.classList.contains('segmented-control')
      )!
    const ask = within(modeGroup).getByRole('button', {
      name: 'Ask · 只读问答'
    })
    const execute = within(modeGroup).getByRole('button', {
      name: 'Execute · 完全权限'
    })
    fireEvent.keyDown(ask, { key: 'ArrowRight' })
    expect(execute).toHaveFocus()
    expect(execute).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(
      within(dialog).getByRole('button', { name: '保存项目' })
    )
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          defaultWorkMode: 'execute',
          runtimeSelection: { provider: 'deepseek-harness' }
        })
      )
    )
  })

  it('localizes shared runtime and work mode fields in English', async () => {
    await i18n.changeLanguage('en-US')
    renderSwitcher()

    fireEvent.click(screen.getByLabelText('New project'))
    const dialog = screen.getByRole('dialog', { name: 'New project' })
    expect(
      within(dialog).getByLabelText(
        'Default Runtime for new conversations'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog)
        .getAllByRole('group', { name: 'Default mode' })
        .find((candidate) =>
          candidate.classList.contains('segmented-control')
        )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('option', {
        name: 'DeepSeek Harness (Preview · OpenAI-compatible)'
      })
    ).toBeInTheDocument()
  })
})

describe('ProjectSwitcher managed SSH projects', () => {
  it('groups remote projects by SSH Host and shows live connection status beside the Host', async () => {
    await i18n.changeLanguage('en-US')
    const api = installRemoteApi({
      connectionState: 'connecting'
    })
    const secondHostId =
      '00000000-0000-4000-8000-000000000202'
    const secondHost: SshHost = {
      ...api.host,
      id: secondHostId,
      name: 'Deploy host',
      hostname: 'deploy.example.com'
    }
    api.getSnapshot.mockResolvedValue({
      hosts: [api.host, secondHost],
      secureStorageAvailable: true,
      agentConnectionStatusByHostId: {
        [hostId]: 'connecting',
        [secondHostId]: 'ready'
      }
    })
    const firstRemote: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'API service',
      rootPath: '/srv/api',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/api'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    const secondRemote: AssistantProject = {
      ...firstRemote,
      id: '00000000-0000-4000-8000-000000000204',
      name: 'Web service',
      rootPath: '/srv/web',
      executionSpace: {
        kind: 'ssh',
        hostId: secondHostId,
        remoteRootPath: '/srv/web'
      }
    }
    renderSwitcher(project, {
      projects: [project, firstRemote, secondRemote]
    })

    fireEvent.click(
      screen.getByRole('button', { name: 'Current project' })
    )
    const menu = screen.getByRole('menu', {
      name: 'Current project'
    })
    const buildHost = await waitFor(() =>
      within(menu).getByRole('group', {
        name: 'SSH host: Build host'
      })
    )
    const deployHost = within(menu).getByRole('group', {
      name: 'SSH host: Deploy host'
    })
    expect(buildHost).toHaveTextContent('Connecting')
    expect(buildHost).toHaveTextContent('/srv/api')
    expect(deployHost).toHaveTextContent('Ready')
    expect(deployHost).toHaveTextContent('/srv/web')
    expect(within(menu).queryByText(/Managed SSH/u)).not.toBeInTheDocument()

    act(() => api.emitConnectionStatus('ready'))
    await waitFor(() =>
      expect(buildHost).toHaveTextContent('Ready')
    )
  })

  it('does not let an older Host snapshot overwrite a newer connection event', async () => {
    await i18n.changeLanguage('en-US')
    const api = installRemoteApi()
    let resolveSnapshot:
      | ((snapshot: SshHostsSnapshot) => void)
      | undefined
    api.getSnapshot.mockReturnValueOnce(
      new Promise<SshHostsSnapshot>((resolve) => {
        resolveSnapshot = resolve
      })
    )
    const remoteProject: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'API service',
      rootPath: '/srv/api',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/api'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    renderSwitcher(project, {
      projects: [project, remoteProject]
    })

    fireEvent.click(
      screen.getByRole('button', { name: 'Current project' })
    )
    await waitFor(() =>
      expect(api.getSnapshot).toHaveBeenCalledOnce()
    )
    await waitFor(() =>
      expect(api.onAgentConnectionStatus).toHaveBeenCalledOnce()
    )
    act(() => api.emitConnectionStatus('ready'))
    await waitFor(() =>
      expect(
        screen.getByText('Ready', {
          selector: '.project-switcher__host-status'
        })
      ).toBeInTheDocument()
    )
    await act(async () => {
      resolveSnapshot?.({
        hosts: [api.host],
        secureStorageAvailable: true,
        agentConnectionStatusByHostId: {
          [hostId]: 'disconnected'
        }
      })
      await Promise.resolve()
    })

    const hostGroup = await screen.findByRole('group', {
      name: 'SSH host: Build host'
    })
    expect(hostGroup).toHaveTextContent('Ready')
    expect(hostGroup).not.toHaveTextContent('Disconnected')
  })

  it('shows independent exact recovery stages and decimal cursor progress', async () => {
    await i18n.changeLanguage('en-US')
    const first: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'First remote',
      rootPath: '/srv/first',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/first'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    const second: AssistantProject = {
      ...first,
      id: '00000000-0000-4000-8000-000000000204',
      name: 'Second remote',
      rootPath: '/srv/second',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/second'
      }
    }
    renderSwitcher(first, {
      projects: [first, second],
      recoveryByProjectId: {
        [first.id]: {
          projectId: first.id,
          requestId: '00000000-0000-4000-8000-000000000301',
          stage: 'agent'
        },
        [second.id]: {
          projectId: second.id,
          requestId: '00000000-0000-4000-8000-000000000302',
          stage: 'cursor',
          current: '15'
        }
      }
    })

    expect(
      screen.getByRole('button', { name: 'Current project' })
    ).toHaveTextContent('Restoring remote Agent…')
    fireEvent.click(
      screen.getByRole('button', { name: 'Current project' })
    )
    const menu = screen.getByRole('menu', {
      name: 'Current project'
    })
    expect(
      within(menu).getByText('Restoring remote Agent…')
    ).toBeInTheDocument()
    expect(
      within(menu).getByText('Restoring conversation at event 15')
    ).toBeInTheDocument()
  })

  it('expires completion feedback once per request across project switches and menu mounts', async () => {
    await i18n.changeLanguage('en-US')
    installRemoteApi()
    vi.useFakeTimers()
    const remote: AssistantProject = {
      ...project,
      id: remoteProjectId,
      executionSpace: { kind: 'ssh', hostId, remoteRootPath: '/srv/project' }
    }
    const props = {
      onArchive: vi.fn(), onCreate: vi.fn(), onDelete: vi.fn(),
      onRemoteCommitted: vi.fn(), onSelect: vi.fn(),
      onSelectRoot: vi.fn(), onUpdate: vi.fn(),
      projects: [project, remote], remoteProjectsEnabled: true
    }
    const completed: RemoteProjectRecoveryState = {
      projectId: remote.id,
      requestId: '00000000-0000-4000-8000-000000000301',
      stage: 'completed'
    }
    const view = (activeProjectId: string, state: RemoteProjectRecoveryState = completed) => (
      <ProjectSwitcher {...props} activeProjectId={activeProjectId}
        recoveryByProjectId={{ [remote.id]: { ...state } }} />
    )
    const { rerender, unmount } = render(view(remote.id))
    const trigger = screen.getByRole('button', { name: 'Current project' })
    expect(within(trigger).getByRole('status')).toHaveTextContent('Recovery completed')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    rerender(view(project.id))
    fireEvent.click(trigger)
    expect(within(screen.getByRole('menu')).getByRole('status'))
      .toHaveTextContent('Recovery completed')
    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(screen.getByText('Recovery completed')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.queryByText('Recovery completed')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    rerender(view(remote.id))
    fireEvent.click(trigger)
    expect(screen.queryByText('Recovery completed')).not.toBeInTheDocument()
    expect(completed.stage).toBe('completed')

    const next = { ...completed, requestId: '00000000-0000-4000-8000-000000000302' }
    rerender(view(remote.id, { ...next, stage: 'network' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(within(trigger).getByRole('status')).toHaveAttribute('aria-busy', 'true')
    rerender(view(remote.id, next))
    expect(screen.getAllByText('Recovery completed')).toHaveLength(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(screen.queryByText('Recovery completed')).not.toBeInTheDocument()
    rerender(view(remote.id, { ...next, requestId: 'new-request' }))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires background completions independently and cancels obsolete completion timers', async () => {
    await i18n.changeLanguage('en-US')
    installRemoteApi()
    vi.useFakeTimers()
    const remote: AssistantProject = {
      ...project, id: remoteProjectId,
      executionSpace: { kind: 'ssh', hostId, remoteRootPath: '/srv/project' }
    }
    const second = { ...remote, id: 'second-project', name: 'Second remote' }
    const onRetryRecovery = vi.fn(async () => undefined)
    const props = {
      activeProjectId: project.id,
      onArchive: vi.fn(), onCreate: vi.fn(), onDelete: vi.fn(),
      onRemoteCommitted: vi.fn(), onSelect: vi.fn(), onRetryRecovery,
      onSelectRoot: vi.fn(), onUpdate: vi.fn(),
      projects: [project, remote, second], remoteProjectsEnabled: true
    }
    const firstState: RemoteProjectRecoveryState = {
      projectId: remote.id, requestId: 'first-request', stage: 'completed'
    }
    const secondState: RemoteProjectRecoveryState = {
      projectId: second.id, requestId: 'second-request', stage: 'completed'
    }
    const { rerender } = render(<ProjectSwitcher {...props}
      recoveryByProjectId={{ [remote.id]: firstState }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    rerender(<ProjectSwitcher {...props} recoveryByProjectId={{
      [remote.id]: { ...firstState }, [second.id]: secondState
    }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByText('Recovery completed')).toHaveLength(1)
    expect(within(menu).getByRole('menuitemradio', { name: /Second remote/u }))
      .toHaveTextContent('Recovery completed')
    rerender(<ProjectSwitcher {...props} recoveryByProjectId={{
      [remote.id]: firstState,
      [second.id]: { ...secondState, requestId: 'retry-request', stage: 'failed',
        message: 'Host unreachable', retryable: true }
    }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(within(menu).getByRole('alert')).toHaveTextContent('Host unreachable')
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', {
        name: 'Retry recovery for project Second remote'
      }))
    })
    expect(onRetryRecovery).toHaveBeenCalledWith(second.id)
    expect(screen.queryByText('Recovery completed')).not.toBeInTheDocument()
  })

  it('keeps recovery retry inside the project menu while showing the collapsed failure', async () => {
    await i18n.changeLanguage('en-US')
    const remoteProject: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'Remote project',
      rootPath: '/srv/project',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/project'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    const onRetryRecovery = vi.fn(async () => undefined)
    render(
      <ProjectSwitcher
        activeProjectId={remoteProject.id}
        onArchive={vi.fn(async () => undefined)}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRemoteCommitted={vi.fn()}
        onRetryRecovery={onRetryRecovery}
        onSelect={vi.fn()}
        onSelectRoot={vi.fn()}
        onUpdate={vi.fn()}
        projects={[remoteProject]}
        recoveryByProjectId={{
          [remoteProject.id]: {
            projectId: remoteProject.id,
            requestId: '00000000-0000-4000-8000-000000000303',
            stage: 'failed',
            message: 'Host unreachable',
            retryable: true
          }
        }}
        remoteProjectsEnabled
      />
    )

    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(
      'Recovery failed: Host unreachable'
    )
    expect(screen.queryByRole('button', {
      name: 'Retry recovery for project Remote project'
    })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    const menu = screen.getByRole('menu', { name: 'Current project' })
    fireEvent.click(
      within(menu).getByRole('menuitem', {
        name: 'Retry recovery for project Remote project'
      })
    )
    await waitFor(() =>
      expect(onRetryRecovery).toHaveBeenCalledWith(remoteProject.id)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Retry recovery for project Remote project')).not.toBeInTheDocument()
  })

  it('hides remote projects and APIs when the feature is disabled', async () => {
    await i18n.changeLanguage('en-US')
    const api = installRemoteApi()
    const remoteProject: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'Remote project',
      rootPath: '/srv/project',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/project'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    renderSwitcher(project, {
      projects: [project, remoteProject],
      remoteProjectsEnabled: false
    })

    fireEvent.click(screen.getByLabelText('Current project'))
    const menu = screen.getByRole('menu', { name: 'Current project' })
    expect(
      within(menu).queryByRole('group', { name: 'Remote projects' })
    ).not.toBeInTheDocument()
    expect(within(menu).queryByText('Remote project')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('New project'))
    const dialog = screen.getByRole('dialog', { name: 'New project' })
    expect(
      within(dialog).queryByRole('button', { name: 'Managed SSH' })
    ).not.toBeInTheDocument()
    expect(api.getSnapshot).not.toHaveBeenCalled()
    expect(api.onSaveProgress).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('refuses settings for a saved SSH project while disabled', () => {
    const api = installRemoteApi()
    const remoteProject: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'Remote project',
      rootPath: '/srv/project',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/project'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    renderSwitcher(remoteProject, { remoteProjectsEnabled: false })

    expect(screen.queryByRole('button', {
      name: '项目设置'
    })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '当前项目' }))
    expect(within(screen.getByRole('menu', { name: '当前项目' }))
      .queryByRole('menuitem', {
        name: '管理项目 Remote project'
      })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: '项目设置' })
    ).not.toBeInTheDocument()
    expect(api.getSnapshot).not.toHaveBeenCalled()
    expect(api.onSaveProgress).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('deletes an unreachable remote project from the list without activating it', async () => {
    const api = installRemoteApi()
    const remoteProject: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'Remote project',
      rootPath: '/srv/missing',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/missing'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    const { onDelete, onSelect } = renderSwitcher(project, {
      projects: [project, remoteProject]
    })

    fireEvent.click(screen.getByLabelText('当前项目'))
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: '管理项目 Remote project'
      })
    )
    const dialog = screen.getByRole('dialog', { name: '项目设置' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(api.getRemoteEnvironment).not.toHaveBeenCalled()
    expect(api.browseDirectories).not.toHaveBeenCalled()

    fireEvent.click(
      within(dialog).getByRole('button', { name: '删除项目' })
    )
    fireEvent.change(
      within(dialog).getByLabelText(
        '输入“Remote project”确认删除'
      ),
      { target: { value: 'Remote project' } }
    )
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: '永久删除项目'
      })
    )

    await waitFor(() =>
      expect(onDelete).toHaveBeenCalledWith(
        remoteProjectId,
        'Remote project'
      )
    )
    expect(onSelect).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('uses remote work directory copy and opens from a valid typed path', async () => {
    await i18n.changeLanguage('en-US')
    const api = installRemoteApi()
    const { onSelectRoot } = renderSwitcher()
    fireEvent.click(screen.getByLabelText('New project'))
    const dialog = screen.getByRole('dialog', { name: 'New project' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Managed SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    const input = within(dialog).getByLabelText(
      'Remote work directory'
    )
    fireEvent.change(input, {
      target: { value: '/srv' }
    })
    const trigger = within(dialog).getByRole('button', {
      name: 'Browse remote work directory'
    })
    expect(trigger).toHaveAttribute(
      'title',
      'Browse remote work directory'
    )
    fireEvent.click(trigger)
    expect(
      await screen.findByRole('dialog', {
        name: 'Select remote work directory'
      })
    ).toBeInTheDocument()
    expect(api.browseDirectories).toHaveBeenCalledWith(hostId, '/srv')
    expect(onSelectRoot).not.toHaveBeenCalled()
    expect(
      within(dialog).queryByLabelText('Remote root')
    ).not.toBeInTheDocument()
  })

  it('starts from the home directory when the typed path is invalid', async () => {
    const api = installRemoteApi()
    renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    fireEvent.change(within(dialog).getByLabelText('远端工作目录'), {
      target: { value: 'relative/path' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: '浏览远端工作目录'
      })
    )
    await waitFor(() =>
      expect(api.browseDirectories).toHaveBeenCalledWith(
        hostId,
        undefined
      )
    )
  })

  it('navigates child and parent directories and selects only the draft path', async () => {
    const api = installRemoteApi()
    api.browseDirectories.mockImplementation(
      async (_requestedHostId, path?: string) => {
        if (path === '/srv/projects') {
          return directoryResult(path, [
            { name: 'goodbuddy', path: '/srv/projects/goodbuddy' }
          ])
        }
        return directoryResult(path ?? '/home/builder', [
          { name: 'projects', path: '/srv/projects' }
        ])
      }
    )
    const { onSelectRoot } = renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    fireEvent.change(within(dialog).getByLabelText('远端工作目录'), {
      target: { value: '/srv' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: '浏览远端工作目录'
      })
    )
    const picker = await screen.findByRole('dialog', {
      name: '选择远端工作目录'
    })
    fireEvent.click(
      await within(picker).findByRole('button', {
        name: '打开目录 projects'
      })
    )
    await waitFor(() =>
      expect(api.browseDirectories).toHaveBeenLastCalledWith(
        hostId,
        '/srv/projects'
      )
    )
    expect(
      within(picker).getByText('/srv/projects')
    ).toBeInTheDocument()
    fireEvent.click(
      within(picker).getByRole('button', {
        name: '返回上级目录'
      })
    )
    await waitFor(() =>
      expect(api.browseDirectories).toHaveBeenLastCalledWith(
        hostId,
        '/srv'
      )
    )
    fireEvent.click(
      within(picker).getByRole('button', {
        name: '选择此目录'
      })
    )
    await waitFor(() =>
      expect(within(dialog).getByLabelText('远端工作目录')).toHaveValue(
        '/srv'
      )
    )
    expect(onSelectRoot).not.toHaveBeenCalled()
  })

  it('keeps the outer dialog open and restores trigger focus after cancel and Escape', async () => {
    const api = installRemoteApi()
    renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    const input = within(dialog).getByLabelText('远端工作目录')
    fireEvent.change(input, { target: { value: '/keep/me' } })
    const trigger = within(dialog).getByRole('button', {
      name: '浏览远端工作目录'
    })
    fireEvent.click(trigger)
    let picker = await screen.findByRole('dialog', {
      name: '选择远端工作目录'
    })
    fireEvent.click(
      within(picker).getByRole('button', { name: '取消' })
    )
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(dialog).toBeInTheDocument()
    expect(input).toHaveValue('/keep/me')

    fireEvent.click(trigger)
    picker = await screen.findByRole('dialog', {
      name: '选择远端工作目录'
    })
    fireEvent.click(
      within(picker).getByRole('button', {
        name: '关闭远端目录选择器'
      })
    )
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(dialog).toBeInTheDocument()
    expect(input).toHaveValue('/keep/me')

    fireEvent.click(trigger)
    picker = await screen.findByRole('dialog', {
      name: '选择远端工作目录'
    })
    fireEvent.keyDown(picker, { key: 'Escape' })
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: '选择远端工作目录'
        })
      ).not.toBeInTheDocument()
    )
    expect(dialog).toBeInTheDocument()
    expect(input).toHaveValue('/keep/me')
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(api.cancelDirectoryBrowse).toHaveBeenCalledTimes(3)
  })

  it('closes the new-project dialog through its top-right button', () => {
    renderSwitcher()

    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    const close = within(dialog).getByRole('button', {
      name: '关闭新建项目'
    })

    expect(close).toHaveClass('project-create-card__close')
    fireEvent.click(close)

    expect(
      screen.queryByRole('dialog', { name: '新建项目' })
    ).not.toBeInTheDocument()
  })

  it('ignores stale browse results and preserves the typed path after an error', async () => {
    const api = installRemoteApi()
    let finishFirst!: (value: SshDirectoryBrowseResult) => void
    api.browseDirectories
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve
          })
      )
      .mockRejectedValueOnce(new Error('Permission denied'))
    renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    const input = within(dialog).getByLabelText('远端工作目录')
    fireEvent.change(input, { target: { value: '/typed/path' } })
    const trigger = within(dialog).getByRole('button', {
      name: '浏览远端工作目录'
    })
    fireEvent.click(trigger)
    const firstPicker = await screen.findByRole('dialog', {
      name: '选择远端工作目录'
    })
    fireEvent.click(
      within(firstPicker).getByRole('button', { name: '取消' })
    )
    await waitFor(() => expect(trigger).toHaveFocus())
    fireEvent.click(trigger)
    const secondPicker = await screen.findByRole('dialog', {
      name: '选择远端工作目录'
    })
    expect(
      await within(secondPicker).findByRole('alert')
    ).toHaveTextContent('Permission denied')
    finishFirst(
      directoryResult('/stale', [
        { name: 'result', path: '/stale/result' }
      ])
    )
    await Promise.resolve()
    expect(within(secondPicker).queryByText('/stale')).not.toBeInTheDocument()
    expect(input).toHaveValue('/typed/path')
  })

  it('saves Execute in one request without extra confirmation checklists', async () => {
    const api = installRemoteApi()
    const { onRemoteCommitted } = renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'Remote project' }
    })
    fireEvent.change(within(dialog).getByLabelText('远端工作目录'), {
      target: { value: '/srv/project' }
    })
    const modeGroup = within(dialog)
      .getAllByRole('group', { name: '默认模式' })
      .find((candidate) =>
        candidate.classList.contains('segmented-control')
      )!
    fireEvent.click(
      within(modeGroup).getByRole('button', {
        name: 'Execute · 完全权限'
      })
    )
    const save = within(dialog).getByRole('button', {
      name: '保存远程项目'
    })
    expect(save).toBeEnabled()
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(save)
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    expect(api.save).toHaveBeenCalledWith({
      intent: 'create',
      draft: expect.objectContaining({
        defaultWorkMode: 'execute',
        hostId,
        remoteRootPath: '/srv/project'
      })
    })
    await waitFor(() =>
      expect(onRemoteCommitted).toHaveBeenCalledWith(
        expect.objectContaining({ id: remoteProjectId })
      )
    )
  })

  it('shows request-scoped progress while the awaited save is pending', async () => {
    const api = installRemoteApi()
    let finish!: (value: AssistantProject) => void
    api.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'Remote project' }
    })
    fireEvent.change(within(dialog).getByLabelText('远端工作目录'), {
      target: { value: '/srv/project' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: '保存远程项目'
      })
    )
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    api.emit('agent')
    expect(
      await within(dialog).findByText('当前阶段：远端 Agent')
    ).toBeInTheDocument()
    finish({
      ...project,
      id: remoteProjectId
    })
  })

  it('preserves fields and the actionable error after a failed save', async () => {
    const api = installRemoteApi()
    api.save.mockRejectedValueOnce(new Error('Runtime unavailable'))
    renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'Keep this draft' }
    })
    fireEvent.change(within(dialog).getByLabelText('远端工作目录'), {
      target: { value: '/srv/project' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: '保存远程项目'
      })
    )
    expect(
      await within(dialog).findByText('Runtime unavailable')
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText('名称')).toHaveValue(
      'Keep this draft'
    )
  })

  it('cancels the current save when the dialog closes', async () => {
    const api = installRemoteApi()
    api.save.mockImplementationOnce(() => new Promise(() => undefined))
    renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'Keep this draft' }
    })
    fireEvent.change(within(dialog).getByLabelText('远端工作目录'), {
      target: { value: '/srv/project' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '保存远程项目' })
    )
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    fireEvent.click(
      within(dialog).getByRole('button', { name: '取消' })
    )
    await waitFor(() => expect(api.cancelCurrent).toHaveBeenCalledOnce())
  })

  it('updates an existing SSH project without using the local update path', async () => {
    const api = installRemoteApi()
    const remoteProject: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'Remote project',
      rootPath: '/srv/project',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/project'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    const { onUpdate } = renderSwitcher(remoteProject)
    fireEvent.click(screen.getByRole('button', { name: '当前项目' }))
    fireEvent.click(screen.getByRole('menuitem', {
      name: '管理项目 Remote project'
    }))
    const dialog = screen.getByRole('dialog', { name: '项目设置' })
    await waitFor(() =>
      expect(
        within(dialog).getByRole('option', { name: /Build host/u })
      ).toBeInTheDocument()
    )
    expect(within(dialog).getByLabelText('SSH 主机')).toBeDisabled()
    expect(within(dialog).getByLabelText('远端工作目录')).toBeDisabled()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: '保存远程项目'
      })
    )
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        intent: 'update',
        draft: expect.objectContaining({
          projectId: remoteProjectId,
          hostId,
          remoteRootPath: '/srv/project'
        })
      })
    )
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('uses the local validated Host record and defers remote checks to the requested action', async () => {
    const api = installRemoteApi()
    renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )

    expect(
      await within(dialog).findByText(
        '此主机已验证。保存项目时才会连接并检查 Agent、工作区和 Runtime。'
      )
    ).toBeInTheDocument()
    expect(api.getRemoteEnvironment).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: 'Ready project' }
    })
    fireEvent.change(within(dialog).getByLabelText('远端工作目录'), {
      target: { value: '/srv/project' }
    })
    expect(
      within(dialog).getByRole('button', {
        name: '浏览远端工作目录'
      })
    ).toBeEnabled()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: '保存远程项目'
      })
    )
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    expect(api.updateRemoteEnvironment).not.toHaveBeenCalled()
  })

  it('disables a Host that has not completed local validation', async () => {
    const api = installRemoteApi({ hostValidated: false })
    const remoteProject: AssistantProject = {
      ...project,
      id: remoteProjectId,
      name: 'Remote project',
      rootPath: '/srv/project',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/project'
      },
      runtimeSelection: { provider: 'opencode' }
    }
    renderSwitcher(remoteProject)
    fireEvent.click(screen.getByRole('button', { name: '当前项目' }))
    fireEvent.click(screen.getByRole('menuitem', {
      name: '管理项目 Remote project'
    }))
    const dialog = screen.getByRole('dialog', { name: '项目设置' })

    expect(
      await within(dialog).findByText(
        /此主机尚未完成 Host Key 和连接验证/u
      )
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText('SSH 主机')).toHaveValue(hostId)
    expect(
      within(dialog).getByRole('option', {
        name: /Build host.*需要验证/u
      })
    ).toBeDisabled()
    const save = within(dialog).getByRole('button', {
      name: '保存远程项目'
    })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(api.save).not.toHaveBeenCalled()
    expect(api.updateRemoteEnvironment).not.toHaveBeenCalled()
  })

  it('never probes remote environments when the project form opens or reopens', async () => {
    const api = installRemoteApi()
    renderSwitcher()
    fireEvent.click(screen.getByLabelText('新建项目'))
    let dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    expect(
      await within(dialog).findByText(
        '此主机已验证。保存项目时才会连接并检查 Agent、工作区和 Runtime。'
      )
    ).toBeInTheDocument()
    expect(api.getRemoteEnvironment).not.toHaveBeenCalled()
    fireEvent.click(
      within(dialog).getByRole('button', { name: '取消' })
    )

    fireEvent.click(screen.getByLabelText('新建项目'))
    dialog = screen.getByRole('dialog', { name: '新建项目' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '托管 SSH' })
    )
    expect(
      await within(dialog).findByText(
        '此主机已验证。保存项目时才会连接并检查 Agent、工作区和 Runtime。'
      )
    ).toBeInTheDocument()
    expect(api.getSnapshot).toHaveBeenCalledTimes(2)
    expect(api.getRemoteEnvironment).not.toHaveBeenCalled()
    expect(api.updateRemoteEnvironment).not.toHaveBeenCalled()
  })
})
