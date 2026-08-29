import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProject } from '../../shared/assistant-contracts'
import type {
  RemoteEnvironmentPreparationMethod,
  RemoteEnvironmentUpdateProgress,
  SshHost,
  SshHostRemovalResult,
  SshHostRemoteEnvironment,
  SshHostValidationResult,
  SshHostsSnapshot
} from '../../shared/ssh-host-contracts'
import { changeUiLocale } from './i18n'
import { SshHostsSettingsSection } from './SshHostsSettingsSection'

const hostId = '00000000-0000-4000-8000-000000000104'
const candidateId = '00000000-0000-4000-8000-000000000105'
const fingerprint = `SHA256:${'A'.repeat(43)}`
const verifiedHost: SshHost = {
  id: hostId,
  name: 'Build host',
  hostname: 'build.example.com',
  port: 22,
  username: 'builder',
  authentication: 'password',
  credentialConfigured: true,
  credentialSource: 'encrypted',
  hostKey: {
    state: 'verified',
    algorithm: 'ssh-ed25519',
    fingerprintSha256: fingerprint,
    generation: 1
  },
  lastValidatedAt: '2026-08-01T00:00:01.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
}
const legacyUnverifiedHost: SshHost = {
  ...verifiedHost
}
delete legacyUnverifiedHost.lastValidatedAt
const emptySnapshot: SshHostsSnapshot = {
  hosts: [],
  secureStorageAvailable: true
}
const verifiedSnapshot: SshHostsSnapshot = {
  hosts: [verifiedHost],
  secureStorageAvailable: true
}
const validationResult: SshHostValidationResult = {
  host: verifiedHost,
  connection: {
    hostId,
    connected: true,
    latencyMs: 18,
    platform: 'linux',
    architecture: 'x64',
    shell: '/bin/bash',
    homeDirectory: '/home/builder',
    detail: 'SSH 已连接，远端系统为 linux/x64'
  }
}

const getSnapshot = vi.fn<() => Promise<SshHostsSnapshot>>()
const remove =
  vi.fn<(hostId: string) => Promise<SshHostRemovalResult>>()
const inspectDraftHostKey = vi.fn()
const discardCandidate = vi.fn()
const validateAndSave = vi.fn()
const getRemoteEnvironment =
  vi.fn<(hostId: string) => Promise<SshHostRemoteEnvironment>>()
const updateRemoteEnvironment =
  vi.fn<
    (input: {
      hostId: string
      method: RemoteEnvironmentPreparationMethod
    }) => Promise<void>
  >()
const cancelRemoteEnvironmentUpdate =
  vi.fn<(hostId: string) => Promise<void>>()
let remoteEnvironmentUpdateProgressListener:
  | ((event: RemoteEnvironmentUpdateProgress) => void)
  | undefined
const unsubscribeRemoteEnvironmentUpdateProgress = vi.fn()
const onRemoteEnvironmentUpdateProgress = vi.fn(
  (
    listener: (event: RemoteEnvironmentUpdateProgress) => void
  ): (() => void) => {
    remoteEnvironmentUpdateProgressListener = listener
    return unsubscribeRemoteEnvironmentUpdateProgress
  }
)

const remoteEnvironment: SshHostRemoteEnvironment = {
  hostId,
  checkedAt: '2030-01-01T00:00:00.000Z',
  architecture: 'x64',
  agent: {
    state: 'update-available',
    expected: {
      version: '0.11.1',
      architecture: 'x64'
    },
    installed: {
      version: '0.10.4',
      architecture: 'x64'
    }
  },
  runtimes: [{
    runtimeId: 'opencode',
    provider: 'opencode',
    state: 'current',
    expected: {
      version: '1.18.9',
      architecture: 'x64'
    },
    installed: {
      version: '1.18.9',
      architecture: 'x64'
    }
  }],
  remoteDownload: {
    available: true,
    source: 'mirror',
    packageSize: 64 * 1024 * 1024
  }
}

const currentRemoteEnvironment: SshHostRemoteEnvironment = {
  ...remoteEnvironment,
  agent: {
    ...remoteEnvironment.agent,
    state: 'current',
    installed: remoteEnvironment.agent.expected
  }
}

const notInstalledRemoteEnvironment: SshHostRemoteEnvironment = {
  ...remoteEnvironment,
  agent: {
    ...remoteEnvironment.agent,
    state: 'not-installed',
    installed: null
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function openNewHostDialog(): void {
  fireEvent.click(
    screen.getAllByRole('button', { name: '添加主机' })[0]!
  )
}

function fillConnectionDetails(): void {
  fireEvent.change(screen.getByLabelText('主机名称'), {
    target: { value: 'Build host' }
  })
  fireEvent.change(screen.getByLabelText('主机地址'), {
    target: { value: 'build.example.com' }
  })
  fireEvent.change(screen.getByLabelText('用户名'), {
    target: { value: 'builder' }
  })
}

async function inspectAndConfirmFirstKey(): Promise<void> {
  fireEvent.click(
    screen.getByRole('button', { name: '检查 Host Key' })
  )
  expect(
    await screen.findByText('这是首次看到该主机密钥。')
  ).toBeInTheDocument()
  const continueButton = screen.getByRole('button', {
    name: '确认身份并继续'
  })
  expect(continueButton).toBeDisabled()
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: '我已通过可信渠道核对并确认本次指纹'
    })
  )
  expect(continueButton).toBeEnabled()
  fireEvent.click(continueButton)
}

