import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PythonArtifact } from './python-artifact-catalog'
import { downloadPythonArtifact } from './python-artifact-download'

const temporaryDirectories: string[] = []

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-python-download-'))
  temporaryDirectories.push(directory)
  return join(directory, 'artifact')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

function artifact(bytes: Uint8Array): PythonArtifact {
  return {
    platform: 'linux',
    arch: 'x64',
    archiveFormat: 'tar.gz',
    payloadRoot: 'python',
    fileName: 'python.tar.gz',
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    nativeUrl: 'https://download.example/python.tar.gz',
    ossUrl: 'https://oss.example/python.tar.gz',
    source: 'native',
    url: 'https://download.example/python.tar.gz',
    redirectHosts: ['download.example', 'cdn.example']
  }
}

describe('Managed Python download', () => {
  it('follows only bounded declared redirects and verifies bytes', async () => {
    const bytes = Buffer.from('verified Python archive')
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example/python.tar.gz' }
      }))
      .mockResolvedValueOnce(new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) }
      }))
    const destinationPath = await temporaryPath()
    await downloadPythonArtifact({
      artifact: artifact(bytes),
      destinationPath,
      transport
    })
    expect(await readFile(destinationPath)).toEqual(bytes)
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('removes a partial on hash mismatch', async () => {
    const bytes = Buffer.from('wrong bytes')
    const expected = artifact(Buffer.from('right bytes'))
    expected.size = bytes.byteLength
    const destinationPath = await temporaryPath()
    await expect(downloadPythonArtifact({
      artifact: expected,
      destinationPath,
      transport: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(bytes, { status: 200 })
      )
    })).rejects.toThrow(/integrity/u)
    await expect(readFile(destinationPath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects an undeclared redirect host without a fallback request', async () => {
    const bytes = Buffer.from('archive')
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/archive' }
      })
    )
    await expect(downloadPythonArtifact({
      artifact: artifact(bytes),
      destinationPath: await temporaryPath(),
      transport
    })).rejects.toThrow(/undeclared host/u)
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
