import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { VersionChecker } from '../src/main/version-checker'

const require = createRequire(import.meta.url)
const { PNG } = require('pngjs') as { PNG: { sync: { read: (buffer: Buffer) => { width: number; height: number; data: Buffer } } } }
const builder = require('../build/build-release.cjs') as {
  parseArguments: (args: string[]) => { platform: string; arch: string; formats: string[] }
  buildElectronBuilderArguments: (options: unknown, output: string, environment?: NodeJS.ProcessEnv) => string[]
  verifyArtifacts: (directory: string, options: unknown) => void
}
const store = require('../build/windows-store.cjs') as {
  storeBuilderArguments: (directory: string, environment: NodeJS.ProcessEnv) => string[]
  prepareStoreAssets: (directory: string) => Promise<void>
}
const identity = {
  MS_STORE_IDENTITY_NAME: 'Example.GoodBuddy',
  MS_STORE_PUBLISHER: 'CN=00000000-0000-0000-0000-000000000000',
  MS_STORE_PUBLISHER_DISPLAY_NAME: 'Example publisher'
}

describe('additional Windows distributions', () => {
  it('builds MSI and MSIX separately with their update channels', () => {
    for (const arch of ['x64', 'arm64']) {
      const msi = builder.parseArguments(['--platform', 'windows', '--arch', arch, '--format', 'msi'])
      expect(builder.buildElectronBuilderArguments(msi, 'output')).toEqual(expect.arrayContaining([
        'msi', `--${arch}`, '--config.extraMetadata.goodbuddyWindowsDistribution=msi'
      ]))
      const msix = builder.parseArguments(['--platform', 'windows', '--arch', arch, '--format', 'msix'])
      const args = builder.buildElectronBuilderArguments(msix, 'output', identity)
      expect(args).toEqual(expect.arrayContaining([
        'appx', `--${arch}`, '--config.extraMetadata.goodbuddyWindowsDistribution=store',
        '--config.appx.artifactName=GoodBuddy-${version}-windows-${arch}.msix',
        `--config.appx.publisher=${identity.MS_STORE_PUBLISHER}`
      ]))
      expect(args).not.toContain('msix')
    }
    expect(() => builder.parseArguments(['--platform', 'windows', '--format', 'msi,nsis']))
      .toThrow('分别指定')
    expect(() => builder.parseArguments(['--platform', 'windows', '--format', 'msix,msi']))
      .toThrow('分别指定')
  })

  it('requires actual Store identity instead of falling back to the npm name or author', () => {
    expect(() => store.storeBuilderArguments('output', {})).toThrow('MS_STORE_IDENTITY_NAME')
    expect(() => store.storeBuilderArguments('output', { ...identity, MS_STORE_PUBLISHER: '' })).toThrow('MS_STORE_PUBLISHER')
    expect(() => store.storeBuilderArguments('output', { ...identity, MS_STORE_PUBLISHER: 'Company' })).toThrow('CN=')
  })

  it('generates GoodBuddy Store icons at the required sizes without distorting the wide tile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'windows-store-assets-'))
    try {
      await store.prepareStoreAssets(directory)
      const assets = join(directory, 'store-resources', 'appx')
      expect(await readdir(assets)).toHaveLength(4)
      const wide = PNG.sync.read(await readFile(join(assets, 'Wide310x150Logo.png')))
      expect([wide.width, wide.height]).toEqual([310, 150])
      expect(wide.data[3]).toBe(0)
      const logo = PNG.sync.read(await readFile(join(assets, 'Square44x44Logo.png')))
      expect([logo.width, logo.height]).toEqual([44, 44])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a renamed EXE posing as an MSI and an ordinary ZIP posing as MSIX', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'windows-formats-'))
    try {
      const msi = builder.parseArguments(['--platform', 'windows', '--format', 'msi'])
      await writeFile(join(directory, 'GoodBuddy.msi'), 'MZfake')
      expect(() => builder.verifyArtifacts(directory, msi)).toThrow('Windows Installer')
      const { zipSync } = await import('fflate')
      await writeFile(join(directory, 'GoodBuddy.msix'), zipSync({ 'hello.txt': Buffer.from('hello') }))
      const msix = builder.parseArguments(['--platform', 'windows', '--format', 'msix'])
      expect(() => builder.verifyArtifacts(directory, msix)).toThrow('AppxManifest.xml')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('accepts the ZIP64 directory emitted by MakeAppx and rejects a corrupt locator', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'msix-zip64-'))
    try {
      const { zipSync } = await import('fflate')
      const zip = Buffer.from(zipSync(Object.fromEntries(
        ['AppxManifest.xml', 'AppxBlockMap.xml', '[Content_Types].xml', 'app/GoodBuddy.exe', 'app/resources/app.asar']
          .map(name => [name, Buffer.from('fixture')])
      )))
      const end = zip.subarray(zip.length - 22)
      const record = Buffer.alloc(56)
      record.writeUInt32LE(0x06064b50)
      record.writeBigUInt64LE(44n, 4)
      record.writeBigUInt64LE(5n, 24)
      record.writeBigUInt64LE(5n, 32)
      record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40)
      record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48)
      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(0x07064b50)
      locator.writeBigUInt64LE(BigInt(zip.length - 22), 8)
      locator.writeUInt32LE(1, 16)
      // MakeAppx writes sentinels for every classic end-record field, including disks.
      end.fill(0xff, 4, 20)
      const filename = join(directory, 'GoodBuddy.msix')
      const options = builder.parseArguments(['--platform', 'windows', '--format', 'msix'])
      await writeFile(filename, Buffer.concat([zip.subarray(0, -22), record, locator, end]))
      expect(() => builder.verifyArtifacts(directory, options)).not.toThrow()
      locator.writeBigUInt64LE(0xffffffffffffffffn, 8)
      await writeFile(filename, Buffer.concat([zip.subarray(0, -22), record, locator, end]))
      expect(() => builder.verifyArtifacts(directory, options)).toThrow('MSIX 中央目录无效')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it.each(['store', 'msi'] as const)('does not offer NSIS updates to %s installations', async windowsDistribution => {
    const fetch = vi.fn()
    const onResult = vi.fn()
    const checker = new VersionChecker({ fetch, currentVersion: '0.18.3', platform: 'win32', arch: 'x64', windowsDistribution, onResult })
    await expect(checker.check()).resolves.toMatchObject({ managedBy: windowsDistribution, updateAvailable: false, target: { files: [] } })
    expect(fetch).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ managedBy: windowsDistribution }), 'github')
    if (windowsDistribution === 'store') expect(checker.getDownloadPage('mirror')).toBe('ms-windows-store://downloadsandupdates')
  })
})
