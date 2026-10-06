// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeClientCoordinator } from './native-client-coordinator'
import { NativeDshWebClientService, type NativeDshWebClientOptions } from './native-dsh-web-client'
import { NativeTerminalClient } from './native-terminal-client'
import { join } from 'node:path'
import type { LocalToolRuntimeSelection } from '../../shared/local-tool-environment-contracts'

const coordinators: NativeClientCoordinator[] = []
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map(coordinator => coordinator.dispose()))
  vi.restoreAllMocks()
})

function fixture(whenReady: () => Promise<void> = async () => undefined) {
  const profile = { id: '11111111-1111-4111-8111-111111111111', name: 'Selected', protocol: 'openai-chat-completions',
    authentication: 'api-key', apiKey: 'secret', baseUrl: 'https://example.com/v1', modelName: 'selected-model' }
  const settings = { provider: 'deepseek-harness', modelProfiles: [profile], deepseekHarnessModelProfile: profile }
  const conversation = { projectId: 'project', knowledgeLibraryIds: ['library'], storyGraphEnabled: true }
  const project = { id: 'project', runtimeSelection: { provider: 'deepseek-harness', model: { kind: 'profile', profileId: profile.id } } }
  const application = { heartbeatEnabled: false, magicNotesEnabled: true, localToolEnvironment: { node: { source: 'managed' } as LocalToolRuntimeSelection } }
  const gateway = { start: vi.fn(), dispose: vi.fn(), grant: vi.fn(() => 'builtin-token'),
    grantCustomMcp: vi.fn(() => 'custom-token'), getEndpoint: () => 'http://127.0.0.1:1234/mcp',
    getAvailableToolNames: vi.fn(() => ['knowledge_search', 'obsidian_read_note']) }
  const handles = new Map<string, { id: string; url: string }>()
  const start = vi.spyOn(NativeDshWebClientService.prototype, 'start').mockImplementation(async () => {
    const handle = { id: `service-${handles.size}`, url: 'http://127.0.0.1:1234/?token=private' }
    handles.set(handle.id, handle)
    return handle
  })
  vi.spyOn(NativeDshWebClientService.prototype, 'get').mockImplementation(async id => handles.get(id) ?? null)
  const stop = vi.spyOn(NativeDshWebClientService.prototype, 'stop').mockImplementation(async id => { handles.delete(id) })
  const openExternal = vi.fn(async () => {})
  const coordinator = new NativeClientCoordinator({
    database: { getConversation: async (id: string) => ({ ...conversation, id }), getProject: async () => project },
    settingsStore: { getResolvedSettings: async () => settings },
    applicationSettingsStore: { get: async () => application },
    capabilities: { getRuntimeSkillContext: async () => ({ packages: [{ directory: '/skills/test', id: 'test', digest: 'one' }] }),
      getResolvedMcpServers: async () => [{ id: 'custom' }], getEnabledBuiltinMcpServerIds: async () => ['knowledge-base', 'obsidian', 'goodbuddy-config', 'story-graph'],
      getObsidianSettings: async () => ({}) },
    executionSpaceResolver: { resolveProject: () => ({ kind: 'local', rootPath: '/workspace', cacheIdentity: '/workspace' }) },
    terminalManager: { closeOwner: vi.fn() }, localEnvironment: { launchEnvironmentProvider: () => process.env, whenReady },
    rootDirectory: '/clients', temporaryRoot: '/runtime-launch', createGateway: () => gateway, openExternal
  } as unknown as ConstructorParameters<typeof NativeClientCoordinator>[0])
  coordinators.push(coordinator)
  return { coordinator, profile, project, conversation, application, gateway, start, stop, openExternal }
}

