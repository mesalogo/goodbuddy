// @vitest-environment node
import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import { AgentAttachTransport } from '../src/main/remote-agent/agent-attach-transport'
import { AgentProtocolClient } from '../src/main/remote-agent/agent-protocol-client'
import { verifyAgentInstallationId } from '../src/main/ssh/ssh-agent-command'
import { AGENT_PROTOCOL_VERSION } from '../src/shared/agent-protocol'

it.skipIf(process.platform !== 'linux')('commits binary Office data through the real authenticated Host protocol and rejects stale writes', async () => {
  await mkdir(resolve('temp'), { recursive: true })
  const root = await mkdtemp(resolve('temp/office-host-'))
  const bundle = join(root, 'host.cjs')
  await build({ entryPoints: ['src/agent-daemon/office-host-fixture.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['koffi'], outfile: bundle })
  const child = spawn(process.execPath, [bundle, root], { stdio: ['pipe', 'pipe', 'pipe'] })
  let diagnostic = ''
  child.stderr.on('data', chunk => { diagnostic += String(chunk) })
  let transport: AgentAttachTransport | undefined
  try {
    const channel = Object.assign(Duplex.from({ readable: child.stdout, writable: child.stdin } as unknown as Parameters<typeof Duplex.from>[0]), { stderr: child.stderr }) as ClientChannel
    channel.on('error', (error: unknown) => { diagnostic += String(error) })
    transport = await AgentAttachTransport.connect({
      installationId: verifyAgentInstallationId('office-host-test'),
      sshLease: { openAgentAttach: async () => channel },
      preface: { type: 'goodbuddy-agent-attach', protocol: AGENT_PROTOCOL_VERSION, goodBuddyVersion: '0.16.10', controllerId: 'office-test-controller', clientNonce: 'office-test-nonce', hostRevision: 1, hostKeyGeneration: 1 }
    })
    const client = new AgentProtocolClient(transport)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const original = Buffer.from('original Office file')
    const output = Buffer.alloc(500000, 213)
    await writeFile(join(workspace, 'source.docx'), original)
    const validated = await client.request('workspace/validate', { remoteRootPath: workspace, requestedAccess: 'read-write', requiredCapabilities: [] })
    const handle = { workspaceId: validated.handle.workspaceId, generation: validated.handle.generation }
    const staged = '.goodbuddy-office-test.docx'
    await client.request('workspace/manage', { ...handle, action: { kind: 'createFile', path: staged } })
    for (let offset = 0; offset < output.length; offset += 256 * 1024) {
      await client.request('workspace/manage', { ...handle, action: { kind: 'importFile', path: staged, offset, data: output.subarray(offset, offset + 256 * 1024).toString('base64') } })
    }
    const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
    await expect(client.request('workspace/manage', { ...handle, action: { kind: 'replaceFile', path: staged, destination: 'source.docx', expectedDigest: '0'.repeat(64), digest: digest(output), maximumBytes: 20971520 } })).rejects.toThrow()
    expect(await readFile(join(workspace, 'source.docx'))).toEqual(original)
    await client.request('workspace/manage', { ...handle, action: { kind: 'replaceFile', path: staged, destination: 'source.docx', expectedDigest: digest(original), digest: digest(output), maximumBytes: 20971520 } })
    expect(await readFile(join(workspace, 'source.docx'))).toEqual(output)
  } catch (error) {
    throw new Error(`${String(error)}\n${diagnostic}`)
  } finally {
    transport?.dispose()
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