async function refreshHostEnvironment(
  name = 'Build host'
): Promise<HTMLElement> {
  const host = await screen.findByRole('region', { name })
  fireEvent.click(
    within(host).getByRole('button', {
      name: `刷新 ${name} 的远程运行环境版本`
    })
  )
  await within(host).findByText('GoodBuddy Agent')
  return host
}

describe('SshHostsSettingsSection', () => {
  beforeEach(async () => {
    await changeUiLocale('zh-CN')
    vi.clearAllMocks()
    getSnapshot.mockResolvedValue(emptySnapshot)
    remove.mockResolvedValue({
      hostId,
      deletedProjects: []
    })
    inspectDraftHostKey.mockResolvedValue({
      candidateId,
      state: 'unverified',
      algorithm: 'ssh-ed25519',
      fingerprintSha256: fingerprint
    })
    discardCandidate.mockResolvedValue(undefined)
    validateAndSave.mockResolvedValue(validationResult)
    getRemoteEnvironment.mockResolvedValue(remoteEnvironment)
    updateRemoteEnvironment.mockResolvedValue(undefined)
    cancelRemoteEnvironmentUpdate.mockResolvedValue(undefined)
    remoteEnvironmentUpdateProgressListener = undefined
    onRemoteEnvironmentUpdateProgress.mockImplementation(
      (
        listener: (event: RemoteEnvironmentUpdateProgress) => void
      ): (() => void) => {
        remoteEnvironmentUpdateProgressListener = listener
        return unsubscribeRemoteEnvironmentUpdateProgress
      }
    )
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        sshHosts: {
          getSnapshot,
          remove,
          inspectDraftHostKey,
          discardCandidate,
          validateAndSave,
          getRemoteEnvironment,
          updateRemoteEnvironment,
          cancelRemoteEnvironmentUpdate,
          onRemoteEnvironmentUpdateProgress
        }
      }
    })
  })

  afterEach(() => cleanup())

  it('validates identity and authentication before persisting a new host', async () => {
    getSnapshot
      .mockResolvedValueOnce(emptySnapshot)
      .mockResolvedValue(verifiedSnapshot)
    const onNotify = vi.fn()
    const onDirtyChange = vi.fn()
    const onHostUpdated = vi.fn()
    render(
      <SshHostsSettingsSection
        onDirtyChange={onDirtyChange}
        onHostUpdated={onHostUpdated}
        onNotify={onNotify}
      />
    )

    await screen.findByText('尚未配置 SSH 主机')
    openNewHostDialog()
    expect(
      screen.getByRole('dialog', {
        name: '添加并验证 SSH 主机'
      })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('主机名称')).toHaveFocus()
    fillConnectionDetails()
    await inspectAndConfirmFirstKey()

    expect(inspectDraftHostKey).toHaveBeenCalledWith({
      hostname: 'build.example.com',
      port: 22,
      username: 'builder'
    })
    expect(validateAndSave).not.toHaveBeenCalled()
    expect(screen.getByText(new RegExp(fingerprint))).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^SSH 密码/u), {
      target: { value: 'private password' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '验证并保存' })
    )

    await waitFor(() =>
      expect(validateAndSave).toHaveBeenCalledWith({
        candidateId,
        fingerprintSha256: fingerprint,
        input: {
          name: 'Build host',
          hostname: 'build.example.com',
          port: 22,
          username: 'builder',
          authentication: 'password',
          password: {
            action: 'replace',
            value: 'private password'
          }
        }
      })
    )
    expect(
      await screen.findByText('主机已验证并保存')
    ).toBeInTheDocument()
    expect(
      screen.queryByDisplayValue('private password')
    ).not.toBeInTheDocument()
    expect(onNotify).not.toHaveBeenCalled()
    expect(onHostUpdated).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    )
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    expect(
      screen.getByRole('region', { name: 'Build host' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('已连接 · linux/x64 · 18 毫秒')
    ).toBeInTheDocument()
    expect(getSnapshot).toHaveBeenCalledOnce()
  })

  it('keeps failed authentication editable and retries without saving a failed host', async () => {
    getSnapshot
      .mockResolvedValueOnce(emptySnapshot)
      .mockResolvedValue(verifiedSnapshot)
    validateAndSave
      .mockRejectedValueOnce(
        new Error('SSH 认证失败，请检查用户名和认证凭据')
      )
      .mockResolvedValueOnce(validationResult)
    render(<SshHostsSettingsSection />)

    await screen.findByText('尚未配置 SSH 主机')
    openNewHostDialog()
    fillConnectionDetails()
    await inspectAndConfirmFirstKey()
    const password = screen.getByLabelText(/^SSH 密码/u)
    fireEvent.change(password, {
      target: { value: 'wrong password' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '验证并保存' })
    )

    expect(
      await screen.findByText('SSH 认证失败，请检查用户名和认证凭据')
    ).toBeInTheDocument()
    expect(screen.getByDisplayValue('wrong password')).toBe(password)
    expect(
      screen.getByRole('dialog', {
        name: '添加并验证 SSH 主机'
      })
    ).toBeInTheDocument()
    expect(getSnapshot).toHaveBeenCalledOnce()

    fireEvent.change(password, {
      target: { value: 'correct password' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '验证并保存' })
    )
    expect(
      await screen.findByText('主机已验证并保存')
    ).toBeInTheDocument()
    expect(validateAndSave).toHaveBeenCalledTimes(2)
    expect(validateAndSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidateId,
        input: expect.objectContaining({
          password: {
            action: 'replace',
            value: 'correct password'
          }
        })
      })
    )
  })

  it('discards an inspected candidate when the add dialog is cancelled', async () => {
    render(<SshHostsSettingsSection />)

    await screen.findByText('尚未配置 SSH 主机')
    openNewHostDialog()
    fillConnectionDetails()
    fireEvent.click(
      screen.getByRole('button', { name: '检查 Host Key' })
    )
    await screen.findByText('这是首次看到该主机密钥。')
    fireEvent.keyDown(
      screen.getByRole('dialog', {
        name: '添加并验证 SSH 主机'
      }),
      { key: 'Escape' }
    )
    await waitFor(() =>
      expect(discardCandidate).toHaveBeenCalledWith(candidateId)
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(validateAndSave).not.toHaveBeenCalled()
    expect(getSnapshot).toHaveBeenCalledOnce()
  })

  it('shows old and new fingerprints in the changed-key dialog', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    const changedFingerprint = `SHA256:${'B'.repeat(43)}`
    inspectDraftHostKey.mockResolvedValue({
      candidateId,
      hostId,
      state: 'changed',
      algorithm: 'ssh-ed25519',
      fingerprintSha256: changedFingerprint,
      previousHostKey: {
        algorithm: 'ssh-ed25519',
        fingerprintSha256: fingerprint
      }
    })
    render(<SshHostsSettingsSection />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: '编辑 Build host'
      })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '检查 Host Key' })
    )

    expect(await screen.findByText(/可能是中间人攻击/u)).toBeInTheDocument()
    expect(screen.getByText('此前固定的指纹')).toBeInTheDocument()
    expect(screen.getByText('本次看到的指纹')).toBeInTheDocument()
    const dialog = screen.getByRole('dialog', {
      name: '编辑并重新验证 SSH 主机'
    })
    expect(
      within(dialog).getByText(new RegExp(fingerprint))
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(new RegExp(changedFingerprint))
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '确认替换并继续' })
    ).toBeDisabled()
    expect(inspectDraftHostKey).toHaveBeenCalledWith({
      hostId,
      hostname: 'build.example.com',
      port: 22,
      username: 'builder'
    })
  })

  it('reports a saved Host address edit after validation succeeds', async () => {
    const otherHostId = '00000000-0000-4000-8000-000000000106'
    const systemAgentHost: SshHost = {
      ...verifiedHost,
      authentication: 'system-agent',
      credentialSource: 'system-agent'
    }
    const otherHost: SshHost = {
      ...systemAgentHost,
      id: otherHostId,
      name: 'Other host',
      hostname: 'other.example.com'
    }
    const updatedHost: SshHost = {
      ...systemAgentHost,
      hostname: '10.7.0.23',
      hostKey: {
        ...systemAgentHost.hostKey,
        generation: 2
      },
      updatedAt: '2026-08-01T00:01:00.000Z'
    }
    getSnapshot.mockResolvedValue({
      hosts: [systemAgentHost, otherHost],
      secureStorageAvailable: true
    })
    getRemoteEnvironment.mockImplementation(
      async (requestedHostId) => ({
        ...remoteEnvironment,
        hostId: requestedHostId
      })
    )
    inspectDraftHostKey.mockResolvedValue({
      candidateId,
      hostId,
      state: 'verified',
      algorithm: 'ssh-ed25519',
      fingerprintSha256: fingerprint
    })
    validateAndSave.mockResolvedValue({
      ...validationResult,
      host: updatedHost
    })
    const onHostUpdated = vi.fn()
    render(
      <SshHostsSettingsSection onHostUpdated={onHostUpdated} />
    )

    await screen.findByRole('button', {
      name: '编辑 Build host'
    })
    expect(getRemoteEnvironment).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', {
        name: '编辑 Build host'
      })
    )
    fireEvent.change(screen.getByLabelText('主机地址'), {
      target: { value: '10.7.0.23' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '检查 Host Key' })
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: '确认身份并继续'
      })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '验证并保存' })
    )

    await waitFor(() =>
      expect(validateAndSave).toHaveBeenCalledWith({
        candidateId,
        fingerprintSha256: fingerprint,
        input: {
          name: 'Build host',
          hostname: '10.7.0.23',
          port: 22,
          username: 'builder',
          authentication: 'system-agent',
          password: { action: 'clear' }
        }
      })
    )
    expect(onHostUpdated).toHaveBeenCalledOnce()
    expect(onHostUpdated).toHaveBeenCalledWith(hostId)
    await waitFor(() =>
      expect(getRemoteEnvironment).toHaveBeenCalledOnce()
    )
    expect(getRemoteEnvironment).toHaveBeenCalledWith(hostId)
  })

  it('restores focus to the add trigger after Escape closes the dialog', async () => {
    render(<SshHostsSettingsSection />)

    await screen.findByText('尚未配置 SSH 主机')
    const addButton = screen.getAllByRole('button', {
      name: '添加主机'
    })[0]!
    addButton.focus()
    fireEvent.click(addButton)
    const dialog = screen.getByRole('dialog', {
      name: '添加并验证 SSH 主机'
    })
    expect(screen.getByLabelText('主机名称')).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(addButton).toHaveFocus()
  })

  it('traps Tab focus inside the guided dialog', async () => {
    render(<SshHostsSettingsSection />)

    await screen.findByText('尚未配置 SSH 主机')
    openNewHostDialog()
    const closeButton = screen.getByRole('button', {
      name: '关闭 SSH 主机验证'
    })
    const inspectButton = screen.getByRole('button', {
      name: '检查 Host Key'
    })
    inspectButton.focus()
    fireEvent.keyDown(inspectButton, { key: 'Tab' })
    expect(closeButton).toHaveFocus()

    fireEvent.keyDown(closeButton, {
      key: 'Tab',
      shiftKey: true
    })
    expect(inspectButton).toHaveFocus()
  })

  it('lists and locally removes related projects with a deleted Host', async () => {
    const remoteProject: AssistantProject = {
      id: '00000000-0000-4000-8000-000000000106',
      name: '无法连接的远程项目',
      description: '',
      rootPath: '/srv/missing',
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/missing'
      },
      defaultWorkMode: 'ask',
      runtimeSelection: { provider: 'opencode' },
      kind: 'user',
      status: 'active',
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z'
    }
    getSnapshot.mockResolvedValue({
      ...verifiedSnapshot,
      projectReferences: {
        [hostId]: [
          { id: remoteProject.id, name: remoteProject.name }
        ]
      }
    })
    remove.mockResolvedValue({
      hostId,
      deletedProjects: [
        { id: remoteProject.id, name: remoteProject.name }
      ]
    })
    const onProjectsDeleted = vi.fn()
    render(
      <SshHostsSettingsSection
        onProjectsDeleted={onProjectsDeleted}
      />
    )
    const host = await screen.findByRole('region', {
      name: 'Build host'
    })

    fireEvent.click(
      within(host).getByRole('button', { name: '删除' })
    )
    const confirmation = screen.getByRole('alertdialog')
    expect(
      within(confirmation).getByText('同时删除以下关联项目记录：')
    ).toBeInTheDocument()
    expect(
      within(confirmation).getByText(remoteProject.name)
    ).toBeInTheDocument()
    expect(confirmation).toHaveTextContent(
      '不会连接主机，也不会删除远端目录或内容'
    )
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: '确认删除'
      })
    )

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(hostId)
    )
    expect(onProjectsDeleted).toHaveBeenCalledWith([
      remoteProject.id
    ])
    expect(
      screen.queryByRole('region', { name: 'Build host' })
    ).not.toBeInTheDocument()
    expect(getRemoteEnvironment).not.toHaveBeenCalled()
  })

  it('offers existing unverified hosts a validate action', async () => {
    getSnapshot.mockResolvedValue({
      hosts: [legacyUnverifiedHost],
      secureStorageAvailable: true
    })
    render(<SshHostsSettingsSection />)

    expect(
      await screen.findByRole('button', {
        name: '验证 Build host'
      })
    ).toHaveTextContent('验证并保存')
    expect(screen.getByText('需要重新验证')).toBeInTheDocument()
    expect(getRemoteEnvironment).not.toHaveBeenCalled()
  })

  it('shows installed and expected Agent and Runtime versions in a balanced grid', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    render(<SshHostsSettingsSection />)

    expect(
      await screen.findByText('远程运行环境')
    ).toBeInTheDocument()
    expect(getRemoteEnvironment).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        '尚未检查版本。本页面不会自动连接主机；点击“刷新版本”可检查版本。'
      )
    ).toBeInTheDocument()
    const host = await refreshHostEnvironment()
    expect(getRemoteEnvironment).toHaveBeenCalledWith(hostId)
    expect(getRemoteEnvironment).toHaveBeenCalledTimes(1)
    expect(
      within(host).queryByText(
        '尚未检查版本。本页面不会自动连接主机；点击“刷新版本”可检查版本。'
      )
    ).not.toBeInTheDocument()
    expect(
      within(host).getByText('GoodBuddy Agent')
    ).toBeInTheDocument()
    expect(
      within(host).getByText('OpenCode Runtime')
    ).toBeInTheDocument()
    expect(within(host).getByText('待更新')).toBeInTheDocument()
    expect(within(host).getByText('版本匹配')).toBeInTheDocument()
    expect(within(host).getByText('0.10.4')).toBeInTheDocument()
    expect(within(host).getByText('0.11.1')).toBeInTheDocument()
    expect(within(host).getAllByText('1.18.9')).toHaveLength(2)
    expect(within(host).getByText('安装方式')).toBeInTheDocument()
    expect(
      within(host)
        .getByRole('button', {
          name: '刷新 Build host 的远程运行环境版本'
        })
        .closest('.ssh-host-environment__header')
    ).not.toBeNull()
    expect(
      within(host)
        .getByRole('button', {
          name: '为 Build host 更新远程环境'
        })
        .closest('.ssh-host-environment__toolbar')
    ).not.toBeNull()
  })

  it('does not contact any verified Host when the section opens', async () => {
    getSnapshot.mockResolvedValue({
      hosts: [
        verifiedHost,
        {
          ...verifiedHost,
          id: candidateId,
          name: 'Deploy host',
          hostname: 'deploy.example.com'
        }
      ],
      secureStorageAvailable: true
    })
    render(<SshHostsSettingsSection />)

    await screen.findByRole('region', { name: 'Deploy host' })
    expect(getRemoteEnvironment).not.toHaveBeenCalled()
    expect(
      screen.getAllByText(
        '尚未检查版本。本页面不会自动连接主机；点击“刷新版本”可检查版本。'
      )
    ).toHaveLength(2)

    await refreshHostEnvironment()
    expect(getRemoteEnvironment).toHaveBeenCalledTimes(1)
    expect(getRemoteEnvironment).toHaveBeenCalledWith(hostId)
  })

  it('keeps Host details visible and retries a failed version refresh', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    getRemoteEnvironment
      .mockRejectedValueOnce(new Error('Host unreachable'))
      .mockResolvedValueOnce(remoteEnvironment)
    render(<SshHostsSettingsSection />)

    await screen.findByText(
      '尚未检查版本。本页面不会自动连接主机；点击“刷新版本”可检查版本。'
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '刷新 Build host 的远程运行环境版本'
      })
    )
    expect(
      await screen.findByText('Host unreachable')
    ).toBeInTheDocument()
    expect(screen.getByText('Build host')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: '刷新 Build host 的远程运行环境版本'
      })
    )
    await waitFor(() =>
      expect(getRemoteEnvironment).toHaveBeenCalledTimes(2)
    )
    expect(await screen.findByText('GoodBuddy Agent')).toBeInTheDocument()
  })

  it.each([
    [notInstalledRemoteEnvironment, '为 Build host 安装远程环境'],
    [remoteEnvironment, '为 Build host 更新远程环境'],
    [currentRemoteEnvironment, '为 Build host 重新安装远程环境']
  ])('names the single main environment action from version facts', async (
    environment,
    actionName
  ) => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    getRemoteEnvironment.mockResolvedValue(environment)
    render(<SshHostsSettingsSection />)

    const host = await refreshHostEnvironment()
    expect(
      within(host).getByRole('button', { name: actionName })
    ).toBeEnabled()
    expect(
      within(host).getAllByRole('button', {
        name: /为 Build host (?:安装|更新|重新安装)远程环境/u
      })
    ).toHaveLength(1)
  })

  it('defaults to auto, supports arrow-key selection, and requests all three methods', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    render(<SshHostsSettingsSection />)

    const host = await refreshHostEnvironment()
    let automatic = within(host).getByRole('button', {
      name: '自动'
    })
    let hostDownload: HTMLElement
    let mainAction = within(host).getByRole('button', {
      name: '为 Build host 更新远程环境'
    })

    expect(automatic).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(mainAction)
    await waitFor(() =>
      expect(updateRemoteEnvironment).toHaveBeenLastCalledWith({
        hostId,
        method: 'auto'
      })
    )
    await waitFor(() =>
      expect(
        within(host).getByRole('button', { name: '自动' })
      ).toBeEnabled()
    )
    automatic = within(host).getByRole('button', { name: '自动' })
    hostDownload = within(host).getByRole('button', {
      name: 'Host 下载'
    })
    mainAction = within(host).getByRole('button', {
      name: '为 Build host 更新远程环境'
    })

    automatic.focus()
    fireEvent.keyDown(automatic, { key: 'ArrowRight' })
    expect(hostDownload).toHaveFocus()
    expect(hostDownload).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(mainAction)
    await waitFor(() =>
      expect(updateRemoteEnvironment).toHaveBeenLastCalledWith({
        hostId,
        method: 'remote-download'
      })
    )
    await waitFor(() =>
      expect(
        within(host).getByRole('button', { name: 'Host 下载' })
      ).toBeEnabled()
    )
    hostDownload = within(host).getByRole('button', {
      name: 'Host 下载'
    })
    const goodbuddyTransfer = within(host).getByRole('button', {
      name: 'GoodBuddy 传输'
    })
    mainAction = within(host).getByRole('button', {
      name: '为 Build host 更新远程环境'
    })

    fireEvent.keyDown(hostDownload, { key: 'ArrowRight' })
    expect(goodbuddyTransfer).toHaveFocus()
    expect(goodbuddyTransfer).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(mainAction)
    await waitFor(() =>
      expect(updateRemoteEnvironment).toHaveBeenLastCalledWith({
        hostId,
        method: 'goodbuddy-transfer'
      })
    )
    expect(updateRemoteEnvironment).toHaveBeenCalledTimes(3)
  })

  it('disables only an explicitly unavailable Host download method', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    getRemoteEnvironment.mockResolvedValue({
      ...remoteEnvironment,
      remoteDownload: {
        available: false,
        source: 'mirror',
        packageSize: 64 * 1024 * 1024,
        reason: 'source-unreachable'
      }
    })
    render(<SshHostsSettingsSection />)

    const host = await refreshHostEnvironment()
    const mainAction = within(host).getByRole('button', {
      name: '为 Build host 更新远程环境'
    })
    expect(mainAction).toBeEnabled()

    fireEvent.click(
      within(host).getByRole('button', { name: 'Host 下载' })
    )
    expect(mainAction).toBeDisabled()
    fireEvent.click(
      within(host).getByRole('button', {
        name: 'GoodBuddy 传输'
      })
    )
    expect(mainAction).toBeEnabled()
    expect(host).toHaveTextContent(
      '远程主机无法连接所选下载源（镜像节点）'
    )
  })

  it('allows a direct retry when its capability check fails', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    getRemoteEnvironment.mockResolvedValue({
      ...currentRemoteEnvironment,
      remoteDownload: {
        available: false,
        source: 'mirror',
        packageSize: 64 * 1024 * 1024,
        reason: 'probe-failed'
      }
    })
    render(<SshHostsSettingsSection />)

    const host = await refreshHostEnvironment()
    fireEvent.click(
      within(host).getByRole('button', { name: 'Host 下载' })
    )
    const directRetry = within(host).getByRole('button', {
      name: '为 Build host 重新安装远程环境'
    })
    expect(directRetry).toBeEnabled()
    expect(host).toHaveTextContent(
      '可直接重试由远程主机安装'
    )

    fireEvent.click(directRetry)
    await waitFor(() =>
      expect(updateRemoteEnvironment).toHaveBeenCalledWith({
        hostId,
        method: 'remote-download'
      })
    )
  })

  it('does not fall back after an explicit Host-download failure', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    updateRemoteEnvironment.mockRejectedValueOnce(
      new Error('Remote source timed out')
    )
    render(<SshHostsSettingsSection />)

    const host = await refreshHostEnvironment()
    fireEvent.click(
      within(host).getByRole('button', { name: 'Host 下载' })
    )
    const directButton = within(host).getByRole('button', {
      name: '为 Build host 更新远程环境'
    })

    fireEvent.click(directButton)

    expect(updateRemoteEnvironment).toHaveBeenCalledOnce()
    expect(updateRemoteEnvironment).toHaveBeenCalledWith({
      hostId,
      method: 'remote-download'
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Remote source timed out'
    )
    expect(updateRemoteEnvironment).toHaveBeenCalledTimes(1)
  })

  it('updates with phase progress, preserves cards, refreshes, and reports success once', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    const updateOperation = deferred<void>()
    updateRemoteEnvironment.mockReturnValue(updateOperation.promise)
    const onHostUpdated = vi.fn()
    const onNotify = vi.fn()
    render(
      <SshHostsSettingsSection
        onHostUpdated={onHostUpdated}
        onNotify={onNotify}
      />
    )

    const host = await refreshHostEnvironment()
    fireEvent.click(
      within(host).getByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    )

    expect(updateRemoteEnvironment).toHaveBeenCalledOnce()
    expect(updateRemoteEnvironment).toHaveBeenCalledWith({
      hostId,
      method: 'auto'
    })
    expect(within(host).getByText('GoodBuddy Agent')).toBeInTheDocument()
    expect(within(host).getByText('OpenCode Runtime')).toBeInTheDocument()
    expect(
      within(host).getByRole('button', {
        name: '刷新 Build host 的远程运行环境版本'
      })
    ).toBeDisabled()
    expect(
      within(host).queryByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    ).not.toBeInTheDocument()
    expect(
      within(host).queryByRole('button', { name: '自动' })
    ).not.toBeInTheDocument()
    expect(within(host).getByRole('status')).toHaveTextContent('自动')
    expect(within(host).getByRole('status')).toHaveTextContent(
      '正在准备安装'
    )

    act(() => {
      remoteEnvironmentUpdateProgressListener?.({
        hostId: candidateId,
        method: 'goodbuddy-transfer',
        phase: 'installing-agent'
      })
    })
    expect(within(host).getByRole('status')).toHaveTextContent('自动')
    act(() => {
      remoteEnvironmentUpdateProgressListener?.({
        hostId,
        method: 'remote-download',
        phase: 'downloading'
      })
    })
    expect(within(host).getByRole('status')).toHaveTextContent(
      'Host 下载'
    )
    act(() => {
      remoteEnvironmentUpdateProgressListener?.({
        hostId,
        method: 'remote-download',
        phase: 'installing-agent'
      })
    })
    expect(within(host).getByRole('status')).toHaveTextContent(
      '正在安装 GoodBuddy Agent'
    )
    act(() => {
      remoteEnvironmentUpdateProgressListener?.({
        hostId,
        method: 'remote-download',
        phase: 'installing-runtime'
      })
    })
    expect(within(host).getByRole('status')).toHaveTextContent(
      '正在安装 Runtime'
    )
    act(() => {
      remoteEnvironmentUpdateProgressListener?.({
        hostId,
        method: 'remote-download',
        phase: 'finalizing'
      })
    })
    expect(within(host).getByRole('status')).toHaveTextContent(
      '正在完成远程运行环境更新'
    )
    expect(
      within(host).getByRole('button', {
        name: '取消 Build host 的远程运行环境更新'
      })
    ).toBeDisabled()

    await act(async () => {
      updateOperation.resolve(undefined)
      await updateOperation.promise
    })
    await waitFor(() =>
      expect(getRemoteEnvironment).toHaveBeenCalledTimes(2)
    )
    await waitFor(() =>
      expect(
        within(host).queryByText('正在完成远程运行环境更新')
      ).not.toBeInTheDocument()
    )
    expect(onHostUpdated).toHaveBeenCalledOnce()
    expect(onHostUpdated).toHaveBeenCalledWith(hostId)
    expect(onNotify).toHaveBeenCalledOnce()
    expect(onNotify).toHaveBeenCalledWith({
      dedupeKey: `ssh-host-environment-updated:${hostId}`,
      message: 'SSH 主机“Build host”的远程运行环境已更新',
      tone: 'success'
    })
  })

  it('reports a successful environment update after the settings section unmounts', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    const updateOperation = deferred<void>()
    updateRemoteEnvironment.mockReturnValue(updateOperation.promise)
    const onHostUpdated = vi.fn()
    const onNotify = vi.fn()
    const { unmount } = render(
      <SshHostsSettingsSection
        onHostUpdated={onHostUpdated}
        onNotify={onNotify}
      />
    )

    await refreshHostEnvironment()
    fireEvent.click(
      screen.getByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    )
    expect(updateRemoteEnvironment).toHaveBeenCalledWith({
      hostId,
      method: 'auto'
    })

    unmount()
    await act(async () => {
      updateOperation.resolve()
      await updateOperation.promise
    })

    expect(onHostUpdated).toHaveBeenCalledOnce()
    expect(onHostUpdated).toHaveBeenCalledWith(hostId)
    expect(onNotify).toHaveBeenCalledOnce()
  })

  it('reports a failed environment update after the settings section unmounts', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    const updateOperation = deferred<void>()
    updateRemoteEnvironment.mockReturnValue(updateOperation.promise)
    const onHostUpdated = vi.fn()
    const onNotify = vi.fn()
    const { unmount } = render(
      <SshHostsSettingsSection
        onHostUpdated={onHostUpdated}
        onNotify={onNotify}
      />
    )

    await refreshHostEnvironment()
    fireEvent.click(
      screen.getByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    )
    unmount()
    await act(async () => {
      updateOperation.reject(new Error('Runtime finalization failed'))
      await updateOperation.promise.catch(() => undefined)
    })

    expect(onHostUpdated).not.toHaveBeenCalled()
    expect(onNotify).toHaveBeenCalledWith({
      dedupeKey:
        `ssh-host-environment-update-failed:${hostId}`,
      message: 'Runtime finalization failed',
      tone: 'error'
    })
  })

  it('prevents conflicting Host actions while an update is active', async () => {
    const secondHost = {
      ...verifiedHost,
      id: candidateId,
      name: 'Deploy host'
    }
    getSnapshot.mockResolvedValue({
      hosts: [verifiedHost, secondHost],
      secureStorageAvailable: true
    })
    getRemoteEnvironment.mockImplementation(async (requestedHostId) => ({
      ...remoteEnvironment,
      hostId: requestedHostId
    }))
    const updateOperation = deferred<void>()
    updateRemoteEnvironment.mockReturnValue(updateOperation.promise)
    render(<SshHostsSettingsSection />)

    const buildHost = await refreshHostEnvironment()
    const deployHost =
      await refreshHostEnvironment('Deploy host')
    expect(getRemoteEnvironment).toHaveBeenCalledTimes(2)
    fireEvent.click(
      within(buildHost).getByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    )

    expect(
      within(buildHost).getByRole('button', {
        name: '编辑 Build host'
      })
    ).toBeDisabled()
    expect(
      within(buildHost).getByRole('button', { name: '删除' })
    ).toBeDisabled()
    expect(
      within(deployHost).getByRole('button', {
        name: '为 Deploy host 更新远程环境'
      })
    ).toBeDisabled()

    await act(async () => {
      updateOperation.resolve(undefined)
      await updateOperation.promise
    })
  })

  it('keeps an update failure retryable, strips IPC prefixes, and refreshes partial state', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    getRemoteEnvironment
      .mockResolvedValueOnce(remoteEnvironment)
      .mockResolvedValue(currentRemoteEnvironment)
    updateRemoteEnvironment.mockRejectedValue(
      new Error(
        "Error invoking remote method 'ssh-hosts:update-remote-environment': AgentInstallationError: Agent deployment failed"
      )
    )
    const onHostUpdated = vi.fn()
    const onNotify = vi.fn()
    render(
      <SshHostsSettingsSection
        onHostUpdated={onHostUpdated}
        onNotify={onNotify}
      />
    )

    await refreshHostEnvironment()
    fireEvent.click(
      screen.getByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Agent deployment failed')
    expect(alert).not.toHaveTextContent('Error invoking remote method')
    expect(alert).not.toHaveTextContent('AgentInstallationError')
    await waitFor(() =>
      expect(getRemoteEnvironment).toHaveBeenCalledTimes(2)
    )
    expect(
      screen.getByRole('button', {
        name: '为 Build host 重新安装远程环境'
      })
    ).toBeEnabled()
    expect(onHostUpdated).not.toHaveBeenCalled()
    expect(onNotify).not.toHaveBeenCalled()
  })

  it('combines a matched-version reinstall failure summary with its detail in one alert', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    getRemoteEnvironment.mockResolvedValue(currentRemoteEnvironment)
    updateRemoteEnvironment.mockRejectedValue(
      new Error('Runtime finalization failed')
    )
    render(<SshHostsSettingsSection />)

    await refreshHostEnvironment()
    fireEvent.click(
      screen.getByRole('button', {
        name: '为 Build host 重新安装远程环境'
      })
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      '本次重新安装未完成；正在重新检查当前版本。'
    )
    expect(alert).toHaveTextContent('Runtime finalization failed')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('cancels an update, stays disabled while cancelling, and refreshes after settlement', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    const updateOperation = deferred<void>()
    updateRemoteEnvironment.mockReturnValue(updateOperation.promise)
    const onHostUpdated = vi.fn()
    const onNotify = vi.fn()
    render(
      <SshHostsSettingsSection
        onHostUpdated={onHostUpdated}
        onNotify={onNotify}
      />
    )

    await refreshHostEnvironment()
    fireEvent.click(
      screen.getByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    )
    const cancelButton = screen.getByRole('button', {
      name: '取消 Build host 的远程运行环境更新'
    })
    fireEvent.click(cancelButton)

    expect(cancelRemoteEnvironmentUpdate).toHaveBeenCalledOnce()
    expect(cancelRemoteEnvironmentUpdate).toHaveBeenCalledWith(hostId)
    expect(cancelButton).toBeDisabled()
    expect(cancelButton).toHaveTextContent('正在取消…')
    expect(screen.getByRole('status')).toHaveTextContent(
      '正在取消远程运行环境更新'
    )

    await act(async () => {
      updateOperation.reject(
        new Error(
          "Error invoking remote method 'ssh-hosts:update-remote-environment': Error: 更新已取消"
        )
      )
      await Promise.resolve()
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '更新已取消'
    )
    await waitFor(() =>
      expect(getRemoteEnvironment).toHaveBeenCalledTimes(2)
    )
    expect(onHostUpdated).not.toHaveBeenCalled()
    expect(onNotify).not.toHaveBeenCalled()
  })

  it('keeps a real update failure visible when it races with cancellation', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    const updateOperation = deferred<void>()
    updateRemoteEnvironment.mockReturnValue(updateOperation.promise)
    render(<SshHostsSettingsSection />)

    await refreshHostEnvironment()
    fireEvent.click(
      screen.getByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '取消 Build host 的远程运行环境更新'
      })
    )
    await act(async () => {
      updateOperation.reject(
        new Error(
          "Error invoking remote method 'ssh-hosts:update-remote-environment': AgentInstallationError: Agent deployment failed"
        )
      )
      await Promise.resolve()
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Agent deployment failed'
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      '更新已取消'
    )
  })

  it('allows cancellation to be retried when the cancel request fails', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    const updateOperation = deferred<void>()
    updateRemoteEnvironment.mockReturnValue(updateOperation.promise)
    cancelRemoteEnvironmentUpdate.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'ssh-hosts:cancel-update': Error: Cancel request failed"
      )
    )
    render(<SshHostsSettingsSection />)

    await refreshHostEnvironment()
    fireEvent.click(
      screen.getByRole('button', {
        name: '为 Build host 更新远程环境'
      })
    )
    const cancelButton = screen.getByRole('button', {
      name: '取消 Build host 的远程运行环境更新'
    })
    fireEvent.click(cancelButton)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cancel request failed'
    )
    await waitFor(() => expect(cancelButton).toBeEnabled())
    expect(cancelButton).toHaveTextContent('取消更新')

    await act(async () => {
      updateOperation.resolve(undefined)
      await updateOperation.promise
    })
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    )
  })

  it('subscribes to update progress once and unsubscribes on unmount', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    const { unmount } = render(<SshHostsSettingsSection />)

    expect(onRemoteEnvironmentUpdateProgress).toHaveBeenCalledOnce()
    unmount()
    expect(unsubscribeRemoteEnvironmentUpdateProgress).toHaveBeenCalledOnce()
  })
})
