import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { ControllerRegistry } from '../src/agent-daemon/controller-registry'
import { WorkspaceRegistry } from '../src/agent-daemon/workspace-registry'
import { WorkspaceGitService } from '../src/agent-daemon/workspace-git-service'
import { createWorkspaceProtocolMethods } from '../src/agent-daemon/workspace-protocol-methods'
import { RemoteWorkspaceAccess, type RemoteWorkspaceTransportLease } from '../src/main/workspace/remote-workspace-access'
import { importWorkspaceFiles } from '../src/main/workspace/workspace-import'

// Source-level Host probe: real workspace handlers over an SSH stdio test bridge.
// The bridge does not replace the separate production binary-framing tests.
if (process.argv[2] === '--host') {
  const root = await mkdtemp('/root/tmp/goodbuddy-workspace-import-')
  const controllers = new ControllerRegistry()
  const context = { controller: controllers.attach('workspace-import-probe'), channelId: 'workspace-import-probe' }
  const methods = createWorkspaceProtocolMethods({ workspaces: new WorkspaceRegistry({ controllers }), git: new WorkspaceGitService() })
  await mkdir(join(root, 'selected'))
  process.stdout.write(`${JSON.stringify({ root })}\n`)
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const { id, method, params } = JSON.parse(line)
      try {
        let result: unknown
        if (method === 'probe/verify') {
          const data = await readFile(join(root, 'selected/image.bin'))
          assert.equal(data.length, 700001)
          assert(data.every((byte, index) => byte === index % 256))
          const metadata = await stat(join(root, 'selected/image.bin'))
          result = { bytes: data.length, modifiedAt: metadata.mtime.toISOString(), createdAt: metadata.birthtimeMs > 0 ? metadata.birthtime.toISOString() : undefined }
        } else {
          assert(method in methods)
          result = await methods[method as keyof typeof methods](params, context)
        }
        process.stdout.write(`${JSON.stringify({ id, result })}\n`)
      } catch (error) { process.stdout.write(`${JSON.stringify({ id, error: String(error) })}\n`) }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
} else {
  const host = process.argv[2], remoteBundle = process.argv[3]
  assert(host && remoteBundle && /^\/root\/tmp\/[\w./-]+$/.test(remoteBundle), 'Expected SSH host and bundle in /root/tmp')
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', host,
    `TMPDIR=/root/tmp ELECTRON_RUN_AS_NODE=1 /opt/GoodBuddy/goodbuddy ${remoteBundle} --host`], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  let ready!: (root: string) => void
  const rootPromise = new Promise<string>(resolve => { ready = resolve })
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>()
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.root) ready(message.root)
    else { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result as never) }
  })
  let nextId = 0
  const request = <T>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1 }, 60000)
  const source = await mkdtemp(join(tmpdir(), 'goodbuddy-workspace-import-source-'))
  try {
    const root = await rootPromise
    const lease: RemoteWorkspaceTransportLease = {
      binding: { hostId: 'probe-host', hostRevision: 1, hostKeyGeneration: 1, remoteUsername: 'root', agentInstallationId: 'probe', agentBinaryDigest: `sha256:${'a'.repeat(64)}`, agentVersion: 'source', agentArchitecture: 'x64', agentProtocolMajor: 1, capabilityGeneration: 1 },
      validateWorkspace: params => request('workspace/validate', params), closeWorkspace: params => request('workspace/close', params),
      manageWorkspace: params => request('workspace/manage', params), listWorkspace: params => request('workspace/list', params),
      statWorkspace: params => request('workspace/stat', params), readWorkspaceText: params => request('workspace/readText', params),
      searchWorkspace: params => request('workspace/search', params), getGitStatus: params => request('git/status', params), getGitDiff: params => request('git/diff', params), release: () => {}
    }
    const access = new RemoteWorkspaceAccess({ hostId: 'probe-host', remoteRootPath: root }, { acquireLease: async () => lease })
    await writeFile(join(source, 'image.bin'), Buffer.alloc(700001).map((_, index) => index % 256))
    await writeFile(join(source, 'empty.txt'), '')
    const imported = await importWorkspaceFiles(access, 'selected', [join(source, 'image.bin'), join(source, 'empty.txt')])
    assert.deepEqual(imported, { imported: ['selected/image.bin', 'selected/empty.txt'], failed: [] })
    const duplicate = await importWorkspaceFiles(access, 'selected', [join(source, 'image.bin')])
    assert.equal(duplicate.failed.length, 1); assert.equal(duplicate.imported.length, 0)
    const verified = await request<{ bytes: number; modifiedAt: string; createdAt?: string }>('probe/verify', {})
    const listing = await access.listDirectory({ path: 'selected' })
    const image = listing.entries.find(entry => entry.name === 'image.bin')!
    assert.equal(image.modifiedAt, verified.modifiedAt); assert.equal(image.createdAt, verified.createdAt)
    assert.equal((await access.listDirectory({ path: '' })).entries.length, 1)
    await access.dispose()
    process.stdout.write(`${JSON.stringify({ passed: true, ...verified, imported: imported.imported, collisionPreserved: true, modelCalls: 0 })}\n`)
  } finally {
    child.stdin.end()
    await exited
    clearTimeout(timeout)
    await rm(source, { recursive: true, force: true })
  }
}
