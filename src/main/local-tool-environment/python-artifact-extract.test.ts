import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zipSync } from 'fflate'
import { create } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { extractPythonArtifact } from './python-artifact-extract'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-python-extract-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

function tarField(value: string | number, length: number): Buffer {
  const text = typeof value === 'number' ? value.toString(8) : value
  const result = Buffer.alloc(length)
  result.write(text.slice(0, length - 1), 0, 'ascii')
  return result
}

function tarArchive(entries: {
  path: string
  type?: '0' | '2' | '5'
  content?: string
  linkPath?: string
  mode?: number
}[]): Buffer {
  const parts: Buffer[] = []
  for (const item of entries) {
    const content = Buffer.from(item.content ?? '')
    const header = Buffer.alloc(512)
    tarField(item.path, 100).copy(header, 0)
    tarField(item.mode ?? 0o755, 8).copy(header, 100)
    tarField(0, 8).copy(header, 108)
    tarField(0, 8).copy(header, 116)
    tarField(content.byteLength, 12).copy(header, 124)
    tarField(0, 12).copy(header, 136)
    header.fill(0x20, 148, 156)
    header.write(item.type ?? '0', 156, 'ascii')
    tarField(item.linkPath ?? '', 100).copy(header, 157)
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let checksum = 0
    for (const value of header) {
      checksum += value
    }
    const checksumText = checksum.toString(8).padStart(6, '0')
    header.write(`${checksumText}\0 `, 148, 'ascii')
    parts.push(header, content)
    const padding = (512 - content.byteLength % 512) % 512
    if (padding > 0) {
      parts.push(Buffer.alloc(padding))
    }
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

describe('Managed Python archive extraction', () => {
  it('extracts only the tools payload root from a NuGet ZIP', async () => {
    const directory = await temporaryDirectory()
    const archivePath = join(directory, 'python.nupkg')
    await writeFile(archivePath, zipSync({
      '[Content_Types].xml': Buffer.from('<Types />'),
      'package.nuspec': Buffer.from('<package />'),
      'tools/python.exe': Buffer.from('python'),
      'tools/Lib/site.py': Buffer.from('site')
    }))
    const destinationDirectory = join(directory, 'install')
    await extractPythonArtifact({
      artifact: {
        platform: 'win32',
        archiveFormat: 'nuget-zip',
        payloadRoot: 'tools'
      },
      archivePath,
      destinationDirectory
    })
    expect(await readFile(join(destinationDirectory, 'python.exe'), 'utf8'))
      .toBe('python')
    expect(await readFile(join(destinationDirectory, 'Lib/site.py'), 'utf8'))
      .toBe('site')
    await expect(
      readFile(join(destinationDirectory, 'package.nuspec'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects ZIP traversal before writing payload files', async () => {
    const directory = await temporaryDirectory()
    const archivePath = join(directory, 'bad.nupkg')
    await writeFile(archivePath, zipSync({
      'tools/python.exe': Buffer.from('python'),
      'tools/../escaped': Buffer.from('bad')
    }))
    await expect(extractPythonArtifact({
      artifact: {
        platform: 'win32',
        archiveFormat: 'nuget-zip',
        payloadRoot: 'tools'
      },
      archivePath,
      destinationDirectory: join(directory, 'install')
    })).rejects.toThrow(/Unsafe archive path/u)
    await expect(readFile(join(directory, 'escaped'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('extracts an Astral-style python TAR root', async () => {
    const directory = await temporaryDirectory()
    const source = join(directory, 'source')
    await mkdir(join(source, 'python/bin'), { recursive: true })
    await writeFile(join(source, 'python/bin/python3'), 'python')
    const archivePath = join(directory, 'python.tar.gz')
    await create({
      cwd: source,
      file: archivePath,
      gzip: true,
      portable: true
    }, ['python'])
    const destinationDirectory = join(directory, 'install')
    await extractPythonArtifact({
      artifact: {
        platform: 'linux',
        archiveFormat: 'tar.gz',
        payloadRoot: 'python'
      },
      archivePath,
      destinationDirectory
    })
    expect(await readFile(join(destinationDirectory, 'bin/python3'), 'utf8'))
      .toBe('python')
  })

  it('uses target filesystem case semantics for TAR paths', async () => {
    const directory = await temporaryDirectory()
    const archivePath = join(directory, 'case-sensitive.tar.gz')
    await writeFile(archivePath, gzipSync(tarArchive([
      { path: 'python/share/terminfo/2/2621A', type: '5' },
      { path: 'python/share/terminfo/2/2621a', type: '5' }
    ])))
    const destinationDirectory = join(directory, 'linux-install')
    await extractPythonArtifact({
      artifact: {
        platform: 'linux',
        archiveFormat: 'tar.gz',
        payloadRoot: 'python'
      },
      archivePath,
      destinationDirectory
    })
    expect(
      (await lstat(join(destinationDirectory, 'share/terminfo/2/2621A')))
        .isDirectory()
    ).toBe(true)
    expect(
      (await lstat(join(destinationDirectory, 'share/terminfo/2/2621a')))
        .isDirectory()
    ).toBe(true)

    await expect(extractPythonArtifact({
      artifact: {
        platform: 'darwin',
        archiveFormat: 'tar.gz',
        payloadRoot: 'python'
      },
      archivePath,
      destinationDirectory: join(directory, 'darwin-install')
    })).rejects.toThrow(/duplicate path/u)

    const duplicateArchivePath = join(directory, 'duplicate.tar.gz')
    await writeFile(duplicateArchivePath, gzipSync(tarArchive([
      { path: 'python/lib/duplicate', content: 'first' },
      { path: 'python/lib/duplicate', content: 'second' }
    ])))
    await expect(extractPythonArtifact({
      artifact: {
        platform: 'linux',
        archiveFormat: 'tar.gz',
        payloadRoot: 'python'
      },
      archivePath: duplicateArchivePath,
      destinationDirectory: join(directory, 'duplicate-install')
    })).rejects.toThrow(/duplicate path/u)
  })

  it('validates relative symlinks and rejects escaping links', async () => {
    const directory = await temporaryDirectory()
    if (process.platform !== 'win32') {
      const safeArchive = join(directory, 'safe.tar.gz')
      await writeFile(safeArchive, gzipSync(tarArchive([
        { path: 'python/bin/python3', content: 'python' },
        {
          path: 'python/bin/python',
          type: '2',
          linkPath: 'python3'
        }
      ])))
      const destinationDirectory = join(directory, 'safe-install')
      await extractPythonArtifact({
        artifact: {
          platform: 'linux',
          archiveFormat: 'tar.gz',
          payloadRoot: 'python'
        },
        archivePath: safeArchive,
        destinationDirectory
      })
      expect(await readFile(join(destinationDirectory, 'bin/python'), 'utf8'))
        .toBe('python')
    }

    const unsafeArchive = join(directory, 'unsafe.tar.gz')
    await writeFile(unsafeArchive, gzipSync(tarArchive([
      {
        path: 'python/bin/python',
        type: '2',
        linkPath: '../../../outside'
      }
    ])))
    await expect(extractPythonArtifact({
      artifact: {
        platform: 'linux',
        archiveFormat: 'tar.gz',
        payloadRoot: 'python'
      },
      archivePath: unsafeArchive,
      destinationDirectory: join(directory, 'unsafe-install')
    })).rejects.toThrow(/escapes payload root/u)
  })
})
