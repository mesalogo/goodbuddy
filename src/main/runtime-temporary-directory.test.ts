import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanupRuntimeTemporaryDirectories, createRuntimeTemporaryDirectory, recordRuntimeTemporaryChild, runtimeTemporaryRoot } from './runtime-temporary-directory'

const roots: string[] = []
async function fixture() {
  const base = resolve('temp')
  await fs.mkdir(base, { recursive: true })
  const userDataPath = await fs.mkdtemp(join(base, 'goodbuddy-runtime-scratch-'))
  roots.push(userDataPath)
  const legacyTempRoot = join(userDataPath, 'legacy')
  await fs.mkdir(legacyTempRoot)
  return { userDataPath, legacyTempRoot, isProcessActive: () => false }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

it('creates version/run launch material lazily and reclaims obsolete runs including caches', async () => {
  const options = await fixture()
  const root = runtimeTemporaryRoot(options.userDataPath, '0.15.12', 'run-one')
  await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(root).toBe(join(options.userDataPath, 'temp', 'goodbuddy-runtime', '0.15.12', 'run-one', 'goodbuddy-runtime-launch'))
  const directory = await createRuntimeTemporaryDirectory(root, 'goodbuddy-opencode-')
  await recordRuntimeTemporaryChild(directory, 12345)
  await fs.mkdir(join(root, 'config'))
  expect((await cleanupRuntimeTemporaryDirectories(options)).removed).toContain(root)
  await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves a surviving child, a live creator, and an incomplete launch', async () => {
  const options = await fixture()
  for (const scenario of ['child', 'creator', 'incomplete']) {
    const root = runtimeTemporaryRoot(options.userDataPath, '0.15.11', scenario)
    const directory = await createRuntimeTemporaryDirectory(root, 'goodbuddy-continue-')
    if (scenario !== 'incomplete') await recordRuntimeTemporaryChild(directory, 12345)
    const result = await cleanupRuntimeTemporaryDirectories({ ...options, isProcessActive: pid =>
      scenario === 'child' ? pid === 12345 : scenario === 'creator' ? pid === process.pid : false })
    expect(result.retained).toContain(directory)
    await expect(fs.stat(directory)).resolves.toBeDefined()
  }
})

it('keeps shared immutable caches until every peer child in the run has exited', async () => {
  const options = await fixture()
  const root = runtimeTemporaryRoot(options.userDataPath, '0.15.12', 'shared-peers')
  const terminal = await createRuntimeTemporaryDirectory(root, 'goodbuddy-opencode-')
  const browser = await createRuntimeTemporaryDirectory(root, 'goodbuddy-native-dsh-')
  await recordRuntimeTemporaryChild(terminal, 12345)
  await recordRuntimeTemporaryChild(browser, 12346)
  const cache = join(root, 'host-v1-test', 'immutable.js')
  await fs.mkdir(join(root, 'host-v1-test'))
  await fs.writeFile(cache, 'shared host bundle')
  const first = await cleanupRuntimeTemporaryDirectories({ ...options, isProcessActive: pid => pid === 12346 })
  expect(first.removed).toContain(terminal)
  expect(first.retained).toContain(browser)
  expect(first.removed).not.toContain(root)
  expect(await fs.readFile(cache, 'utf8')).toBe('shared host bundle')
  expect((await cleanupRuntimeTemporaryDirectories(options)).removed).toContain(root)
  await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('recognizes native DS Web scratch and retains its live child without touching persistent homes', async () => {
  const options = await fixture()
  const root = runtimeTemporaryRoot(options.userDataPath, 'test', 'native-dsh')
  const directory = await createRuntimeTemporaryDirectory(root, 'goodbuddy-native-dsh-')
  await recordRuntimeTemporaryChild(directory, 12345)
  const history = join(options.userDataPath, 'native', 'dsh', 'session')
  await fs.mkdir(history, { recursive: true })
  await fs.writeFile(join(history, 'history'), 'retained')
  expect((await cleanupRuntimeTemporaryDirectories({ ...options, isProcessActive: pid => pid === 12345 })).retained).toContain(directory)
  expect((await cleanupRuntimeTemporaryDirectories(options)).removed).toContain(directory)
  expect(await fs.readFile(join(history, 'history'), 'utf8')).toBe('retained')
})

it('reclaims only legacy layouts with confirmed inactive ownership, never a prefix or age alone', async () => {
  const options = await fixture()
  const known = await createRuntimeTemporaryDirectory(options.legacyTempRoot, 'goodbuddy-opencode-')
  await recordRuntimeTemporaryChild(known, 12345)
  const old = join(options.legacyTempRoot, 'goodbuddy-continue-old')
  const unrelated = join(options.legacyTempRoot, 'goodbuddy-user-files')
  await fs.mkdir(old)
  await fs.mkdir(unrelated)
  const result = await cleanupRuntimeTemporaryDirectories(options)
  expect(result.removed).toEqual([known])
  expect(result.retained).toContain(old)
  await expect(fs.stat(unrelated)).resolves.toBeDefined()
})

it('keeps failed deletion discoverable for the next start and bounds traversal', async () => {
  const options = await fixture()
  const directory = await createRuntimeTemporaryDirectory(options.legacyTempRoot, 'goodbuddy-opencode-')
  await recordRuntimeTemporaryChild(directory, 12345)
  const originalRemove = fs.rm
  const remove = vi.spyOn(fs, 'rm').mockImplementationOnce(async () => {
    await originalRemove(directory, { recursive: true, force: true })
    await fs.mkdir(directory)
    throw new Error('partial deletion: directory still busy')
  })
  expect((await cleanupRuntimeTemporaryDirectories(options)).retained).toContain(directory)
  remove.mockRestore()
  expect((await cleanupRuntimeTemporaryDirectories({ ...options, maximumEntries: 0 })).removed).toEqual([])
  expect((await cleanupRuntimeTemporaryDirectories(options)).removed).toContain(directory)
})

it('does not infer inactivity when launch directory enumeration fails', async () => {
  const options = await fixture()
  const root = runtimeTemporaryRoot(options.userDataPath, '0.15.11', 'unreadable')
  const directory = await createRuntimeTemporaryDirectory(root, 'goodbuddy-opencode-')
  await recordRuntimeTemporaryChild(directory, 12345)
  const open = fs.opendir
  vi.spyOn(fs, 'opendir').mockImplementation((...args: Parameters<typeof fs.opendir>) => {
    if (args[0] === root) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
    return open(...args)
  })
  expect((await cleanupRuntimeTemporaryDirectories(options)).retained).toContain(root)
  await expect(fs.stat(directory)).resolves.toBeDefined()
})

it('leaves inactive material untouched when application shutdown cancels cleanup', async () => {
  const options = await fixture()
  const root = runtimeTemporaryRoot(options.userDataPath, '0.15.12', 'cancelled-cleanup')
  const directory = await createRuntimeTemporaryDirectory(root, 'goodbuddy-continue-')
  await recordRuntimeTemporaryChild(directory, 12345)
  const controller = new AbortController()
  controller.abort()
  expect(await cleanupRuntimeTemporaryDirectories({ ...options, signal: controller.signal })).toEqual({ removed: [], retained: [] })
  await expect(fs.stat(directory)).resolves.toBeDefined()
})
