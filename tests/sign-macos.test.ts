// @vitest-environment node
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'

const { signWheel, isMachO } = createRequire(import.meta.url)('../build/sign-macos.cjs') as {
  signWheel: (path: string, sign: (file: string) => Promise<void>) => Promise<boolean>
  isMachO: (bytes: Uint8Array) => boolean
}
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = join(process.cwd(), 'temp', 'sign-macos-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'wheel-'))
  roots.push(root)
  return join(root, 'example.whl')
}

it('signs nested Mach-O files and refreshes every wheel RECORD hash', async () => {
  const path = await fixture()
  const binary = Buffer.from('cffaedfe01020304', 'hex')
  const record = 'example-1.dist-info/RECORD'
  await writeFile(path, zipSync({
    'example/native.so': binary,
    'example/__init__.py': new TextEncoder().encode('value = 1'),
    [record]: new Uint8Array()
  }))
  const original = await readFile(path)
  const sign = vi.fn(async (file: string) => {
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('signed')]))
  })
  expect(await signWheel(path, sign)).toBe(true)
  expect(sign).toHaveBeenCalledTimes(1)
  const result = unzipSync(await readFile(path))
  expect(Buffer.from(result['example/native.so'])).toEqual(Buffer.concat([binary, Buffer.from('signed')]))
  expect(result['example/__init__.py']).toEqual(unzipSync(original)['example/__init__.py'])
  const manifest = new TextDecoder().decode(result[record])
  for (const name of ['example/native.so', 'example/__init__.py']) {
    expect(manifest).toContain(`${name},sha256=${createHash('sha256').update(result[name]).digest('base64url')},${result[name].length}`)
  }
  expect(manifest).toContain(`${record},,`)
})

it('leaves pure Python wheels byte-identical', async () => {
  const path = await fixture()
  const bytes = zipSync({ 'example.py': new TextEncoder().encode('value = 1') })
  await writeFile(path, bytes)
  const sign = vi.fn()
  expect(await signWheel(path, sign)).toBe(false)
  expect(await readFile(path)).toEqual(Buffer.from(bytes))
  expect(sign).not.toHaveBeenCalled()
})

it('does not replace a wheel when native signing fails', async () => {
  const path = await fixture()
  const bytes = zipSync({
    'native.so': Buffer.from('cafebabe01020304', 'hex'),
    'example-1.dist-info/RECORD': new Uint8Array()
  })
  await writeFile(path, bytes)
  await expect(signWheel(path, async () => { throw new Error('Signing failed') })).rejects.toThrow('Signing failed')
  expect(await readFile(path)).toEqual(Buffer.from(bytes))
})

it('recognizes thin and universal Mach-O but not ELF or text', () => {
  for (const magic of ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']) {
    expect(isMachO(Buffer.from(magic, 'hex'))).toBe(true)
  }
  expect(isMachO(Buffer.from('7f454c46', 'hex'))).toBe(false)
  expect(isMachO(Buffer.from('python'))).toBe(false)
})
