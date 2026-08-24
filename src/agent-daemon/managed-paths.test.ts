import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertAbsoluteManagedPath,
  derivePrivateTemporaryRoot,
  ensurePrivateDirectory,
  ensurePrivateDirectoryTree,
  ensurePrivateTemporaryRoot,
  readPrivateFile,
  writePrivateFileAtomic
} from './managed-paths'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('deterministic private temporary root', () => {
  it('binds a 0700 root marker to the UID and canonical home', () => {
    const temporaryDirectory = privateTemporaryDirectory()
    const identity = derivePrivateTemporaryRoot({
      platform: 'linux',
      uid: 1234,
      homeDirectory: resolve(temporaryDirectory, 'home'),
      temporaryDirectory
    })
    expect(identity.rootPath).toContain('goodbuddy-1234-')
    expect(ensurePrivateTemporaryRoot(identity)).toBe(identity.rootPath)
    const marker = readFileSync(
      resolve(identity.rootPath, '.goodbuddy-private-root-v1'),
      'utf8'
    )
    expect(JSON.parse(marker)).toEqual({
      formatVersion: 1,
      uid: 1234,
      canonicalHomeDirectory: resolve(temporaryDirectory, 'home')
    })
  })

  it('rejects an existing marker for another home', () => {
    const temporaryDirectory = privateTemporaryDirectory()
    const identity = derivePrivateTemporaryRoot({
      platform: 'linux',
      uid: 1234,
      homeDirectory: resolve(temporaryDirectory, 'home'),
      temporaryDirectory
    })
    ensurePrivateTemporaryRoot(identity)
    writeFileSync(
      resolve(identity.rootPath, '.goodbuddy-private-root-v1'),
      '{"formatVersion":1,"uid":1234,"canonicalHomeDirectory":"/foreign"}\n',
      { mode: 0o600 }
    )
    expect(() => ensurePrivateTemporaryRoot(identity)).toThrow(
      'does not match this user'
    )
  })

  it('rejects a corrupt or permissive marker without replacing it', () => {
    const temporaryDirectory = privateTemporaryDirectory()
    const identity = derivePrivateTemporaryRoot({
      platform: 'linux',
      uid: 1234,
      homeDirectory: resolve(temporaryDirectory, 'home'),
      temporaryDirectory
    })
    ensurePrivateTemporaryRoot(identity)
    const markerPath = resolve(
      identity.rootPath,
      '.goodbuddy-private-root-v1'
    )
    writeFileSync(markerPath, '{broken-json\n')
    expect(() => ensurePrivateTemporaryRoot(identity)).toThrow(
      'does not match this user'
    )
    expect(readFileSync(markerPath, 'utf8')).toBe('{broken-json\n')

    if (process.platform !== 'win32') {
      writeFileSync(
        markerPath,
        `${JSON.stringify({
          formatVersion: 1,
          uid: identity.uid,
          canonicalHomeDirectory: identity.canonicalHomeDirectory
        }, null, 2)}\n`
      )
      chmodSync(markerPath, 0o644)
      expect(() => ensurePrivateTemporaryRoot(identity)).toThrow(
        'permissions must be 0600'
      )
    }
  })
})

describe('managed path containment', () => {
  it('requires normalized absolute paths and rejects anchor escapes', () => {
    const root = privateTemporaryDirectory()
    expect(() => assertAbsoluteManagedPath('relative')).toThrow(
      'normalized absolute'
    )
    expect(() =>
      assertAbsoluteManagedPath(`${resolve(root, 'entry')}\0tail`)
    ).toThrow('cannot contain NUL')
    expect(() =>
      ensurePrivateDirectoryTree(resolve(root, '..', 'escape'), root)
    ).toThrow('escapes its configured anchor')
  })

  it('rejects files, permissive directories, and symlink traversal', () => {
    const root = privateTemporaryDirectory()
    const filePath = resolve(root, 'file')
    writeFileSync(filePath, 'not a directory')
    expect(() => ensurePrivateDirectory(filePath)).toThrow(
      'not a real directory'
    )

    if (process.platform !== 'win32') {
      const permissive = resolve(root, 'permissive')
      mkdirSync(permissive, { mode: 0o755 })
      chmodSync(permissive, 0o755)
      expect(() => ensurePrivateDirectory(permissive)).toThrow(
        'permissions must be 0700'
      )
    }

    const outside = privateTemporaryDirectory()
    const junction = resolve(root, 'junction')
    symlinkSync(outside, junction, 'junction')
    expect(() =>
      assertAbsoluteManagedPath(resolve(junction, 'managed.json'))
    ).toThrow('cannot traverse a symlink')
  })

  it('atomically writes only private regular targets and reads bounded bytes', () => {
    const root = privateTemporaryDirectory()
    const target = resolve(root, 'state.json')
    writePrivateFileAtomic(target, '{"state":"ready"}\n')
    expect(readPrivateFile(target, 64).toString('utf8')).toBe(
      '{"state":"ready"}\n'
    )
    expect(() => readPrivateFile(target, 4)).toThrow('size limit')

    if (process.platform !== 'win32') {
      chmodSync(target, 0o644)
      expect(() => writePrivateFileAtomic(target, 'replacement')).toThrow(
        'permissions must be 0600'
      )
      expect(readFileSync(target, 'utf8')).toBe('{"state":"ready"}\n')
    }
  })

  it('never writes through a symlinked component outside its root', () => {
    const root = privateTemporaryDirectory()
    const outside = privateTemporaryDirectory()
    const sentinel = resolve(outside, 'sentinel.txt')
    writeFileSync(sentinel, 'user-owned')
    const junction = resolve(root, 'junction')
    symlinkSync(outside, junction, 'junction')

    expect(() =>
      writePrivateFileAtomic(resolve(junction, 'sentinel.txt'), 'changed')
    ).toThrow('cannot traverse a symlink')
    expect(readFileSync(sentinel, 'utf8')).toBe('user-owned')
    expect(existsSync(resolve(root, 'sentinel.txt'))).toBe(false)
  })
})

function privateTemporaryDirectory(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'goodbuddy-paths-'))
  temporaryPaths.push(path)
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return resolve(path)
}
