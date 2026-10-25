// Isolated real-Host fixture: production protocol server, workspace registry and
// direct tools over an SSH stdio stream. The SSH session supplies authentication.
import { createConnection, createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ControllerRegistry } from './controller-registry'
import type { EventJournal } from './event-journal'
import { AgentProtocolServer } from './protocol-server'
import { WorkspaceRegistry } from './workspace-registry'
import { WorkspaceGitService } from './workspace-git-service'
import { createWorkspaceProtocolMethods } from './workspace-protocol-methods'
import { createDirectModelTools } from './direct-model-tools'
import { AGENT_PROTOCOL_VERSION } from '../shared/agent-protocol'

async function main(): Promise<void> {
  const root = process.argv[2]!
  if (!root.startsWith('/root/tmp/goodbuddy-direct-model-')) throw new Error('Expected dedicated test directory')
  await mkdir(root, { recursive: true })
  await mkdir(join(root, 'workspace'), { recursive: true })
  const controllers = new ControllerRegistry()
  const controller = controllers.attach('direct-model-validation')
  // Control-only fixture: no ACP frames or event journal operations occur.
  const events = {} as EventJournal
  const workspaces = new WorkspaceRegistry({ controllers, inspectGit: async () => 'not-a-repository' })
  const tools = createDirectModelTools(workspaces, root)
  const protocol = new AgentProtocolServer({ controllers, events, status: () => ({
    state: 'ready', installationId: 'direct-model-validation', binaryDigest: `sha256:${'a'.repeat(64)}`,
    daemonBootId: 'validation-boot', agentVersion: '0.16.10', protocol: AGENT_PROTOCOL_VERSION,
    platform: process.platform, architecture: process.arch, remoteUserIdentity: 'uid:0', supervisor: 'detached-on-demand', draining: false
  }), methods: { ...createWorkspaceProtocolMethods({ workspaces, git: new WorkspaceGitService() }), 'workspace/modelTools': tools.handler } })
  const server = createServer(socket => protocol.accept(socket, controller))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  const socket = createConnection(address.port, '127.0.0.1')
  let preface = Buffer.alloc(0)
  const handshake = (chunk: Buffer) => {
    preface = Buffer.concat([preface, chunk])
    if (preface.length < 4 || preface.length < 4 + preface.readUInt32BE(0)) return
    const length = preface.readUInt32BE(0)
    process.stdin.off('data', handshake)
    const welcome = Buffer.from(JSON.stringify({ type: 'goodbuddy-agent-welcome', protocol: AGENT_PROTOCOL_VERSION,
      connectionId: controller.connectionId, generation: controller.generation, installationId: 'direct-model-validation',
      binaryDigest: `sha256:${'a'.repeat(64)}`, daemonBootId: 'validation-boot', serverNonce: 'validation-nonce' }))
    const header = Buffer.alloc(4); header.writeUInt32BE(welcome.length)
    process.stdout.write(Buffer.concat([header, welcome]))
    socket.pipe(process.stdout)
    if (preface.length > length + 4) socket.write(preface.subarray(length + 4))
    process.stdin.pipe(socket)
  }
  process.stdin.on('data', handshake)
  await new Promise<void>(resolve => process.stdin.once('end', resolve))
  socket.destroy()
  server.close()
  await tools.dispose()
  workspaces.closeAll()
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
