import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CapabilityService,
  type CapabilityCipher,
  type CapabilityServiceOptions
} from './capability-service'
import {
  BrowserProfileService,
  MemoryBrowserProfileStore
} from './browser-profile-service'
import { CapabilityDiagnostics } from './capability-diagnostics'

const temporaryDirectories: string[] = []

const cipher: CapabilityCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace(/^encrypted:/u, '')
}

class FailingBrowserProfileService extends BrowserProfileService {
  failNextAddAfterSave = false
  failNextRemoveAfterSave = false

  override async addReference(
    ...args: Parameters<BrowserProfileService['addReference']>
  ): ReturnType<BrowserProfileService['addReference']> {
    const result = await super.addReference(...args)
    if (this.failNextAddAfterSave) {
      this.failNextAddAfterSave = false
      throw new Error('Injected add reference failure')
    }
    return result
  }

  override async removeReference(
    ...args: Parameters<BrowserProfileService['removeReference']>
  ): ReturnType<BrowserProfileService['removeReference']> {
    const result = await super.removeReference(...args)
    if (this.failNextRemoveAfterSave) {
      this.failNextRemoveAfterSave = false
      throw new Error('Injected remove reference failure')
    }
    return result
  }
}

async function writeSkill(
  root: string,
  id: string,
  name: string
): Promise<void> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    [
      '---',
      `id: ${id}`,
      `name: ${name}`,
      `description: ${name}的测试说明`,
      'version: 1.0.0',
      'tags:',
      '  - 测试',
      '---',
      '',
      `# ${name}`,
      '',
      '仅用于离线测试。'
    ].join('\n'),
    'utf8'
  )
}

async function createService(
  options: CapabilityServiceOptions = {
    platform: 'win32',
    architecture: 'x64',
    electronTarget: true,
    browserProfiles: new BrowserProfileService(
      new MemoryBrowserProfileStore()
    )
  }
): Promise<{
  directory: string
  filePath: string
  builtinRoot: string
  importedRoot: string
  service: CapabilityService
}> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-capabilities-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'capabilities.json')
  const builtinRoot = join(directory, 'builtin')
  const importedRoot = join(directory, 'imported')
  await writeSkill(builtinRoot, 'document-writing', '文档写作')
  return {
    directory,
    filePath,
    builtinRoot,
    importedRoot,
    service: new CapabilityService(
      filePath,
      builtinRoot,
      importedRoot,
      cipher,
      options
    )
  }
}

