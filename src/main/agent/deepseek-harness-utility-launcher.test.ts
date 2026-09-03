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
  parseHarnessControlMessage,
  type DeepSeekHarnessFork
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
    root,
    dshHome,
    hostPath,
    launchOptions: {
      cwd: workspace,
      signal: new AbortController().signal,
      baseUrl: 'http://gateway.example/openai/v1?api-version=1',
      model: 'qwen-plus',
      supportsImageInput: false,
      requestHeaders: { 'x-tenant-id': 'harness-tenant' },
      credentialRefs: [DEEPSEEK_HARNESS_CREDENTIAL_REF],
      skillPackages: [],
      extensionPackages: []
    }
  }
}

describe('DeepSeek Harness utility launcher', () => {
  it('accepts only strict control messages and secret-free config', () => {
    expect(DEEPSEEK_HARNESS_CONTROL_VERSION).toBe(3)
    expect(
      parseHarnessControlMessage({
        protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
        version: DEEPSEEK_HARNESS_CONTROL_VERSION,
        type: 'ready',
        failedExtensionIds: []
      })
    ).toMatchObject({ type: 'ready' })
    expect(
      parseHarnessControlMessage({
        protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
        version: DEEPSEEK_HARNESS_CONTROL_VERSION,
        type: 'ready',
        failedExtensionIds: [],
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
        baseUrl: 'http://gateway.example/openai/v1?api-version=1',
        model: 'qwen-plus',
        supportsImageInput: false,
        requestHeaders: {
          'x-tenant-id': 'harness-tenant'
        },
        credentialRefs: [DEEPSEEK_HARNESS_CREDENTIAL_REF]
      }
    })
    utility.emit('message', {
      protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
      version: DEEPSEEK_HARNESS_CONTROL_VERSION,
      type: 'ready',
      failedExtensionIds: []
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

  it('refreshes the filtered tool PATH for every Host root', async () => {
    const { dshHome, hostPath, launchOptions } = await fixture()
    const utilities = [new FakeUtility(), new FakeUtility()]
    const fork = vi.fn<DeepSeekHarnessFork>(
      () => utilities.shift() as never
    )
    let generation = 0
    const launcher = createDeepSeekHarnessUtilityLauncher({
      bundledHostPath: hostPath,
      dshHome,
      environment: {
        PATH: 'C:\\System'
      },
      launchEnvironmentProvider: () =>
        Object.freeze({
          PATH: `C:\\GoodBuddy\\tools-${++generation};C:\\System`,
          OPENAI_API_KEY: 'provider-secret',
          ELECTRON_RUN_AS_NODE: '1'
        }),
      fork
    })

    for (let index = 0; index < 2; index += 1) {
      const launching = launcher(launchOptions)
      await vi.waitFor(() =>
        expect(fork).toHaveBeenCalledTimes(index + 1)
      )
      const launchedUtility = (
        fork.mock.results[index]?.value
      ) as unknown as FakeUtility
      await vi.waitFor(() =>
        expect(launchedUtility.messages).toHaveLength(1)
      )
      launchedUtility.emit('message', {
        protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
        version: DEEPSEEK_HARNESS_CONTROL_VERSION,
        type: 'ready',
        failedExtensionIds: []
      })
      await launching
    }

    const environments = fork.mock.calls.map(
      (call) => call[2]?.env as NodeJS.ProcessEnv
    )
    expect(environments[0]?.PATH).toBe(
      'C:\\GoodBuddy\\tools-1;C:\\System'
    )
    expect(environments[1]?.PATH).toBe(
      'C:\\GoodBuddy\\tools-2;C:\\System'
    )
    for (const environment of environments) {
      expect(environment).not.toHaveProperty('OPENAI_API_KEY')
      expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    }
  })

  it('persists extension startup failures before exposing the child', async () => {
    const { root, dshHome, hostPath, launchOptions } =
      await fixture()
    const entrypoint = join(root, 'greet.mjs')
    await writeFile(entrypoint, 'export function apply() {}\n', 'utf8')
    const utility = new FakeUtility()
    const onExtensionStartupFailures = vi.fn(async () => undefined)
    const launcher = createDeepSeekHarnessUtilityLauncher({
      bundledHostPath: hostPath,
      dshHome,
      environment: {},
      fork: () => utility as never,
      onExtensionStartupFailures
    })

    const launching = launcher({
      ...launchOptions,
      extensionPackages: [
        {
          id: 'greet',
          entrypoint,
          configuration: {}
        }
      ]
    })
    await vi.waitFor(() =>
      expect(utility.messages).toHaveLength(1)
    )
    utility.emit('message', {
      protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
      version: DEEPSEEK_HARNESS_CONTROL_VERSION,
      type: 'ready',
      failedExtensionIds: ['greet']
    })

    await expect(launching).resolves.toBeDefined()
    expect(onExtensionStartupFailures).toHaveBeenCalledWith([
      'greet'
    ])
  })

  it('fails when the Host exits while startup failures are being persisted', async () => {
    const { dshHome, hostPath, launchOptions } = await fixture()
    const utility = new FakeUtility()
    let finishPersistence!: () => void
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve
    })
    const onExtensionStartupFailures = vi.fn(() => persistence)
    const terminateProcess = vi.fn()
    const launcher = createDeepSeekHarnessUtilityLauncher({
      bundledHostPath: hostPath,
      dshHome,
      environment: {},
      fork: () => utility as never,
      terminateProcess,
      onExtensionStartupFailures
    })

    const launching = launcher(launchOptions)
    await vi.waitFor(() =>
      expect(utility.messages).toHaveLength(1)
    )
    utility.emit('message', {
      protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
      version: DEEPSEEK_HARNESS_CONTROL_VERSION,
      type: 'ready',
      failedExtensionIds: ['greet']
    })
    await vi.waitFor(() =>
      expect(onExtensionStartupFailures).toHaveBeenCalledOnce()
    )
    utility.emit('exit', 9)

    await expect(launching).rejects.toThrow(
      'Host 启动前退出（code 9）'
    )
    expect(terminateProcess).toHaveBeenCalledOnce()
    finishPersistence()
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

  it.each([
    'file:///private/config',
    'ftp://gateway.example/v1'
  ])('rejects unsupported endpoint %s before forking', async (baseUrl) => {
    const { dshHome, hostPath, launchOptions } = await fixture()
    const fork = vi.fn()
    const launcher = createDeepSeekHarnessUtilityLauncher({
      bundledHostPath: hostPath,
      dshHome,
      environment: {},
      fork
    })

    await expect(
      launcher({ ...launchOptions, baseUrl })
    ).rejects.toThrow('HTTP 或 HTTPS')
    expect(fork).not.toHaveBeenCalled()
  })
})
