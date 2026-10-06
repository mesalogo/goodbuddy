// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import type { RuntimeSessionBinding } from '../shared/remote-agent-contracts'
import {
  DesktopStorageRuntimeOwner, createDesktopRuntimeStorageAdapters,
  runtimeStorageMethods, type DesktopRuntimeStorageCall
} from './desktop-storage-runtime-operations'

const roots: string[] = []
const owners: DesktopStorageRuntimeOwner[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const base = join(process.cwd(), 'temp', 'goodbuddy-ledger-upgrade')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'owner-'))
  roots.push(root)
  const owner = await DesktopStorageRuntimeOwner.open(root)
  owners.push(owner)
  const call: DesktopRuntimeStorageCall = async (_domain, method, args) => {
    expect(runtimeStorageMethods).toContain(method)
    const operation = owner[method] as (...args: unknown[]) => unknown
    return structuredClone(await operation.apply(owner, structuredClone(args))) as never
  }
  return { root, owner, ...createDesktopRuntimeStorageAdapters(call) }
}

const claim = { callId: 'call', bindingId: 'binding', operationId: 'operation',
  promptSequence: 0, roundIndex: 0, profileDigest: 'profile', requestDigest: 'request' }

it('owns ledger uniqueness, transitions, close and restart uncertainty', async () => {
  const { root, owner, openModelCallLedger } = await fixture()
  const path = join(root, 'model-calls.sqlite')
  const ledger = await openModelCallLedger(path)
  await expect(openModelCallLedger(path)).rejects.toThrow('already has an owner')
  await ledger.claim(claim)
  await expect(ledger.claim(claim)).rejects.toMatchObject({ code: 'already-dispatched' })
  await ledger.complete(claim.callId)
  await expect(ledger.claim({ ...claim, callId: 'next', roundIndex: 1 })).rejects.toMatchObject({ code: 'conflict' })
  await ledger.delivered(claim.callId)
  await ledger.claim({ ...claim, callId: 'next', roundIndex: 1 })
  const firstClose = ledger.close()
  expect(ledger.close()).toBe(firstClose)
  await firstClose
  await expect(ledger.get(claim.callId)).rejects.toThrow('not open')
  const reopened = await openModelCallLedger(path)
  expect(await reopened.get(claim.callId)).toMatchObject({ status: 'completed', response_delivered: 1 })
  expect(await reopened.get('next')).toMatchObject({ status: 'outcome-unknown' })
  owner.close()
  await expect(reopened.get('next')).rejects.toThrow('not open')
  await expect(openModelCallLedger(path)).rejects.toThrow('closed')
})

it('reuses the binding interface and persists atomic claims, rotation and cursors', async () => {
  const { root, owner, bindingStore: store } = await fixture()
  const digest = `sha256:${'a'.repeat(64)}`
  const binding: RuntimeSessionBinding = {
    bindingId: 'binding', controllerId: 'controller', controllerGeneration: 1,
    conversationId: 'conversation', hostId: 'host', hostRevision: 1, hostKeyGeneration: 1,
    workspaceIdentity: 'workspace', agentInstallationId: 'installation', daemonBootIdAtOpen: 'boot',
    runtimeId: 'runtime', runtimeBundleDigest: digest, runtimeAdapterDigest: digest,
    acpSessionId: 'opening', acpCapabilitiesDigest: digest, state: 'opening', promptSequence: 0,
    channelEpoch: '1', lastOutboundJournaledSequence: '0', lastOutboundDeliveredSequence: '0',
    lastInboundJournaledSequence: '0', lastMainAckSequence: '0'
  }
  await store.put(binding)
  await store.put({ ...binding, bindingId: 'peer', conversationId: 'peer', acpSessionId: 'peer-opening' })
  const results = await Promise.allSettled([
    store.claimAcpSession('binding', 'session'), store.claimAcpSession('peer', 'session')
  ])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  const claimed = (await store.getById('binding'))!
  await store.put({ ...claimed, state: 'ready', lastInboundJournaledSequence: '5', lastMainAckSequence: '5' })
  await expect(store.put({ ...claimed, state: 'ready' })).rejects.toMatchObject({ code: 'runtime-session-binding-conflict' })
  const rotated = await store.rotateTransport('binding', binding, { controllerGeneration: 2, daemonBootIdAtOpen: 'next-boot', channelEpoch: '2' })
  expect(rotated).toMatchObject({ acpSessionId: 'session', lastMainAckSequence: '0', channelEpoch: '2' })
  owner.close()
  const reopened = await DesktopStorageRuntimeOwner.open(root)
  owners.push(reopened)
  expect(await reopened.getByConversation('conversation')).toEqual(rotated)
  expect(await reopened.listByController('controller', { limit: 1 })).toHaveLength(1)
  await reopened.put({ ...rotated, state: 'closed' })
  expect(await reopened.pruneClosed()).toBe(1)
})

it('routes the native loopback gateway through the real Electron storage transport and closes before deleting files', async () => {
  const { root, owner } = await fixture()
  owner.close()
  await build({ entryPoints: [join(process.cwd(), 'src/main/desktop-storage-runtime-host-fixture.ts')],
    outfile: join(root, 'host.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  await build({ entryPoints: [join(process.cwd(), 'src/main/desktop-storage-runtime-fixture.ts')],
    outfile: join(root, 'fixture.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent',
    banner: { js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url);' } })
  const env: NodeJS.ProcessEnv = { ...process.env, GB_RUNTIME_STORAGE_TEST_ROOT: root, TEMP: root, TMP: root, TMPDIR: root }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [join(root, 'fixture.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill(), 30_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
    expect(code, output).toBe(0)
    expect(output).toContain('desktop-runtime-storage-electron: passed')
  } finally { clearTimeout(timeout) }
}, 45_000)
