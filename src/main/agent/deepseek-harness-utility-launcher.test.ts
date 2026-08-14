import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
  DEEPSEEK_HARNESS_CONTROL_VERSION,
  DEEPSEEK_HARNESS_CREDENTIAL_REF,
  createDeepSeekHarnessUtilityLauncher,
  parseHarnessControlMessage
} from './deepseek-harness-utility-launcher'

class FakeUtility extends EventEmitter {
  readonly messages: unknown[] = []
  readonly stderr = new PassThrough()
  readonly pid = 123
  killed = false

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'goodbuddy-harness-launcher-'))
  )
  const workspace = join(root, 'workspace')
  const dshHome = join(root, 'home')
  const hostPath = join(
    root,
    'deepseek-harness-host-bootstrap.js'
  )
  await Promise.all([
    mkdir(workspace),
    mkdir(dshHome),
    writeFile(hostPath, '', 'utf8')
  ])
  return {
    dshHome,
    hostPath,
    launchOptions: {
      cwd: workspace,
      signal: new AbortController().signal,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      credentialRefs: [DEEPSEEK_HARNESS_CREDENTIAL_REF],
      skillPackages: []
    }
  }
}

describe('DeepSeek Harness utility launcher', () => {
  it('accepts only strict control messages and secret-free config', () => {
    expect(
      parseHarnessControlMessage({
        protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
        version: DEEPSEEK_HARNESS_CONTROL_VERSION,
        type: 'ready'
      })
    ).toMatchObject({ type: 'ready' })
    expect(
      parseHarnessControlMessage({
        protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
        version: DEEPSEEK_HARNESS_CONTROL_VERSION,
        type: 'ready',
        apiKey: 'must-not-pass'
      })
    ).toBeUndefined()
  })

  it('waits for Host readiness and sends no credential value', async () => {
    const { dshHome, hostPath, launchOptions } = await fixture()
    const utility = new FakeUtility()
    const fork = vi.fn(() => utility as never)
    const launcher = createDeepSeekHarnessUtilityLauncher({
      bundledHostPath: hostPath,
      dshHome,
      environment: { PATH: 'C:\\Tools' },
      fork
    })

    const launching = launcher(launchOptions)
    await vi.waitFor(() =>
      expect(utility.messages).toHaveLength(1)
    )
    expect(JSON.stringify(utility.messages[0])).not.toContain(
      'secret'
    )
    expect(utility.messages[0]).toMatchObject({
      type: 'start',
      config: {
        baseUrl: 'https://api.deepseek.com',
        credentialRefs: [DEEPSEEK_HARNESS_CREDENTIAL_REF]
      }
    })
    utility.emit('message', {
      protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
      version: DEEPSEEK_HARNESS_CONTROL_VERSION,
      type: 'ready'
    })

    await expect(launching).resolves.toMatchObject({
      stdin: expect.any(WritableStream),
      stdout: expect.any(ReadableStream)
    })
    expect(fork).toHaveBeenCalledWith(
      hostPath,
      [],
      expect.objectContaining({
        cwd: launchOptions.cwd,
        stdio: ['ignore', 'ignore', 'pipe']
      })
    )
  })

  it('fails closed on an invalid Host startup message', async () => {
    const { dshHome, hostPath, launchOptions } = await fixture()
    const utility = new FakeUtility()
    const terminateProcess = vi.fn(() => {
      utility.killed = true
    })
    const launcher = createDeepSeekHarnessUtilityLauncher({
      bundledHostPath: hostPath,
      dshHome,
      environment: {},
      fork: () => utility as never,
      terminateProcess
    })

    const launching = launcher(launchOptions)
    await vi.waitFor(() =>
      expect(utility.messages).toHaveLength(1)
    )
    utility.emit('message', { type: 'ready' })

    await expect(launching).rejects.toThrow('启动协议无效')
    expect(terminateProcess).toHaveBeenCalledOnce()
  })
})
