import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CapabilityService,
  type CapabilityCipher
} from './capability-service'
import {
  BrowserProfileService,
  MemoryBrowserProfileStore
} from './browser-profile-service'

const builtinSkillsRoot = join(
  process.cwd(),
  'resources',
  'skills'
)

const cipher: CapabilityCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace(/^encrypted:/u, '')
}

const temporaryDirectories: string[] = []

async function createService(): Promise<CapabilityService> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-builtin-'))
  temporaryDirectories.push(directory)
  return new CapabilityService(
    join(directory, 'capabilities.json'),
    builtinSkillsRoot,
    join(directory, 'imported'),
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
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('bundled skills', () => {
  it('parses every bundled SKILL.md', async () => {
    const snapshot = await (await createService()).getSnapshot()

    expect(snapshot.skills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining([
        'deai-writing',
        'longdoc-docx',
        'product-evidence',
        'product-marketing',
        'product-presentation'
      ])
    )
    expect(snapshot.skills).toHaveLength(5)
    expect(snapshot.skills.every((skill) => skill.source === 'builtin')).toBe(
      true
    )
    expect(
      snapshot.skills
        .filter((skill) => skill.enabled)
        .map((skill) => skill.id)
    ).toEqual(
      expect.arrayContaining(['deai-writing', 'longdoc-docx'])
    )
    expect(
      snapshot.skills
        .filter((skill) => !skill.enabled)
        .map((skill) => skill.id)
    ).toEqual(
      expect.arrayContaining([
        'product-evidence',
        'product-marketing',
        'product-presentation'
      ])
    )
    expect(snapshot.skills.map((skill) => skill.id)).not.toContain(
      'web-3d-game'
    )
  })

  it('injects enabled tools without loading disabled marketing skills', async () => {
    const service = await createService()
    const snapshot = await service.getSnapshot()

    const instructions = await service.getSkillInstructions('continue')

    expect(instructions).not.toContain('因超出注入上限未加载')
    for (const skill of snapshot.skills.filter((item) => item.enabled)) {
      expect(instructions).toContain(join(builtinSkillsRoot, skill.id))
    }
    for (const skill of snapshot.skills.filter((item) => !item.enabled)) {
      expect(instructions).not.toContain(join(builtinSkillsRoot, skill.id))
    }
  })

  it('exposes bundled Skills as native Harness packages', async () => {
    const service = await createService()

    await expect(
      service.getRuntimeSkillContext('deepseek-harness')
    ).resolves.toMatchObject({
      packages: expect.arrayContaining([
        {
          id: 'deai-writing',
          directory: join(builtinSkillsRoot, 'deai-writing')
        },
        {
          id: 'longdoc-docx',
          directory: join(builtinSkillsRoot, 'longdoc-docx')
        }
      ])
    })
  })
})
