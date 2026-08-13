import {
  access,
  mkdtemp,
  mkdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationSettingsStore } from './application-settings-store'
import {
  BrowserProfileService,
  MemoryBrowserProfileStore
} from './capabilities/browser-profile-service'
import {
  CapabilityService,
  type CapabilityCipher
} from './capabilities/capability-service'
import { GoodBuddyConfigService } from './goodbuddy-config-service'

const temporaryDirectories: string[] = []
const cipher: CapabilityCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value),
  decrypt: (value) => value.toString()
}

async function writeSkill(
  root: string,
  id: string,
  body = 'Follow the user request.'
): Promise<string> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    [
      '---',
      `id: ${id}`,
      `name: ${id}`,
      `description: ${id} test skill`,
      '---',
      '',
      body
    ].join('\n'),
    'utf8'
  )
  return directory
}

async function createHarness(now = 1_000) {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-config-'))
  temporaryDirectories.push(directory)
  const builtinRoot = join(directory, 'builtin')
  const importedRoot = join(directory, 'imported')
  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeSkill(builtinRoot, 'built-in')
  const capabilities = new CapabilityService(
    join(directory, 'capabilities.json'),
    builtinRoot,
    importedRoot,
    cipher,
    {
      browserProfiles: new BrowserProfileService(
        new MemoryBrowserProfileStore()
      )
    }
  )
  const application = new ApplicationSettingsStore(
    join(directory, 'application.json')
  )
  const service = new GoodBuddyConfigService(application, capabilities, {
    now: () => now,
    planTtlMs: 100
  })
  return {
    directory,
    workspace,
    capabilities,
    application,
    service,
    setNow(value: number) {
      now = value
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('GoodBuddyConfigService', () => {
  it('returns only sanitized configuration and publishes common examples', async () => {
    const { service, capabilities } = await createHarness()
    await capabilities.saveMcpServer(undefined, {
      name: 'Secret MCP',
      description: '',
      enabled: false,
      allowDynamicTools: false,
      assignments: ['model'],
      secret: { action: 'replace', value: 'never-return-this' },
      transport: 'http',
      url: 'https://mcp.example.com/tools'
    })

    expect(service.getCapabilities()).toMatchObject({
      server: 'goodbuddy_config',
      applyRequiresApproval: true,
      operations: expect.arrayContaining([
        expect.objectContaining({
          operation: 'skill.import',
          exampleRequest: expect.stringContaining('导入')
        })
      ])
    })
    const snapshot = await service.getSnapshot()
    expect(snapshot.mcpServers[0]).toMatchObject({
      name: 'Secret MCP',
      secretConfigured: true,
      transport: 'http'
    })
    expect(JSON.stringify(snapshot)).not.toContain('never-return-this')
    expect(JSON.stringify(snapshot)).not.toContain(
      'https://mcp.example.com/tools'
    )
  })

  it('scopes one-shot plans to a request and rejects expired plans', async () => {
    const harness = await createHarness()
    const plan = await harness.service.plan(
      'request-one',
      harness.workspace,
      {
        operations: [
          {
            operation: 'application.update',
            updates: { checkUpdatesOnStartup: false }
          }
        ]
      }
    )
    const authorize = vi.fn(async () => true)

    await expect(
      harness.service.apply(
        'request-two',
        { planId: plan.planId },
        new AbortController().signal,
        authorize
      )
    ).rejects.toThrow('不属于当前请求')
    expect(authorize).not.toHaveBeenCalled()

    const expiring = await harness.service.plan(
      'request-one',
      harness.workspace,
      {
        operations: [
          {
            operation: 'application.update',
            updates: { checkUpdatesOnStartup: false }
          }
        ]
      }
    )
    harness.setNow(1_101)
    await expect(
      harness.service.apply(
        'request-one',
        { planId: expiring.planId },
        new AbortController().signal,
        authorize
      )
    ).rejects.toThrow('已过期')
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects a plan that expires while native approval is open', async () => {
    const harness = await createHarness()
    const plan = await harness.service.plan(
      'request-one',
      harness.workspace,
      {
        operations: [
          {
            operation: 'application.update',
            updates: { checkUpdatesOnStartup: false }
          }
        ]
      }
    )

    await expect(
      harness.service.apply(
        'request-one',
        { planId: plan.planId },
        new AbortController().signal,
        async () => {
          harness.setNow(1_101)
          return true
        }
      )
    ).rejects.toThrow('确认期间已过期')
    await expect(harness.application.get()).resolves.toMatchObject({
      checkUpdatesOnStartup: true
    })
  })

  it('requires approval and applies a plan only once', async () => {
    const harness = await createHarness()
    const deniedPlan = await harness.service.plan(
      'request-one',
      harness.workspace,
      {
        operations: [
          {
            operation: 'application.update',
            updates: { checkUpdatesOnStartup: false }
          }
        ]
      }
    )
    await expect(
      harness.service.apply(
        'request-one',
        { planId: deniedPlan.planId },
        new AbortController().signal,
        async () => false
      )
    ).rejects.toThrow('用户拒绝')
    await expect(harness.application.get()).resolves.toMatchObject({
      checkUpdatesOnStartup: true
    })

    const approvedPlan = await harness.service.plan(
      'request-one',
      harness.workspace,
      {
        operations: [
          {
            operation: 'application.update',
            updates: { checkUpdatesOnStartup: false }
          }
        ]
      }
    )
    await expect(
      harness.service.apply(
        'request-one',
        { planId: approvedPlan.planId },
        new AbortController().signal,
        async () => true
      )
    ).resolves.toMatchObject({
      status: 'applied',
      appliedOperations: 1,
      reload: 'none'
    })
    await expect(harness.application.get()).resolves.toMatchObject({
      checkUpdatesOnStartup: false
    })
    expect(harness.service.takePendingReload('request-one')).toBe(
      'after-current-request'
    )
    await expect(
      harness.service.apply(
        'request-one',
        { planId: approvedPlan.planId },
        new AbortController().signal,
        async () => true
      )
    ).rejects.toThrow('不存在')
  })

  it('imports the exact inspected Skill and requests a deferred reload', async () => {
    const harness = await createHarness()
    await writeSkill(harness.workspace, 'meeting-helper')
    const plan = await harness.service.plan(
      'request-one',
      harness.workspace,
      {
        operations: [
          {
            operation: 'skill.import',
            sourcePath: './meeting-helper',
            enabled: false,
            assignments: ['model']
          }
        ]
      }
    )
    expect(plan.operations[0]).toMatchObject({
      sourcePath: './meeting-helper'
    })
    await harness.service.apply(
      'request-one',
      { planId: plan.planId },
      new AbortController().signal,
      async () => true
    )
    await expect(harness.capabilities.getSnapshot()).resolves.toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({
          id: 'meeting-helper',
          source: 'imported',
          enabled: false,
          assignments: ['model']
        })
      ])
    })
    expect(harness.service.takePendingReload('request-one')).toBe(
      'after-current-request'
    )
    expect(harness.service.takePendingReload('request-one')).toBe('none')

    const secondSource = await writeSkill(
      harness.workspace,
      'changing-skill'
    )
    const changingPlan = await harness.service.plan(
      'request-two',
      harness.workspace,
      {
        operations: [
          {
            operation: 'skill.import',
            sourcePath: secondSource,
            enabled: true,
            assignments: ['model']
          }
        ]
      }
    )
    await writeFile(
      join(secondSource, 'extra.js'),
      'console.log("changed")',
      'utf8'
    )
    await expect(
      harness.service.apply(
        'request-two',
        { planId: changingPlan.planId },
        new AbortController().signal,
        async () => true
      )
    ).rejects.toThrow('确认后已发生变化')
  })

  it('reports partial application and still requests reload after a later failure', async () => {
    const harness = await createHarness()
    await writeSkill(harness.workspace, 'partial-skill')
    const plan = await harness.service.plan(
      'request-partial',
      harness.workspace,
      {
        operations: [
          {
            operation: 'skill.import',
            sourcePath: './partial-skill',
            enabled: true,
            assignments: ['model']
          },
          {
            operation: 'application.update',
            updates: { checkUpdatesOnStartup: false }
          }
        ]
      }
    )
    await writeFile(
      join(harness.workspace, 'partial-skill', 'changed.txt'),
      'changed',
      'utf8'
    )

    await expect(
      harness.service.apply(
        'request-partial',
        { planId: plan.planId },
        new AbortController().signal,
        async () => true
      )
    ).rejects.toThrow('已发生变化')

    const secondPlan = await harness.service.plan(
      'request-partial-two',
      harness.workspace,
      {
        operations: [
          {
            operation: 'skill.import',
            sourcePath: './partial-skill',
            enabled: true,
            assignments: ['model']
          },
          {
            operation: 'skill.setEnabled',
            skillId: 'built-in',
            enabled: false
          }
        ]
      }
    )
    const originalSetSkillEnabled = harness.capabilities.setSkillEnabled.bind(
      harness.capabilities
    )
    vi.spyOn(harness.capabilities, 'setSkillEnabled').mockImplementationOnce(
      async () => {
        throw new Error('later operation failed')
      }
    )
    const result = await harness.service.apply(
      'request-partial-two',
      { planId: secondPlan.planId },
      new AbortController().signal,
      async () => true
    )
    expect(result).toMatchObject({
      status: 'partially-applied',
      appliedOperations: 1,
      reload: 'after-current-request',
      error: 'later operation failed'
    })
    expect(harness.service.takePendingReload('request-partial-two')).toBe(
      'after-current-request'
    )
    vi.mocked(harness.capabilities.setSkillEnabled).mockImplementation(
      originalSetSkillEnabled
    )
  })

  it('rejects Skill paths outside the workspace', async () => {
    const harness = await createHarness()
    const outside = await writeSkill(harness.directory, 'outside-skill')
    await expect(
      harness.service.plan('request-one', harness.workspace, {
        operations: [
          {
            operation: 'skill.import',
            sourcePath: outside,
            enabled: true,
            assignments: ['model']
          }
        ]
      })
    ).rejects.toThrow('必须位于当前工作区')
  })

  it('shows executable MCP details and invalidates hidden connection changes', async () => {
    const harness = await createHarness()
    const existing = await harness.capabilities.saveMcpServer(undefined, {
      name: 'Existing MCP',
      description: '',
      enabled: false,
      allowDynamicTools: false,
      assignments: ['model'],
      secret: { action: 'keep' },
      transport: 'http',
      url: 'https://old.example.com/mcp'
    })
    const serverId = existing.mcpServers[0]!.id
    const addPlan = await harness.service.plan(
      'request-add',
      harness.workspace,
      {
        operations: [
          {
            operation: 'mcp.add',
            connection: {
              name: 'Local MCP',
              description: '',
              allowDynamicTools: false,
              transport: 'stdio',
              command: 'node',
              args: ['server.js', '--safe']
            },
            enabled: false,
            assignments: ['model']
          }
        ]
      }
    )
    expect(addPlan.steps[0]?.summary).toContain(
      '命令 "node" "server.js" "--safe"'
    )

    const enablePlan = await harness.service.plan(
      'request-enable',
      harness.workspace,
      {
        operations: [
          {
            operation: 'mcp.setEnabled',
            serverId,
            enabled: true
          }
        ]
      }
    )
    await harness.capabilities.saveMcpServer(serverId, {
      name: 'Existing MCP',
      description: '',
      enabled: false,
      allowDynamicTools: false,
      assignments: ['model'],
      secret: { action: 'keep' },
      transport: 'http',
      url: 'https://new.example.com/mcp'
    })
    await expect(
      harness.service.apply(
        'request-enable',
        { planId: enablePlan.planId },
        new AbortController().signal,
        async () => true
      )
    ).rejects.toThrow('确认前已发生变化')
  })

  it('does not create persistent inspection artifacts while planning a ZIP Skill', async () => {
    const harness = await createHarness()
    const archivePath = join(harness.workspace, 'skill.zip')
    const { strToU8, zipSync } = await import('fflate')
    await writeFile(
      archivePath,
      Buffer.from(
        zipSync({
          'zip-helper/SKILL.md': strToU8(
            [
              '---',
              'id: zip-helper',
              'name: zip-helper',
              'description: ZIP helper',
              '---',
              '',
              'Help with ZIP files.'
            ].join('\n')
          )
        })
      )
    )

    await harness.service.plan('request-zip', harness.workspace, {
      operations: [
        {
          operation: 'skill.import',
          sourcePath: './skill.zip',
          enabled: false,
          assignments: []
        }
      ]
    })
    await expect(
      access(join(harness.directory, 'imported'))
    ).rejects.toThrow()
  })
})
