// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeClientCoordinator } from './native-client-coordinator'
import { NativeDshWebClientService, type NativeDshWebClientOptions } from './native-dsh-web-client'
import type { LocalToolRuntimeSelection } from '../../shared/local-tool-environment-contracts'

const coordinators: NativeClientCoordinator[] = []
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map(coordinator => coordinator.dispose()))
  vi.restoreAllMocks()
})

function fixture() {
  const profile = { id: 'selected', name: 'Selected', protocol: 'openai-chat-completions',
    authentication: 'api-key', apiKey: 'secret', baseUrl: 'https://example.com/v1', modelName: 'selected-model' }
  const settings = { provider: 'deepseek-harness', modelProfiles: [profile], deepseekHarnessModelProfile: profile }
  const conversation = { projectId: 'project', knowledgeLibraryIds: ['library'], workMode: 'ask' }
  const project = { id: 'project', runtimeSelection: { provider: 'deepseek-harness', profileId: profile.id } }
  const application = { magicNotesEnabled: true, localToolEnvironment: { node: { source: 'managed' } as LocalToolRuntimeSelection } }
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
    database: { getConversation: () => conversation, getProject: () => project },
    settingsStore: { getResolvedSettings: async () => settings },
    applicationSettingsStore: { get: async () => application },
    capabilities: { getRuntimeSkillContext: async () => ({ packages: [{ directory: '/skills/test', id: 'test', digest: 'one' }] }),
      getResolvedMcpServers: async () => [{ id: 'custom' }], getEnabledBuiltinMcpServerIds: async () => ['knowledge-base', 'obsidian'],
      getObsidianSettings: async () => ({}) },
    executionSpaceResolver: { resolveProject: () => ({ kind: 'local', rootPath: '/workspace', cacheIdentity: '/workspace' }) },
    terminalManager: { closeOwner: vi.fn() }, localEnvironment: { launchEnvironmentProvider: () => process.env },
    rootDirectory: '/clients', createGateway: () => gateway, openExternal
  } as unknown as ConstructorParameters<typeof NativeClientCoordinator>[0])
  coordinators.push(coordinator)
  return { coordinator, profile, conversation, application, gateway, start, stop, openExternal }
}

describe('native client coordinator', () => {
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

  it('matches get and reuse against current credentials, mode and Node selection', async () => {
    const { coordinator, profile, conversation, application, start } = fixture()
    await Promise.all([coordinator.open(1, 'conversation'), coordinator.open(1, 'conversation')])
    expect(start).toHaveBeenCalledOnce()
    profile.apiKey = 'rotated'
    expect(await coordinator.get(1, 'conversation')).toBeNull()
    await coordinator.open(1, 'conversation')
    expect(start.mock.calls[1]![0].profile.apiKey).toBe('rotated')
    expect(start.mock.calls[1]![0].configurationKey).not.toBe(start.mock.calls[0]![0].configurationKey)
    conversation.workMode = 'execute'
    expect(await coordinator.get(1, 'conversation')).toBeNull()
    conversation.workMode = 'ask'
    expect(await coordinator.get(1, 'conversation')).toEqual({ serviceId: 'service-1' })
    application.localToolEnvironment.node = { source: 'custom', executablePath: '/new/node' }
    expect(await coordinator.get(1, 'conversation')).toBeNull()
    expect(await coordinator.get(2, 'conversation')).toBeNull()
  })

  it('maps gateway read grants in Ask and custom MCP only in Execute', async () => {
    const { coordinator, gateway, start, conversation } = fixture()
    await coordinator.open(1, 'conversation')
    expect(gateway.grantCustomMcp).not.toHaveBeenCalled()
    expect(start.mock.calls[0]![0]).toMatchObject({ skillDirectories: ['/skills/test'], mcpServers: [
      { serverName: 'goodbuddy-0', readOnlyTools: ['knowledge_search', 'obsidian_read_note'] }
    ] })
    conversation.workMode = 'execute'
    await coordinator.open(1, 'conversation')
    expect(gateway.grantCustomMcp).toHaveBeenCalledOnce()
    expect(start.mock.calls[1]![0].mcpServers).toHaveLength(2)
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
