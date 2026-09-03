import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
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
  name: string,
  body = '仅用于离线测试。'
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
      body
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
    await expect(service.getSnapshot()).resolves.toMatchObject({
      builtinMcpServers: expect.arrayContaining([
        expect.objectContaining({
          id: 'builtin-browser',
          enabled: true
        })
      ])
    })
  })

  it('enables direct-model web search by default and persists its switch', async () => {
    const { filePath, builtinRoot, importedRoot, service } =
      await createService()

    await expect(service.getSnapshot()).resolves.toMatchObject({
      webSearch: {
        provider: 'exa',
        enabled: true,
        availableIn: ['ask', 'execute'],
        tools: ['web_search', 'web_fetch']
      }
    })
    await service.setWebSearchEnabled(false)
    await expect(
      service.getWebSearchCapabilityStatus()
    ).resolves.toEqual({ enabled: false })

    const reloaded = new CapabilityService(
      filePath,
      builtinRoot,
      importedRoot,
      cipher
    )
    await expect(reloaded.getSnapshot()).resolves.toMatchObject({
      webSearch: { enabled: false }
    })
  })

  it('persists built-in MCP enablement and supported runtime assignments', async () => {
    const { filePath, builtinRoot, importedRoot, service } =
      await createService()

    await expect(service.getSnapshot()).resolves.toMatchObject({
      builtinMcpServers: [
        {
          id: 'knowledge-base',
          enabled: true,
          assignments: ['model', 'opencode', 'continue']
        },
        {
          id: 'magic-notes',
          enabled: true,
          assignments: ['model', 'opencode', 'continue']
        },
        {
          id: 'goodbuddy-config',
          enabled: true,
          assignments: ['model', 'opencode', 'continue']
        },
        {
          id: 'builtin-browser',
          enabled: false,
          assignments: ['model', 'opencode', 'continue']
        }
      ]
    })

    await service.setBuiltinMcpServerEnabled('magic-notes', false)
    await service.setBuiltinMcpServerAssignments('knowledge-base', [
      'model'
    ])
    await service.setBuiltinMcpServerEnabled('builtin-browser', true)
    await service.setBuiltinMcpServerAssignments('builtin-browser', [
      'continue'
    ])
    expect(() =>
      service.setBuiltinMcpServerAssignments('knowledge-base', [
        'deepseek-harness'
      ])
    ).toThrow('DeepSeek Harness 当前不支持内置 MCP')

    await expect(
      service.getEnabledBuiltinMcpServerIds('model')
    ).resolves.toEqual(['knowledge-base', 'goodbuddy-config'])
    await expect(
      service.getEnabledBuiltinMcpServerIds('opencode')
    ).resolves.toEqual(['goodbuddy-config'])
    await expect(
      service.getEnabledBuiltinMcpServerIds('continue')
    ).resolves.toEqual([
      'goodbuddy-config',
      'builtin-browser'
    ])
    await expect(
      service.getEnabledBuiltinMcpServerIds('deepseek-harness')
    ).resolves.toEqual([])

    const reloaded = new CapabilityService(
      filePath,
      builtinRoot,
      importedRoot,
      cipher
    )
    await expect(reloaded.getSnapshot()).resolves.toMatchObject({
      builtinMcpServers: expect.arrayContaining([
        expect.objectContaining({
          id: 'knowledge-base',
          assignments: ['model']
        }),
        expect.objectContaining({
          id: 'magic-notes',
          enabled: false
        }),
        expect.objectContaining({
          id: 'builtin-browser',
          enabled: true,
          assignments: ['continue']
        })
      ])
    })
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
          assignments: [
            'model',
            'opencode',
            'continue',
            'deepseek-harness'
          ]
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
    await expect(
      reloaded.getRuntimeSkillContext('model', 10_000)
    ).resolves.toMatchObject({
      instructions: expect.stringContaining('仅用于离线测试'),
      packages: [
        {
          id: 'document-writing',
          directory: join(builtinRoot, 'document-writing')
        }
      ]
    })
  })

  it('disables product marketing skills by default and preserves explicit enablement', async () => {
    const { filePath, builtinRoot, importedRoot, service } =
      await createService()
    await Promise.all([
      writeSkill(builtinRoot, 'product-marketing', '产品市场'),
      writeSkill(builtinRoot, 'product-evidence', '产品证据'),
      writeSkill(builtinRoot, 'product-presentation', '产品演示'),
      writeSkill(builtinRoot, 'deai-writing', '中文审校'),
      writeSkill(builtinRoot, 'longdoc-docx', '长文导出')
    ])

    const snapshot = await service.getSnapshot()
    expect(snapshot.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'product-marketing',
          enabled: false
        }),
        expect.objectContaining({
          id: 'product-evidence',
          enabled: false
        }),
        expect.objectContaining({
          id: 'product-presentation',
          enabled: false
        }),
        expect.objectContaining({ id: 'deai-writing', enabled: true }),
        expect.objectContaining({ id: 'longdoc-docx', enabled: true })
      ])
    )

    await service.setSkillEnabled('product-marketing', true)
    const reloaded = new CapabilityService(
      filePath,
      builtinRoot,
      importedRoot,
      cipher
    )
    await expect(reloaded.getSnapshot()).resolves.toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({
          id: 'product-marketing',
          enabled: true
        })
      ])
    })
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

  it('imports a standard SKILL.md that identifies itself by name', async () => {
    const { directory, service } = await createService()
    const source = join(directory, 'standard-source', 'summarize-diff')
    await mkdir(source, { recursive: true })
    await writeFile(
      join(source, 'SKILL.md'),
      [
        '---',
        'name: summarize-diff',
        'description: |',
        '  概括暂存的改动。',
        '  当用户需要待提交变更摘要时使用。',
        'allowed-tools:',
        '  - Read',
        '  - Grep',
        'compatibility: droid',
        '---',
        '',
        '# Summarize Diff',
        '',
        '仅用于离线测试。'
      ].join('\n'),
      'utf8'
    )

    const imported = await service.importSkill(source)

    expect(imported.skills).toContainEqual(
      expect.objectContaining({
        id: 'summarize-diff',
        source: 'imported',
        description: '概括暂存的改动。 当用户需要待提交变更摘要时使用。'
      })
    )
  })

  it('imports every Skill found under a suite directory', async () => {
    const { directory, service } = await createService()
    const suite = join(directory, 'suite', 'skills')
    await writeSkill(suite, 'alpha-skill', 'Alpha')
    await writeSkill(suite, 'beta-skill', 'Beta')

    const imported = await service.importSkill(join(directory, 'suite'))

    expect(imported.skills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining(['alpha-skill', 'beta-skill'])
    )
  })

  it('reports a readable error when the selected directory has no SKILL.md', async () => {
    const { directory, service } = await createService()
    const empty = join(directory, 'empty-directory')
    await mkdir(empty, { recursive: true })

    await expect(service.importSkill(empty)).rejects.toThrow(
      '没有找到 SKILL.md'
    )
  })

  it('exposes the skill directory and names skills dropped by the budget', async () => {
    const { builtinRoot, service } = await createService()
    await writeSkill(
      builtinRoot,
      'oversized-skill',
      '超长技能',
      '超长技能说明。'.repeat(80)
    )

    const instructions = await service.getSkillInstructions('model')
    expect(instructions).toContain(join(builtinRoot, 'document-writing'))
    expect(instructions).toContain(join(builtinRoot, 'oversized-skill'))

    const truncated = await service.getSkillInstructions('model', 200)
    expect(truncated).toContain('因超出注入上限未加载')
    expect(truncated).toContain('超长技能')

    const fullyTruncated = await service.getSkillInstructions('model', 1)
    expect(fullyTruncated).toContain('因超出注入上限未加载')
    expect(fullyTruncated).toContain('文档写作')
    expect(fullyTruncated).toContain('超长技能')
  })

  it('omits Skill names that exceed the OpenCode native limit', async () => {
    const { builtinRoot, service } = await createService()
    const longId = `a${'-a'.repeat(32)}`
    await writeSkill(builtinRoot, longId, '超长名称技能')

    const openCodeContext =
      await service.getRuntimeSkillContext('opencode')
    expect(openCodeContext.instructions).toContain(
      '超过 OpenCode 的 64 字符上限'
    )
    expect(openCodeContext.instructions).toContain('超长名称技能')
    expect(openCodeContext.packages).not.toContainEqual(
      expect.objectContaining({ id: longId })
    )

    const modelContext = await service.getRuntimeSkillContext('model')
    expect(modelContext.packages).toContainEqual(
      expect.objectContaining({ id: longId })
    )
  })

  it('imports a managed Skill from a ZIP package', async () => {
    const { directory, importedRoot, service } = await createService()
    const packageRoot = join(directory, 'zip-source')
    await writeSkill(packageRoot, 'meeting-helper', '会议助手')
    const skillMarkdown = await readFile(
      join(packageRoot, 'meeting-helper', 'SKILL.md')
    )
    const archivePath = join(directory, 'meeting-helper.zip')
    await writeFile(
      archivePath,
      zipSync({
        'meeting-helper/SKILL.md': skillMarkdown,
        'meeting-helper/template.txt': strToU8('template')
      })
    )

    const imported = await service.importSkill(archivePath)

    expect(imported.skills).toContainEqual(
      expect.objectContaining({
        id: 'meeting-helper',
        source: 'imported'
      })
    )
    await expect(
      readFile(
        join(importedRoot, 'meeting-helper', 'template.txt'),
        'utf8'
      )
    ).resolves.toBe('template')
  })

  it('rejects unsafe paths in a Skill ZIP package', async () => {
    const { directory, importedRoot, service } = await createService()
    const packageRoot = join(directory, 'unsafe-source')
    await writeSkill(packageRoot, 'unsafe-skill', '不安全 Skill')
    const skillMarkdown = await readFile(
      join(packageRoot, 'unsafe-skill', 'SKILL.md')
    )
    const archivePath = join(directory, 'unsafe-skill.zip')
    await writeFile(
      archivePath,
      zipSync({
        '../escape.txt': strToU8('escape'),
        'unsafe-skill/SKILL.md': skillMarkdown
      })
    )

    await expect(service.importSkill(archivePath)).rejects.toThrow(
      'Skill ZIP 包含不安全路径'
    )
    await expect(
      readFile(join(importedRoot, 'escape.txt'), 'utf8')
    ).rejects.toThrow()
  })

  it('encrypts remote MCP secrets and never returns them publicly', async () => {
    const { filePath, service } = await createService()
    const snapshot = await service.saveMcpServer(undefined, {
      name: 'Remote MCP',
      description: 'Remote test server',
      enabled: true,
      allowDynamicTools: true,
      assignments: ['model'],
      secret: { action: 'replace', value: 'secret-token-value' },
      transport: 'http',
      url: 'https://mcp.example.com/mcp'
    })
    const server = snapshot.mcpServers[0]
    expect(server).toMatchObject({
      name: 'Remote MCP',
      transport: 'http',
      allowDynamicTools: true,
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
      allowDynamicTools: false,
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

  it('allows bearer tokens over the full IPv4 loopback range', async () => {
    const { service } = await createService()

    await expect(
      service.saveMcpServer(undefined, {
        name: 'Loopback MCP',
        description: '',
        enabled: true,
        allowDynamicTools: false,
        assignments: ['model'],
        secret: { action: 'replace', value: 'secret-token-value' },
        transport: 'http',
        url: 'http://127.0.0.2/mcp'
      })
    ).resolves.toMatchObject({
      mcpServers: [
        expect.objectContaining({
          name: 'Loopback MCP',
          url: 'http://127.0.0.2/mcp'
        })
      ]
    })
  })

  it('allows bearer tokens over HTTP on any configured host', async () => {
    const { service } = await createService()

    const snapshot = await service.saveMcpServer(undefined, {
      name: 'Intranet MCP',
      description: '',
      enabled: true,
      allowDynamicTools: false,
      assignments: ['model'],
      secret: { action: 'replace', value: 'secret-token-value' },
      transport: 'http',
      url: 'http://mcp.internal/mcp'
    })
    expect(snapshot).toMatchObject({
      mcpServers: [
        expect.objectContaining({
          name: 'Intranet MCP',
          secretConfigured: true,
          url: 'http://mcp.internal/mcp'
        })
      ]
    })
    const server = snapshot.mcpServers[0]
    if (!server) {
      throw new Error('Expected saved intranet MCP server')
    }
    await expect(
      service.getResolvedMcpServer(server.id)
    ).resolves.toMatchObject({ secret: 'secret-token-value' })
  })

  it('allows public HTTP MCP servers with or without bearer tokens', async () => {
    const { service } = await createService()

    await expect(
      service.saveMcpServer(undefined, {
        name: 'Public plaintext MCP',
        description: '',
        enabled: true,
        allowDynamicTools: false,
        assignments: ['model'],
        secret: { action: 'replace', value: 'secret-token-value' },
        transport: 'http',
        url: 'http://mcp.example.com/mcp'
      })
    ).resolves.toMatchObject({
      mcpServers: [
        expect.objectContaining({
          url: 'http://mcp.example.com/mcp',
          secretConfigured: true
        })
      ]
    })

    await expect(
      service.saveMcpServer(undefined, {
        name: 'Public MCP without token',
        description: '',
        enabled: true,
        allowDynamicTools: false,
        assignments: ['model'],
        secret: { action: 'clear' },
        transport: 'http',
        url: 'http://mcp.example.com/no-token'
      })
    ).resolves.toMatchObject({
      mcpServers: expect.arrayContaining([
        expect.objectContaining({
          url: 'http://mcp.example.com/no-token',
          secretConfigured: false
        })
      ])
    })
  })

  it('allows MCP assignment to every supported runtime', async () => {
    const { service } = await createService()

    await expect(
      service.saveMcpServer(undefined, {
        name: 'Harness MCP',
        description: '',
        enabled: true,
        allowDynamicTools: false,
        assignments: ['deepseek-harness'],
        secret: { action: 'keep' },
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      })
    ).resolves.toMatchObject({
      mcpServers: [
        expect.objectContaining({
          assignments: ['deepseek-harness']
        })
      ]
    })
    await expect(
      service.getResolvedMcpServers('deepseek-harness')
    ).resolves.toHaveLength(1)
    await expect(
      service.saveMcpServer(undefined, {
        name: 'Agent MCP',
        description: '',
        enabled: true,
        allowDynamicTools: false,
        assignments: ['opencode', 'continue'],
        secret: { action: 'keep' },
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      })
    ).resolves.toMatchObject({
      mcpServers: expect.arrayContaining([
        expect.objectContaining({
          assignments: ['opencode', 'continue']
        })
      ])
    })
    await expect(
      service.getResolvedMcpServers('opencode')
    ).resolves.toHaveLength(1)
    await expect(
      service.getResolvedMcpServers('continue')
    ).resolves.toHaveLength(1)
  })

  it('preserves stored OpenCode MCP assignments', async () => {
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
        expect.objectContaining({ assignments: ['opencode'] })
      ]
    })
    expect(await readFile(filePath, 'utf8')).toContain(
      '"assignments": [\n        "opencode"'
    )
    await expect(service.getResolvedMcpServers('opencode')).resolves.toHaveLength(1)
    await expect(service.getResolvedMcpServers('model')).resolves.toEqual([])
  })

  it('migrates v1 to v5 without losing skills, MCP configuration, or encrypted secrets', async () => {
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
          allowDynamicTools: false,
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
      ],
      webSearch: {
        provider: 'exa',
        enabled: true
      }
    })
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).toContain('"version": 6')
    expect(persisted).toContain(credential)
    expect(persisted).not.toContain('preserved-secret')
  })

  it('migrates v2 capabilities with web search enabled by default', async () => {
    const { filePath, builtinRoot, importedRoot } = await createService()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        skills: {},
        mcpServers: [],
        computerCapabilities: {
          'host-browser-control': {
            enabled: false,
            browserProfileId: null
          },
          'linux-desktop-control': {
            enabled: false,
            browserProfileId: null
          }
        }
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
      webSearch: { enabled: true }
    })
    expect(await readFile(filePath, 'utf8')).toContain('"version": 6')
  })

  it('migrates v3 MCP servers with dynamic tools disabled', async () => {
    const { filePath, builtinRoot, importedRoot } = await createService()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 3,
        skills: {},
        mcpServers: [
          {
            id: 'd2ef774b-146c-4467-a909-6feb112a9c2c',
            name: 'Legacy dynamic MCP',
            description: '',
            enabled: true,
            assignments: ['model'],
            transport: 'http',
            url: 'https://mcp.example.com/mcp'
          }
        ],
        webSearch: { enabled: true },
        computerCapabilities: {
          'host-browser-control': {
            enabled: false,
            browserProfileId: null
          },
          'linux-desktop-control': {
            enabled: false,
            browserProfileId: null
          }
        }
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
        expect.objectContaining({
          allowDynamicTools: false
        })
      ]
    })
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).toContain('"version": 6')
    expect(persisted).toContain('"allowDynamicTools": false')
  })

  it('migrates v4 capabilities with built-in MCP enabled for supported runtimes', async () => {
    const { filePath, builtinRoot, importedRoot } = await createService()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 4,
        skills: {},
        mcpServers: [],
        webSearch: { enabled: true },
        computerCapabilities: {
          'host-browser-control': {
            enabled: false,
            browserProfileId: null
          },
          'linux-desktop-control': {
            enabled: false,
            browserProfileId: null
          }
        }
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
      builtinMcpServers: expect.arrayContaining([
        expect.objectContaining({
          id: 'knowledge-base',
          enabled: true,
          assignments: ['model', 'opencode', 'continue']
        })
      ])
    })
    expect(await readFile(filePath, 'utf8')).toContain('"version": 6')
  })

  it('migrates the legacy browser switch into the built-in browser assignment', async () => {
    const { filePath, builtinRoot, importedRoot } = await createService()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 5,
        skills: {},
        builtinMcpServers: {
          'knowledge-base': {
            enabled: true,
            assignments: ['model', 'opencode', 'continue']
          },
          'magic-notes': {
            enabled: true,
            assignments: ['model', 'opencode', 'continue']
          },
          'goodbuddy-config': {
            enabled: true,
            assignments: ['model', 'opencode', 'continue']
          }
        },
        mcpServers: [],
        webSearch: { enabled: true },
        computerCapabilities: {
          'host-browser-control': {
            enabled: true,
            browserProfileId: null
          },
          'linux-desktop-control': {
            enabled: false,
            browserProfileId: null
          }
        }
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
      builtinMcpServers: expect.arrayContaining([
        {
          id: 'builtin-browser',
          enabled: true,
          assignments: ['model', 'opencode', 'continue']
        }
      ])
    })
    expect(await readFile(filePath, 'utf8')).toContain('"version": 6')
  })

  it('preserves capabilities created by a newer unsupported version', async () => {
    const { directory, filePath, builtinRoot, importedRoot } =
      await createService()
    const futureCapabilities = JSON.stringify({
      version: 99,
      skills: {
        'document-writing': {
          enabled: false,
          assignments: ['model']
        }
      },
      mcpServers: [{ futureTransport: 'keep-me' }],
      webSearch: { enabled: false },
      futureField: 'keep-me'
    })
    await writeFile(filePath, futureCapabilities, 'utf8')
    const service = new CapabilityService(
      filePath,
      builtinRoot,
      importedRoot,
      cipher
    )

    await expect(service.getSnapshot()).rejects.toThrow(
      '不支持能力设置版本 99'
    )
    expect(await readFile(filePath, 'utf8')).toBe(futureCapabilities)
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('capabilities.json.corrupt-')
      )
    ).toBe(false)
  })

  it('continues isolating truly corrupt capability settings', async () => {
    const { directory, filePath, service } = await createService()
    await writeFile(filePath, '{not-json', 'utf8')

    await expect(service.getSnapshot()).resolves.toMatchObject({
      webSearch: { enabled: false },
      mcpServers: [],
      warnings: [{ code: 'capability-settings-recovered' }]
    })
    const entries = await readdir(directory)
    expect(
      entries.some((name) =>
        name.startsWith('capabilities.json.corrupt-')
      )
    ).toBe(true)
  })

  it('clears the recovery warning after a reviewed capability change', async () => {
    const { filePath, service } = await createService()
    await writeFile(filePath, '{not-json', 'utf8')

    await expect(service.getSnapshot()).resolves.toMatchObject({
      warnings: [{ code: 'capability-settings-recovered' }]
    })
    await expect(
      service.setWebSearchEnabled(true)
    ).resolves.not.toHaveProperty('warnings')
  })

  it('preserves corrupt capability settings when isolation fails', async () => {
    const { directory, filePath } = await createService()
    const corruptContents = '{not-json'
    await writeFile(filePath, corruptContents, 'utf8')
    const service = new CapabilityService(
      filePath,
      join(directory, 'builtin'),
      join(directory, 'imported'),
      cipher,
      {
        browserProfiles: new BrowserProfileService(
          new MemoryBrowserProfileStore()
        ),
        settingsFileOperations: {
          rename: vi.fn(async () => {
            throw Object.assign(new Error('rename denied'), {
              code: 'EACCES'
            })
          })
        }
      }
    )

    await expect(service.getSnapshot()).rejects.toThrow(
      '能力设置已损坏且无法隔离'
    )
    expect(await readFile(filePath, 'utf8')).toBe(corruptContents)
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