describe('native client coordinator', () => {
  it('forwards the same temporary root to browser and terminal clients without moving retained roots', async () => {
    const { coordinator, project, start } = fixture()
    let browserOptions: NativeDshWebClientOptions | undefined
    start.mockImplementation(async function (this: NativeDshWebClientService) {
      browserOptions = (this as unknown as { options: NativeDshWebClientOptions }).options
      return { id: 'browser', url: 'http://127.0.0.1:1234/' }
    })
    await coordinator.open(1, 'browser-conversation')
    expect(browserOptions).toMatchObject({
      temporaryRoot: '/runtime-launch', rootDirectory: join('/clients', 'dsh')
    })
    let terminalOptions: ConstructorParameters<typeof NativeTerminalClient>[0] | undefined
    const terminalOpen = vi.spyOn(NativeTerminalClient.prototype, 'open').mockImplementation(async function (this: NativeTerminalClient) {
      terminalOptions = (this as unknown as { options: ConstructorParameters<typeof NativeTerminalClient>[0] }).options
      return { sessionId: 'terminal', state: 'running' } as Awaited<ReturnType<NativeTerminalClient['open']>>
    })
    project.runtimeSelection.provider = 'opencode'
    await coordinator.open(1, 'terminal-conversation')
    expect(terminalOpen).toHaveBeenCalledOnce()
    expect(terminalOptions).toMatchObject({
      temporaryRoot: '/runtime-launch', rootDirectory: join('/clients', 'terminal')
    })
  })

  it('binds story graph to its conversation and does not reuse another conversation or disabled configuration', async () => {
    const { coordinator, conversation, application, gateway } = fixture()
    application.heartbeatEnabled = true
    await coordinator.open(1, 'first')
    expect(gateway.grant.mock.calls.at(-1)?.at(-1)).toEqual({ projectId: 'project', conversationId: 'first', runtimeTarget: 'deepseek-harness' })
    expect(await coordinator.get(1, 'second')).toBeNull()
    conversation.storyGraphEnabled = false
    expect(await coordinator.get(1, 'first')).toBeNull()
    await coordinator.open(1, 'first')
    expect(gateway.grant.mock.calls.at(-1)?.at(-1)).toBeUndefined()
  })
  it('waits for the startup tool environment before launching a native client', async () => {
    let ready!: () => void
    const { coordinator, start } = fixture(() => new Promise<void>(resolve => { ready = resolve }))
    const opened = coordinator.open(1, 'conversation')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(start).not.toHaveBeenCalled()
    ready()
    await expect(opened).resolves.toEqual({ kind: 'browser', serviceId: 'service-0' })
    expect(start).toHaveBeenCalledOnce()
  })
  it('retains a ready service and its gateway after browser failure, then reopens and stops it', async () => {
    const { coordinator, gateway, start, stop, openExternal } = fixture()
    openExternal.mockRejectedValueOnce(new Error('Browser unavailable'))
    await expect(coordinator.open(1, 'conversation')).rejects.toThrow('Browser unavailable')
    expect(await coordinator.get(1, 'conversation')).toEqual({ serviceId: 'service-0' })
    expect(gateway.dispose).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    await expect(coordinator.open(1, 'conversation')).resolves.toEqual({ kind: 'browser', serviceId: 'service-0' })
    expect(start).toHaveBeenCalledOnce()
    await coordinator.stop(2, 'service-0')
    expect(stop).not.toHaveBeenCalled()
    await coordinator.stop(1, 'service-0')
    expect(gateway.dispose).toHaveBeenCalledOnce()
    expect(await coordinator.get(1, 'conversation')).toBeNull()
  })

  it('matches get and reuse against current credentials and Node selection', async () => {
    const { coordinator, profile, application, start } = fixture()
    await Promise.all([coordinator.open(1, 'conversation'), coordinator.open(1, 'conversation')])
    expect(start).toHaveBeenCalledOnce()
    profile.apiKey = 'rotated'
    expect(await coordinator.get(1, 'conversation')).toBeNull()
    await coordinator.open(1, 'conversation')
    expect(start.mock.calls[1]![0].profile.apiKey).toBe('rotated')
    expect(start.mock.calls[1]![0].configurationKey).not.toBe(start.mock.calls[0]![0].configurationKey)
    expect(await coordinator.get(1, 'conversation')).toEqual({ serviceId: 'service-1' })
    application.localToolEnvironment.node = { source: 'custom', executablePath: '/new/node' }
    expect(await coordinator.get(1, 'conversation')).toBeNull()
    expect(await coordinator.get(2, 'conversation')).toBeNull()
  })

  it('grants enabled writes and custom MCP without a mode or read whitelist', async () => {
    const { coordinator, gateway, start } = fixture()
    await coordinator.open(1, 'conversation')
    expect(start.mock.calls[0]![0]).toMatchObject({ skillDirectories: ['/skills/test'], mcpServers: [
      { serverName: 'goodbuddy-0' }, { serverName: 'goodbuddy-1' }
    ] })
    expect(gateway.grantCustomMcp).toHaveBeenCalledOnce()
    expect(gateway.grant).toHaveBeenLastCalledWith(
      expect.any(String), ['library'], expect.any(AbortSignal), 'none',
      { access: 'write', workspacePath: '/workspace' },
      undefined, undefined, undefined, { settings: {}, access: 'write' }, undefined
    )
    expect(start.mock.calls[0]![0].mcpServers).toHaveLength(2)
    expect(gateway.getAvailableToolNames).not.toHaveBeenCalled()
    await coordinator.closeOwner(1)
    await expect(coordinator.open(1, 'conversation')).rejects.toThrow('closed')
  })

  it('releases the gateway after startup failure and allows retry', async () => {
    const { coordinator, start, gateway } = fixture()
    start.mockRejectedValueOnce(new Error('DS startup failed'))
    await expect(coordinator.open(1, 'conversation')).rejects.toThrow('DS startup failed')
    expect(gateway.dispose).toHaveBeenCalledOnce()
    await expect(coordinator.open(1, 'conversation')).resolves.toMatchObject({ kind: 'browser' })
  })

  it('uses the current custom Node selection without installing a separate runtime', async () => {
    const { coordinator, application, start } = fixture()
    const resolved: string[] = []
    start.mockImplementation(async function (this: NativeDshWebClientService) {
      const options = (this as unknown as { options: NativeDshWebClientOptions }).options
      resolved.push((await options.resolveLaunchEnvironment()).nodeExecutablePath)
      return { id: `custom-${resolved.length}`, url: 'http://127.0.0.1:1234/' }
    })
    application.localToolEnvironment.node = { source: 'custom', executablePath: '/selected/node' }
    await coordinator.open(1, 'conversation')
    application.localToolEnvironment.node = { source: 'custom', executablePath: '/changed/node' }
    await coordinator.open(1, 'conversation')
    expect(resolved).toEqual(['/selected/node', '/changed/node'])
  })
})