afterEach(async () => {
  delete process.env.GOODBUDDY_CAPABILITY_SERVICE_SECRET
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('CapabilityService', () => {
  it('memoizes concurrent loads and retries after a failed load', async () => {
    const initialStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined)
    }
    const created = await createService({
      platform: 'win32',
      architecture: 'x64',
      electronTarget: true,
      browserProfiles: new BrowserProfileService(initialStore)
    })

    await Promise.all([
      created.service.getComputerCapabilityStatus('host-browser-control'),
      created.service.getComputerCapabilityStatus('host-browser-control'),
      created.service.getComputerCapabilityStatus('host-browser-control')
    ])
    expect(initialStore.load).toHaveBeenCalledOnce()

    let profileLoads = 0
    const browserProfiles = new BrowserProfileService({
      load: vi.fn(async () => {
        profileLoads += 1
        if (profileLoads === 1) {
          throw new Error('Injected profile load failure')
        }
        return undefined
      }),
      save: vi.fn(async () => undefined)
    })
    const retrying = new CapabilityService(
      created.filePath,
      created.builtinRoot,
      created.importedRoot,
      cipher,
      {
        platform: 'win32',
        architecture: 'x64',
        electronTarget: true,
        browserProfiles
      }
    )

    await expect(
      Promise.all([
        retrying.getComputerCapabilityStatus('host-browser-control'),
        retrying.getComputerCapabilityStatus('host-browser-control')
      ])
    ).rejects.toThrow('Injected profile load failure')
    await expect(
      retrying.getComputerCapabilityStatus('host-browser-control')
    ).resolves.toEqual({ enabled: false, supported: true })
    expect(profileLoads).toBe(2)
  })

  it('reports safe enabled and supported capability status', async () => {
    const { service } = await createService()

    await expect(
      service.getComputerCapabilityStatus('host-browser-control')
    ).resolves.toEqual({ enabled: false, supported: true })

    await service.setComputerCapabilityEnabled(
      'host-browser-control',
      true
    )
    await expect(
      service.getComputerCapabilityStatus('host-browser-control')
    ).resolves.toEqual({ enabled: true, supported: true })
  })

  it('discovers built-in skills and persists enablement and assignments', async () => {
    const { filePath, builtinRoot, importedRoot, service } =
      await createService()

    await expect(service.getSnapshot()).resolves.toMatchObject({
      skills: [
        {
          id: 'document-writing',
          source: 'builtin',
          enabled: true,
          assignments: ['model', 'opencode', 'continue']
        }
      ]
    })

    await service.setSkillEnabled('document-writing', false)
    await service.setSkillAssignments('document-writing', ['model'])

    const reloaded = new CapabilityService(
      filePath,
      builtinRoot,
      importedRoot,
      cipher
    )
    await expect(reloaded.getSnapshot()).resolves.toMatchObject({
      skills: [
        {
          id: 'document-writing',
          enabled: false,
          assignments: ['model']
        }
      ]
    })
    await expect(
      reloaded.getSkillInstructions('continue', 10_000)
    ).resolves.toBe('')
    await reloaded.setSkillEnabled('document-writing', true)
    await expect(
      reloaded.getSkillInstructions('model', 10_000)
    ).resolves.toContain('仅用于离线测试')
  })

  it('imports and removes a managed SKILL.md package', async () => {
    const { directory, service } = await createService()
    const packageRoot = join(directory, 'source-skill')
    await writeSkill(packageRoot, 'meeting-helper', '会议助手')
    const source = join(packageRoot, 'meeting-helper')
    await writeFile(join(source, 'template.txt'), 'template', 'utf8')

    const imported = await service.importSkill(source)
    expect(imported.skills).toContainEqual(
      expect.objectContaining({
        id: 'meeting-helper',
        source: 'imported'
      })
    )

    const removed = await service.removeSkill('meeting-helper')
    expect(removed.skills).not.toContainEqual(
      expect.objectContaining({ id: 'meeting-helper' })
    )
    await expect(
      service.removeSkill('document-writing')
    ).rejects.toThrow('只能删除已导入')
  })

  it('encrypts remote MCP secrets and never returns them publicly', async () => {
    const { filePath, service } = await createService()
    const snapshot = await service.saveMcpServer(undefined, {
      name: 'Remote MCP',
      description: 'Remote test server',
      enabled: true,
      assignments: ['model'],
      secret: { action: 'replace', value: 'secret-token-value' },
      transport: 'http',
      url: 'https://mcp.example.com/mcp'
    })
    const server = snapshot.mcpServers[0]
    expect(server).toMatchObject({
      name: 'Remote MCP',
      transport: 'http',
      secretConfigured: true
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret-token-value')
    expect(await readFile(filePath, 'utf8')).not.toContain(
      'secret-token-value'
    )
    if (!server) {
      throw new Error('Expected saved MCP server')
    }
    await expect(
      service.getResolvedMcpServer(server.id)
    ).resolves.toMatchObject({
      secret: 'secret-token-value'
    })
  })

  it('stores stdio command and arguments as separate values', async () => {
    const { service } = await createService()
    const snapshot = await service.saveMcpServer(undefined, {
      name: 'Local MCP',
      description: '',
      enabled: true,
      assignments: ['model'],
      secret: { action: 'keep' },
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--safe']
    })

    expect(snapshot.mcpServers[0]).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--safe']
    })
  })

  it('never sends a bearer token over non-loopback HTTP', async () => {
    const { service } = await createService()
    await expect(
      service.saveMcpServer(undefined, {
        name: 'Unsafe remote',
        description: '',
        enabled: true,
        assignments: ['model'],
        secret: { action: 'replace', value: 'secret-token-value' },
        transport: 'http',
        url: 'http://mcp.example.com/mcp'
      })
    ).rejects.toThrow('只能通过 HTTPS')
  })

  it('rejects MCP assignments to Agent Runtimes', async () => {
    const { service } = await createService()

    await expect(
      service.saveMcpServer(undefined, {
        name: 'Agent MCP',
        description: '',
        enabled: true,
        assignments: ['opencode'],
        secret: { action: 'keep' },
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      })
    ).rejects.toThrow('只能分配给直连模型')
  })

  it('migrates legacy OpenCode MCP assignments to the direct model', async () => {
    const { filePath, builtinRoot, importedRoot } = await createService()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        skills: {},
        mcpServers: [
          {
            id: 'd2ef774b-146c-4467-a909-6feb112a9c2c',
            name: 'Legacy MCP',
            description: '',
            enabled: true,
            assignments: ['opencode'],
            transport: 'stdio',
            command: 'node',
            args: ['server.js']
          }
        ]
      }),
      'utf8'
    )
    const service = new CapabilityService(
      filePath,
      builtinRoot,
      importedRoot,
      cipher
    )

    await expect(service.getSnapshot()).resolves.toMatchObject({
      mcpServers: [
        expect.objectContaining({ assignments: ['model'] })
      ]
    })
    expect(await readFile(filePath, 'utf8')).toContain(
      '"assignments": [\n        "model"'
    )
    await expect(service.getResolvedMcpServers('opencode')).resolves.toEqual([])
    await expect(service.getResolvedMcpServers('model')).resolves.toHaveLength(1)
  })

  it('migrates v1 to v2 without losing skills, MCP configuration, or encrypted secrets', async () => {
    const { filePath, builtinRoot, importedRoot } = await createService()
    const credential = Buffer.from(
      'encrypted:{"version":1,"serverId":"d2ef774b-146c-4467-a909-6feb112a9c2c","secret":"preserved-secret"}'
    ).toString('base64')
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        skills: {
          'document-writing': {
            enabled: false,
            assignments: ['model']
          }
        },
        mcpServers: [
          {
            id: 'd2ef774b-146c-4467-a909-6feb112a9c2c',
            name: 'Preserved MCP',
            description: 'migration',
            enabled: true,
            assignments: ['model'],
            credential: {
              formatVersion: 1,
              scheme: 'electron-safe-storage',
              ciphertextBase64: credential
            },
            transport: 'http',
            url: 'https://mcp.example.com/mcp'
          }
        ]
      }),
      'utf8'
    )
    const service = new CapabilityService(
      filePath,
      builtinRoot,
      importedRoot,
      cipher,
      {
        platform: 'win32',
        architecture: 'x64',
        electronTarget: true,
        browserProfiles: new BrowserProfileService(
          new MemoryBrowserProfileStore()
        )
      }
    )

    await expect(service.getSnapshot()).resolves.toMatchObject({
      skills: [
        expect.objectContaining({
          id: 'document-writing',
          enabled: false,
          assignments: ['model']
        })
      ],
      mcpServers: [
        expect.objectContaining({
          name: 'Preserved MCP',
          secretConfigured: true
        })
      ],
      computerCapabilities: [
        expect.objectContaining({
          id: 'host-browser-control',
          enabled: false
        }),
        expect.objectContaining({
          id: 'linux-desktop-control',
          enabled: false
        })
      ]
    })
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).toContain('"version": 2')
    expect(persisted).toContain(credential)
    expect(persisted).not.toContain('preserved-secret')
  })

  it('gates enablement on the supported platform and architecture', async () => {
    const { service } = await createService({
      platform: 'darwin',
      architecture: 'arm64',
      electronTarget: true,
      browserProfiles: new BrowserProfileService(
        new MemoryBrowserProfileStore()
      )
    })

    await expect(
      service.setComputerCapabilityEnabled(
        'linux-desktop-control',
        true
      )
    ).rejects.toThrow('不支持')
    const snapshot = await service.setComputerCapabilityEnabled(
      'host-browser-control',
      true
    )
    expect(snapshot.computerCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'host-browser-control',
          enabled: true
        })
      ])
    )
  })

  it('maintains browser profile references and rejects unknown profiles', async () => {
    const { service } = await createService()
    await expect(
      service.setComputerCapabilityBrowserProfile(
        'host-browser-control',
        'b7f29e4c-1c4a-4aa0-ac58-5165451dde07'
      )
    ).rejects.toThrow('不存在')

    const created = await service.createBrowserProfile('隔离工作配置')
    const profileId = created.browserProfiles?.profiles[0]?.id
    if (!profileId) {
      throw new Error('Expected browser profile')
    }
    await service.setComputerCapabilityBrowserProfile(
      'host-browser-control',
      profileId
    )
    await expect(service.removeBrowserProfile(profileId)).rejects.toThrow(
      'Referenced'
    )
    await service.setComputerCapabilityBrowserProfile(
      'host-browser-control',
      null
    )
    await expect(service.removeBrowserProfile(profileId)).resolves.toMatchObject(
      {
        browserProfiles: { profiles: [], defaultProfileId: null }
      }
    )
  })

  it('compensates browser profile references when add or capability persistence fails', async () => {
    const addProfiles = new FailingBrowserProfileService(
      new MemoryBrowserProfileStore()
    )
    const addCase = await createService({
      platform: 'win32',
      architecture: 'x64',
      electronTarget: true,
      browserProfiles: addProfiles
    })
    const addCreated = await addCase.service.createBrowserProfile(
      '添加失败配置'
    )
    const addProfileId = addCreated.browserProfiles?.profiles[0]?.id
    if (!addProfileId) {
      throw new Error('Expected add-failure browser profile')
    }
    addProfiles.failNextAddAfterSave = true

    await expect(
      addCase.service.setComputerCapabilityBrowserProfile(
        'host-browser-control',
        addProfileId
      )
    ).rejects.toThrow('Injected add reference failure')
    await expect(
      addCase.service.removeBrowserProfile(addProfileId)
    ).resolves.toMatchObject({
      browserProfiles: { profiles: [], defaultProfileId: null }
    })

    const persistProfiles = new BrowserProfileService(
      new MemoryBrowserProfileStore()
    )
    const persistCase = await createService({
      platform: 'win32',
      architecture: 'x64',
      electronTarget: true,
      browserProfiles: persistProfiles
    })
    const persistCreated =
      await persistCase.service.createBrowserProfile('保存失败配置')
    const persistProfileId =
      persistCreated.browserProfiles?.profiles[0]?.id
    if (!persistProfileId) {
      throw new Error('Expected persistence-failure browser profile')
    }
    await mkdir(persistCase.filePath)

    await expect(
      persistCase.service.setComputerCapabilityBrowserProfile(
        'host-browser-control',
        persistProfileId
      )
    ).rejects.toThrow()
    await expect(
      persistCase.service.removeBrowserProfile(persistProfileId)
    ).resolves.toMatchObject({
      browserProfiles: { profiles: [], defaultProfileId: null }
    })
  })

  it('rolls back capability and profile stores when old-reference removal fails', async () => {
    const browserProfiles = new FailingBrowserProfileService(
      new MemoryBrowserProfileStore()
    )
    const { service } = await createService({
      platform: 'win32',
      architecture: 'x64',
      electronTarget: true,
      browserProfiles
    })
    const first = await service.createBrowserProfile('原配置')
    const firstId = first.browserProfiles?.profiles[0]?.id
    const second = await service.createBrowserProfile('新配置')
    const secondId = second.browserProfiles?.profiles[1]?.id
    if (!firstId || !secondId) {
      throw new Error('Expected two browser profiles')
    }
    await service.setComputerCapabilityBrowserProfile(
      'host-browser-control',
      firstId
    )
    browserProfiles.failNextRemoveAfterSave = true

    await expect(
      service.setComputerCapabilityBrowserProfile(
        'host-browser-control',
        secondId
      )
    ).rejects.toThrow('Injected remove reference failure')
    await expect(service.getSnapshot()).resolves.toMatchObject({
      computerCapabilities: expect.arrayContaining([
        expect.objectContaining({
          id: 'host-browser-control',
          browserProfileId: firstId
        })
      ])
    })
    await expect(service.removeBrowserProfile(secondId)).resolves.toBeDefined()
    await expect(service.removeBrowserProfile(firstId)).rejects.toThrow(
      'Referenced'
    )
  })

  it('redacts injected diagnostics and never claims browser availability outside Electron', async () => {
    process.env.GOODBUDDY_CAPABILITY_SERVICE_SECRET =
      'service-diagnostic-secret-value'
    const diagnostics = new CapabilityDiagnostics([
      {
        id: 'browser-executable',
        run: async () => ({
          status: 'available',
          summary:
            'token=visible-token service-diagnostic-secret-value C:\\Users\\Alice\\browser'
        })
      },
      {
        id: 'managed-profile-root',
        run: async () => ({
          status: 'available',
          summary: 'managed storage ready'
        })
      }
    ])
    const { service } = await createService({
      platform: 'win32',
      architecture: 'x64',
      electronTarget: true,
      browserProfiles: new BrowserProfileService(
        new MemoryBrowserProfileStore()
      ),
      diagnostics
    })
    await service.setComputerCapabilityEnabled('host-browser-control', true)
    const report = await service.diagnoseComputerCapability(
      'host-browser-control'
    )
    expect(report.status).toBe('available')
    expect(JSON.stringify(report)).not.toContain('visible-token')
    expect(JSON.stringify(report)).not.toContain(
      'service-diagnostic-secret-value'
    )

    const outsideElectron = await createService({
      platform: 'win32',
      architecture: 'x64',
      electronTarget: false,
      browserProfiles: new BrowserProfileService(
        new MemoryBrowserProfileStore()
      ),
      diagnostics
    })
    await expect(
      outsideElectron.service.setComputerCapabilityEnabled(
        'host-browser-control',
        true
      )
    ).rejects.toThrow('诊断不可用')
    await expect(
      outsideElectron.service.getComputerCapabilityStatus(
        'host-browser-control'
      )
    ).resolves.toEqual({ enabled: false, supported: true })
    delete process.env.GOODBUDDY_CAPABILITY_SERVICE_SECRET
  })

  it('keeps Linux desktop unavailable without a registered native adapter', async () => {
    const { service } = await createService({
      platform: 'linux',
      architecture: 'x64',
      electronTarget: true,
      browserProfiles: new BrowserProfileService(
        new MemoryBrowserProfileStore()
      )
    })

    await expect(
      service.setComputerCapabilityEnabled(
        'linux-desktop-control',
        true
      )
    ).rejects.toThrow('不支持')
    await expect(
      service.getComputerCapabilityStatus('linux-desktop-control')
    ).resolves.toEqual({ enabled: false, supported: false })
  })

  it('allows Linux desktop enablement with available injected diagnostics', async () => {
    const diagnostics = new CapabilityDiagnostics(
      ['linux-session', 'desktop-driver', 'desktop-permissions'].map(
        (id) => ({
          id,
          run: async () => ({
            status: 'available' as const,
            summary: `${id} ready`
          })
        })
      )
    )
    const { service } = await createService({
      platform: 'linux',
      architecture: 'arm64',
      electronTarget: true,
      browserProfiles: new BrowserProfileService(
        new MemoryBrowserProfileStore()
      ),
      diagnostics,
      availableComputerCapabilityImplementations: [
        'managed-browser-driver',
        'managed-linux-desktop-driver'
      ]
    })

    await expect(
      service.setComputerCapabilityEnabled(
        'linux-desktop-control',
        true
      )
    ).resolves.toMatchObject({
      computerCapabilities: expect.arrayContaining([
        expect.objectContaining({
          id: 'linux-desktop-control',
          enabled: true
        })
      ])
    })
  })
})
