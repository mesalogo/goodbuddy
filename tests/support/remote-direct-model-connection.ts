import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import type { ClientChannel } from 'ssh2'
import { AgentAttachTransport } from '../../src/main/remote-agent/agent-attach-transport'
import { AgentProtocolClient } from '../../src/main/remote-agent/agent-protocol-client'
import { ProtocolRemoteWorkspaceTransport } from '../../src/main/remote-agent/protocol-remote-workspace-transport'
import type { RemoteAgentConnection } from '../../src/main/remote-agent/remote-agent-connection-manager'
import { verifyAgentInstallationId } from '../../src/main/ssh/ssh-agent-command'
import { RemoteWorkspaceAccess } from '../../src/main/workspace/remote-workspace-access'
import { AGENT_PROTOCOL_VERSION } from '../../src/shared/agent-protocol'

const exec = promisify(execFile)
export async function connectDirectModelTestHost(host: string, node: string) {
  const parent = resolve('temp/remote-direct-model')
  await mkdir(parent, { recursive: true })
  const local = await mkdtemp(join(parent, 'run-'))
  const remote = `/root/tmp/goodbuddy-direct-model-${randomUUID()}`
  let child: ReturnType<typeof spawn> | undefined
  let attach: AgentAttachTransport | undefined
  let workspace: RemoteWorkspaceAccess | undefined
  let stderr = ''
  const close = async () => {
    await workspace?.dispose().catch(() => undefined)
    attach?.dispose()
    child?.stdin?.end()
    if (child && child.exitCode === null) await new Promise<void>(resolve => {
      child!.once('exit', () => resolve())
      setTimeout(() => { child!.kill(); resolve() }, 5000).unref()
    })
    await exec('ssh', ['-o', 'BatchMode=yes', host, `rm -rf -- '${remote}'`])
    await rm(local, { recursive: true, force: true })
  }
  try {
    const script = join(local, 'host.cjs')
    await build({ entryPoints: ['src/agent-daemon/direct-model-tools.live-fixture.ts'], outfile: script, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
    await exec('ssh', ['-o', 'BatchMode=yes', host, `test -d /root/tmp && mkdir -m 700 '${remote}'`])
    await exec('scp', [script, `${host}:${remote}/host.cjs`])
    child = spawn('ssh', ['-o', 'BatchMode=yes', host, `'${node}' '${remote}/host.cjs' '${remote}'`], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr!.on('data', data => { stderr += String(data) })
    const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! } as unknown as Parameters<typeof Duplex.from>[0]) as Duplex & { stderr: typeof child.stderr }
    channel.stderr = child.stderr
    const installationId = verifyAgentInstallationId('direct-model-validation')
    attach = await AgentAttachTransport.connect({ installationId,
      sshLease: { openAgentAttach: async () => channel as unknown as ClientChannel },
      preface: { type: 'goodbuddy-agent-attach', protocol: AGENT_PROTOCOL_VERSION, goodBuddyVersion: '0.16.10',
        controllerId: 'direct-model-validation', clientNonce: 'validation-client', hostRevision: 1, hostKeyGeneration: 1 } })
    const client = new AgentProtocolClient(attach)
    const capabilities = await client.request('agent/capabilities', {})
    const status = await client.request('agent/status', {})
    const connection = { client, state: 'ready', status, capabilities,
      identity: { hostId: 'host-test', hostRevision: 1, hostKeyGeneration: 1, remoteUsername: 'root',
        installationId, binaryDigest: status.binaryDigest, protocolMajor: AGENT_PROTOCOL_VERSION.major, protocolMinor: AGENT_PROTOCOL_VERSION.minor },
      release: () => {} } as unknown as RemoteAgentConnection
    const transport = new ProtocolRemoteWorkspaceTransport({ acquire: async () => connection }, {
      resolve: async () => ({ installation: { installationId, binaryDigest: status.binaryDigest, agentVersion: '0.16.10', platform: 'linux', supervisor: 'detached-on-demand', architecture: 'x64', protocol: AGENT_PROTOCOL_VERSION } })
    })
    workspace = new RemoteWorkspaceAccess({ hostId: 'host-test', remoteRootPath: `${remote}/workspace` }, transport)
    return { local, remote, workspace, capabilities, close }
  } catch (error) {
    await close()
    throw new Error(`Remote direct-model fixture failed${stderr ? `: ${stderr}` : ''}`, { cause: error })
  }
}
