import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CapabilityService,
  type CapabilityCipher
} from './capability-service'

const temporaryDirectories: string[] = []

const cipher: CapabilityCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace(/^encrypted:/u, '')
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

async function createService(): Promise<{
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
      cipher
    )
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('CapabilityService', () => {
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
      assignments: ['opencode'],
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
      assignments: ['opencode'],
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
        assignments: ['opencode'],
        secret: { action: 'replace', value: 'secret-token-value' },
        transport: 'http',
        url: 'http://mcp.example.com/mcp'
      })
    ).rejects.toThrow('只能通过 HTTPS')
  })
})
