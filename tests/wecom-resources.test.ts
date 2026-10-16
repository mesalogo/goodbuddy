import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tar from 'tar'

const require = createRequire(import.meta.url)
const { prepareWecomResources } = require('../build/wecom-resources.cjs') as {
  prepareWecomResources(projectDir: string, platform: string, architecture: string,
    downloadPackage: (projectDir: string, name: string, version: string, integrity: string) => Promise<string>): Promise<void>
}

const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(wheelBytes: Buffer, declared = wheelBytes) {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-wecom-resources-'))
  roots.push(root)
  const packageDir = join(root, 'pkg', 'package')
  mkdirSync(join(packageDir, 'bin'), { recursive: true })
  writeFileSync(join(packageDir, 'bin', 'wecom-cli.exe'), 'cli')
  writeFileSync(join(packageDir, 'LICENSE'), 'MIT')
  const archive = join(root, 'cli.tgz')
  await tar.c({ gzip: true, file: archive, cwd: join(root, 'pkg') }, ['package'])
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(root, 'resources', 'wecom-artifacts.lock.json'), JSON.stringify({
    pythonVersion: '3.13',
    targets: { 'win32-x64': {
      cli: { package: '@wecom/cli-win32-x64', version: '1.3.4', integrity: 'sha512-x' },
      wheels: [{ filename: 'demo-1.0-py3-none-any.whl', url: 'https://files.example/demo.whl', size: declared.length,
        sha256: createHash('sha256').update(declared).digest('hex') }]
    } }
  }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wheelBytes)))
  const download = vi.fn(async () => archive)
  return { root, download }
}

describe('prepareWecomResources', () => {
  it('bundles the verified CLI binary, license and wheels for the target', async () => {
    const { root, download } = await fixture(Buffer.from('wheel'))
    await prepareWecomResources(root, 'win32', 'x64', download)
    const target = join(root, '.runtime-resources', 'wecom-x64')
    expect(download).toHaveBeenCalledWith(root, '@wecom/cli-win32-x64', '1.3.4', 'sha512-x')
    expect(readFileSync(join(target, 'bin', 'wecom-cli.exe'), 'utf8')).toBe('cli')
    expect(readFileSync(join(target, 'LICENSE-wecom-cli.txt'), 'utf8')).toBe('MIT')
    expect(readFileSync(join(target, 'wheels', 'demo-1.0-py3-none-any.whl'), 'utf8')).toBe('wheel')
    expect(JSON.parse(readFileSync(join(target, 'ready.json'), 'utf8'))).toMatchObject({ version: '1.3.4', pythonVersion: '3.13' })
    download.mockClear()
    await prepareWecomResources(root, 'win32', 'x64', download)
    expect(download).not.toHaveBeenCalled()
  })

  it('rejects a wheel whose hash does not match the lock', async () => {
    const { root, download } = await fixture(Buffer.from('tampered'), Buffer.from('expected'))
    await expect(prepareWecomResources(root, 'win32', 'x64', download)).rejects.toThrow('Integrity verification failed')
    expect(existsSync(join(root, '.runtime-resources', 'wecom-x64'))).toBe(false)
  })

  it('ships no WeCom bundle for targets the CLI does not support', async () => {
    const { root, download } = await fixture(Buffer.from('wheel'))
    await prepareWecomResources(root, 'win32', 'arm64', download)
    expect(download).not.toHaveBeenCalled()
    expect(existsSync(join(root, '.runtime-resources', 'wecom-arm64', 'bin'))).toBe(false)
  })
})
