import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SshHost,
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
const remove = vi.fn()
const inspectDraftHostKey = vi.fn()
const discardCandidate = vi.fn()
const validateAndSave = vi.fn()
const getRemoteEnvironment =
  vi.fn<(hostId: string) => Promise<SshHostRemoteEnvironment>>()

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
  }]
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

describe('SshHostsSettingsSection', () => {
  beforeEach(async () => {
    await changeUiLocale('zh-CN')
    vi.clearAllMocks()
    getSnapshot.mockResolvedValue(emptySnapshot)
    remove.mockResolvedValue(undefined)
    inspectDraftHostKey.mockResolvedValue({
      candidateId,
      state: 'unverified',
      algorithm: 'ssh-ed25519',
      fingerprintSha256: fingerprint
    })
    discardCandidate.mockResolvedValue(undefined)
    validateAndSave.mockResolvedValue(validationResult)
    getRemoteEnvironment.mockResolvedValue(remoteEnvironment)
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        sshHosts: {
          getSnapshot,
          remove,
          inspectDraftHostKey,
          discardCandidate,
          validateAndSave,
          getRemoteEnvironment
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

    await waitFor(() =>
      expect(getRemoteEnvironment).toHaveBeenCalledTimes(2)
    )
    getRemoteEnvironment.mockClear()
    fireEvent.click(
      await screen.findByRole('button', {
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
    await waitFor(() =>
      expect(getRemoteEnvironment).toHaveBeenCalledWith(hostId)
    )
    const host = screen.getByRole('region', { name: 'Build host' })
    expect(within(host).getByText('GoodBuddy Agent')).toBeInTheDocument()
    expect(within(host).getByText('OpenCode Runtime')).toBeInTheDocument()
    expect(within(host).getByText('待更新')).toBeInTheDocument()
    expect(within(host).getByText('当前版本')).toBeInTheDocument()
    expect(within(host).getByText('0.10.4')).toBeInTheDocument()
    expect(within(host).getByText('0.11.1')).toBeInTheDocument()
    expect(within(host).getAllByText('1.18.9')).toHaveLength(2)
  })

  it('keeps Host details visible and retries a failed version refresh', async () => {
    getSnapshot.mockResolvedValue(verifiedSnapshot)
    getRemoteEnvironment
      .mockRejectedValueOnce(new Error('Host unreachable'))
      .mockResolvedValueOnce(remoteEnvironment)
    render(<SshHostsSettingsSection />)

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
})
