import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parsePythonArtifactCatalog,
  selectPythonArtifact
} from './python-artifact-catalog'

async function catalogValue(): Promise<unknown> {
  return JSON.parse(await readFile(resolve(
    'resources/tool-environment/managed-python-artifacts.json'
  ), 'utf8')) as unknown
}

describe('managed Python artifact catalog', () => {
  it('loads exactly one pinned artifact for all six desktop targets', async () => {
    const catalog = parsePythonArtifactCatalog(await catalogValue())
    expect(catalog.pythonVersion).toBe('3.13.15')
    expect(catalog.artifacts.map((artifact) =>
      `${artifact.platform}/${artifact.arch}`
    )).toEqual([
      'win32/x64',
      'win32/arm64',
      'darwin/x64',
      'darwin/arm64',
      'linux/x64',
      'linux/arm64'
    ])
    expect(catalog.artifacts.map(({ size, sha256 }) => ({ size, sha256 })))
      .toEqual([
        { size: 14391248, sha256: '05357887df50d3153efc681bdf432c321d3e2f9ce5788f99f4515b27e8fda0ac' },
        { size: 13762836, sha256: '3c1b1fdf56adc14634165df922d447520aefdc4a8411a34c34d8a062a4edf494' },
        { size: 24921256, sha256: 'd33d61f7f4982c94216e14a43599c75657b7d0839277fc72bc6dbac53e8229bc' },
        { size: 25140257, sha256: '149038dd0c194c25d4616d7e42a35f67f2edee96412788f74115819b6a4c8548' },
        { size: 34813635, sha256: '8af9a8214c71b2dd698005e39fab87aad02a994330508857da4e6d1ba7e6ddb6' },
        { size: 29222461, sha256: 'e5d0df1a6070a8614d808496e5ea28c727480e40ffcce1a94697a067f1690aa8' }
      ])
  })

  it('freezes the selected source without fallback', async () => {
    const catalog = parsePythonArtifactCatalog(await catalogValue())
    const native = selectPythonArtifact({
      catalog, platform: 'linux', arch: 'arm64', source: 'native'
    })
    const oss = selectPythonArtifact({
      catalog, platform: 'linux', arch: 'arm64', source: 'oss'
    })
    expect(native.source).toBe('native')
    expect(native.url).toContain('github.com/')
    expect(oss.source).toBe('oss')
    expect(oss.url).toContain(`/${oss.sha256}/`)
    expect(oss.redirectHosts).toEqual([
      'goodbuddy.oss-cn-beijing.aliyuncs.com'
    ])
  })

  it('rejects unknown fields and duplicate target rows', async () => {
    const value = await catalogValue() as {
      artifacts: Record<string, unknown>[]
    }
    value.artifacts[0]!.surprise = true
    expect(() => parsePythonArtifactCatalog(value)).toThrow()

    const duplicate = await catalogValue() as {
      artifacts: Record<string, unknown>[]
    }
    duplicate.artifacts[1]!.platform = 'win32'
    duplicate.artifacts[1]!.arch = 'x64'
    expect(() => parsePythonArtifactCatalog(duplicate)).toThrow(
      /duplicate or unsupported target/u
    )
  })
})
