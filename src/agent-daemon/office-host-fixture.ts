import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentDaemon } from './daemon'
import { createLinuxPeerIdentityProvider } from './peer-identity-provider'
import { attachRelay } from './private-endpoint'
import { AGENT_PROTOCOL_VERSION } from '../shared/agent-protocol'

async function main(): Promise<void> {
  const root = process.argv[2]!
  const stateDirectory = join(root, 'state')
  const socketPath = join(root, 'agent.sock')
  const daemon = new AgentDaemon({ installationId: 'office-host-test', binaryDigest: `sha256:${'a'.repeat(64)}`,
    agentVersion: '0.16.10', protocol: AGENT_PROTOCOL_VERSION, stateDirectory, socketPath,
    peerIdentityProvider: await createLinuxPeerIdentityProvider() })
  await daemon.start()
  try {
    await attachRelay({ socketPath, secret: readFileSync(join(stateDirectory, 'installation-identity')),
      input: process.stdin, output: process.stdout })
  } finally { await daemon.stop() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
