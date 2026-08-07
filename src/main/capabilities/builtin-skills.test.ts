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

    expect(snapshot.skills.length).toBeGreaterThan(0)
    expect(snapshot.skills.every((skill) => skill.source === 'builtin')).toBe(
      true
    )
    expect(snapshot.skills.map((skill) => skill.id)).toContain(
      'product-marketing'
    )
  })

  it('injects every enabled bundled skill with its resolved directory', async () => {
    const service = await createService()
    const snapshot = await service.getSnapshot()

    const instructions = await service.getSkillInstructions('continue')

    expect(instructions).not.toContain('因超出注入上限未加载')
    for (const skill of snapshot.skills) {
      expect(instructions).toContain(join(builtinSkillsRoot, skill.id))
    }
  })
})
