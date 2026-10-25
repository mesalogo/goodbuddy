// Run the bundled current source on the shared Linux Host. The pipe adapter
// replaces only SSH exec; attach authentication, framing, daemon, controller
// resume and connection pooling are the production implementations.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, readdir, readlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentDaemon } from '../src/agent-daemon/daemon'
import { createProductionRuntimeProtocol } from '../src/agent-daemon/runtime-composition'
import { RuntimeBundleRegistry } from '../src/agent-daemon/runtime-bundle-registry'
import { SemanticPromptStore } from '../src/agent-daemon/semantic-prompt-store'
import { RuntimeOwnerRegistry } from '../src/agent-daemon/runtime-owner-registry'
import { attachRelay } from '../src/agent-daemon/private-endpoint'
import { createLinuxPeerIdentityProvider } from '../src/agent-daemon/peer-identity-provider'
import { readPrivateSecret } from '../src/agent-daemon/managed-paths'
import { AGENT_PROTOCOL_VERSION } from '../src/shared/agent-protocol'
import { ControllerStateStore, JsonControllerStateFile } from '../src/main/remote-agent/controller-state-store'
import { RemoteAgentConnectionManager } from '../src/main/remote-agent/remote-agent-connection-manager'
import { recoverRemoteTaskWithRetry } from '../src/main/remote-agent/remote-task-recovery'
import { verifyAgentInstallationId } from '../src/main/ssh/ssh-agent-command'
import type { SshConnectionLease, SshConnectionPoolTarget } from '../src/main/ssh/ssh-connection-pool'

async function main(): Promise<void> {
  assert.equal(process.platform, 'linux')
  if (process.argv[2] === '--relay') {
    const root = process.argv[3]!
    await attachRelay({ socketPath: join(root, 'agent.sock'), secret: readPrivateSecret(join(root, 'state/installation-identity')), input: process.stdin, output: process.stdout })
    return
  }
  const peerIdentityProvider = await createLinuxPeerIdentityProvider({ loadKoffi: async () => createRequire(process.argv[1]!)('koffi') })
  const root = await mkdtemp('/root/tmp/goodbuddy-recovery-validation/run-')
  const runtimeCrash = process.argv[2] === '--runtime-crash'
  const retirement = process.argv[2] === '--retirement' || runtimeCrash
  const directRetirement = process.argv[2] === '--direct-retirement'
  const directDisconnect = process.argv[2] === '--direct-disconnect'
  const directShutdown = process.argv[2] === '--direct-shutdown'
  let superseded = false
  const runtimeRoot = process.env.GB_PROBE_RUNTIME_ROOT
  const agentExecutablePath = process.env.GB_PROBE_AGENT_EXECUTABLE
  if (retirement) assert(runtimeRoot && agentExecutablePath, 'Expected installed runtime root and Agent helper executable')
  const installation = { installationId: verifyAgentInstallationId('recovery-probe'), binaryDigest: `sha256:${'a'.repeat(64)}`, agentVersion: '1.0.0', protocol: AGENT_PROTOCOL_VERSION, platform: 'linux' as const, architecture: 'x64' as const, supervisor: 'detached-on-demand' as const, requiredCapabilities: [] }
  const daemon = new AgentDaemon({ ...installation, stateDirectory: join(root, 'state'), socketPath: join(root, 'agent.sock'), peerIdentityProvider,
    ...(directRetirement || directDisconnect || directShutdown ? { isSuperseded: () => superseded } : {}),
    ...(retirement ? {
      isSuperseded: () => superseded,
      runtimeFactory: async context => createProductionRuntimeProtocol({ ...context, runtimeRoot: runtimeRoot!, stateDirectory: join(root, 'state'), architecture: 'x64', agentExecutablePath, installationId: installation.installationId })
    } : {})
  })
  const target = { host: { id: 'probe-host', hostname: 'localhost', port: 22, username: 'root', authentication: 'password', password: 'pipe-adapter-no-ssh-credentials', hostKey: { generation: 1, algorithm: 'ssh-ed25519', publicKeyBase64: 'cHJvYmU=' } }, hostRevision: 1, hostKeyGeneration: 1 } as unknown as SshConnectionPoolTarget
  const children: ReturnType<typeof spawn>[] = []
  let unavailable = false
  let attaches = 0
  const controllerState = new ControllerStateStore(new JsonControllerStateFile(join(root, 'desktop-controller.json')))
  const manager = new RemoteAgentConnectionManager({
    resolver: { resolve: async () => target },
    controllerState,
    goodBuddyVersion: '0.16.10', idleTimeoutMs: 60_000,
    sshPool: {
      disposeHost: async () => {},
      acquire: async () => {
        if (unavailable) throw new Error('injected network outage')
        return {
          release: () => {}, isUsable: () => true,
          openAgentAttach: async () => {
            attaches++
            const child = spawn(process.execPath, [process.argv[1]!, '--relay', root], { stdio: ['pipe', 'pipe', 'pipe'] })
            children.push(child)
            const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! })
            Object.assign(stream, { stderr: child.stderr, close: () => child.kill() })
            child.once('close', () => stream.destroy())
            child.once('error', error => stream.destroy(error))
            return stream
          }
        } as unknown as SshConnectionLease
      }
    }
  })
  try {
    await daemon.start()
    const first = await manager.acquire('probe-host', installation)
    if (directRetirement || directDisconnect || directShutdown) {
      const request = <T>(method: string, params: unknown) => first.client.request(method as never, params) as Promise<T>
      const { handle } = await request<{ handle: { workspaceId: string; generation: number } }>('workspace/validate', { remoteRootPath: root, requestedAccess: 'read-write', requiredCapabilities: [] })
      const callId = randomUUID()
      const invoke = (action: unknown) => request<import('../src/shared/remote-model-tools-contracts').RemoteModelToolsResult>('workspace/modelTools', { workspaceId: handle.workspaceId, generation: handle.generation, action })
      let retired = false
      void daemon.retired.then(() => { retired = true })
      if (directRetirement) {
        const result = await invoke({ kind: 'call', callId, name: 'process_execute', arguments: { command: "printf '%120000s' x; printf tail" } })
        assert.equal(result.kind, 'result')
        if (result.kind !== 'result') throw new Error('Expected tool output')
        const output = result.result.outputReferences![0]!
        superseded = true
        await delay(750)
        assert.equal(retired, false, 'Completed direct output must survive until release')
        await assert.rejects(invoke({ kind: 'call', callId: randomUUID(), name: 'process_execute', arguments: { command: 'echo unexpected > should-not-exist' } }), /draining/)
        let cursor = 0, copied = ''
        while (cursor < output.totalBytes) {
          const page = await invoke({ kind: 'read', callId, handle: output.handle, cursor })
          assert.equal(page.kind, 'page')
          if (page.kind !== 'page') throw new Error('Expected output page')
          copied += page.page.content
          cursor = page.page.nextCursor
        }
        assert.equal(Buffer.byteLength(copied), output.totalBytes)
        assert(copied.endsWith('tail'))
        await invoke({ kind: 'release', callId })
      } else {
        const pending = invoke({ kind: 'call', callId, name: 'process_execute', arguments: { command: 'echo $$ > parent.pid; sleep 60 & echo $! > child.pid; wait; echo unexpected > should-not-exist' } })
          .then(() => false, () => true)
        let pids: number[] = []
        for (let i = 0; i < 100; i++) {
          try { pids = [Number(await readFile(join(root, 'parent.pid'), 'utf8')), Number(await readFile(join(root, 'child.pid'), 'utf8'))]; if (pids.every(pid => pid > 0)) break } catch { /* waiting for the test process */ }
          await delay(50)
        }
        assert.equal(pids.length, 2)
        superseded = true
        await delay(500)
        assert.equal(retired, false, 'Active direct command must block retirement')
        if (directShutdown) await daemon.stop()
        else children.at(-1)!.kill()
        assert.equal(await pending, true)
        for (let i = 0; !directShutdown && !retired && i < 100; i++) await delay(50)
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/)
      }
      for (let i = 0; !directShutdown && !retired && i < 100; i++) await delay(50)
      if (!directShutdown) assert.equal(retired, true)
      assert(!(await readdir(root)).includes('should-not-exist'))
      assert(!(await readdir(join(root, 'state'))).some(name => name.startsWith('model-tools-')))
      first.release()
      await daemon.stop()
      process.stdout.write(`${JSON.stringify({ passed: true, directRetirement, directDisconnect, directShutdown, realProcessTree: true, outputCleanup: true, externalModelCalls: 0 })}\n`)
      return
    }
    if (retirement) {
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.flushHeaders()
        // Keep this local deterministic model call open until cancellation.
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        assert(address && typeof address !== 'string')
        const runtime = first.capabilities.runtimes.find(runtime => runtime.runtimeId === 'opencode')
        assert(runtime, 'Installed OpenCode runtime must be advertised')
        const registered = new RuntimeBundleRegistry({ runtimeRoot: runtimeRoot! }).resolve(runtime.runtimeId, runtime.bundleDigest, 'x64')
        const request = <T>(method: string, params: unknown) => first.client.request(method as never, params) as Promise<T>
        const workspace = await request<{ handle: { workspaceIdentity: string } }>('workspace/validate', { remoteRootPath: root, requestedAccess: 'read-write', requiredCapabilities: [] })
        const channel = await request<{ channelEpoch: string }>('runtime/openAcpChannel', { bindingId: 'retirement-binding', runtimeId: runtime.runtimeId, runtimeBundleDigest: runtime.bundleDigest, workspaceIdentity: workspace.handle.workspaceIdentity })
        const controllerId = await controllerState.getControllerId()
        await request('runtime/preparePrompt', {
          bindingId: 'retirement-binding', operationId: 'retirement-operation', requestId: 'retirement-operation',
          controllerId, controllerGeneration: first.client.generation, connectionGeneration: first.client.generation,
          channelEpoch: channel.channelEpoch, hostId: 'probe-host', hostRevision: 1, hostKeyGeneration: 1,
          workspaceIdentity: workspace.handle.workspaceIdentity, agentInstallationId: installation.installationId,
          runtimeId: runtime.runtimeId, runtimeBundleDigest: runtime.bundleDigest, runtimeAdapterDigest: registered.entry.runtimeAdapterDigest,
          modelProfile: { profileId: 'local-probe', modelProfileDigest: `sha256:${'b'.repeat(64)}`, provider: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'probe-model', protocol: 'openai-chat-completions', authentication: 'none', capabilities: { imageInput: false }, limits: { maximumOutputTokens: 16, requestTimeoutMilliseconds: 60_000 } },
          promptSequence: 0, deadlineAt: new Date(Date.now() + 60_000).toISOString(), budget: { maximumInputBytes: 4096, maximumOutputBytes: 4096 }
        })
        const started = await request<{ sessionId: string }>('runtime/startPrompt', { bindingId: 'retirement-binding', operationId: 'retirement-operation', requestId: 'retirement-operation', prompt: [{ type: 'text', text: 'Reply OK.' }] })
        if (runtimeCrash) {
          const owners = new RuntimeOwnerRegistry(join(root, 'state/runtime-owners.sqlite'))
          try {
            const entries = owners.listForInstallation(installation.installationId)
            assert.equal(entries.length, 1)
            const identity = entries[0]!.processIdentity!
            assert(identity?.pid > 0)
            assert.equal(await readlink(`/proc/${identity.pid}/cwd`), root)
            process.kill(identity.pid, 'SIGKILL')
          } finally { owners.close() }
          let terminal = false
          for (let i = 0; !terminal && i < 100; i++) {
            const page = await request<{ state: string }>('runtime/pagePromptTranscript', { bindingId: 'retirement-binding', operationId: 'retirement-operation', afterSequence: '0', limit: 100 })
            terminal = page.state === 'failed' || page.state === 'outcome-unknown'
            if (!terminal) await delay(50)
          }
          assert(terminal, 'Runtime crash must produce a non-success terminal')
        } else {
          await request('runtime/escalateCancellation', { bindingId: 'retirement-binding', operationId: 'retirement-operation', requestId: 'retirement-operation', sessionId: started.sessionId, reason: 'requested' })
        }
        let retired = false
        void daemon.retired.then(() => { retired = true })
        superseded = true
        await delay(750)
        assert.equal(retired, false, 'Live Desktop must retain time to ACK')
        children.at(-1)!.kill()
        for (let i = 0; !retired && i < 100; i++) await delay(50)
        assert.equal(retired, true, 'Disconnected cancelled binding must not block retirement')
        await daemon.stop()
        const retained = new SemanticPromptStore(join(root, 'state/semantic-prompts.sqlite'))
        try {
          const page = retained.page({ bindingId: 'retirement-binding', operationId: 'retirement-operation', controllerId, afterSequence: '0', limit: 100 })
          if (runtimeCrash) assert(['failed', 'outcome-unknown'].includes(page.state))
          else assert.equal(page.state, 'cancelled')
          assert(page.events.some(event => event.kind === 'prompt-terminal'))
          assert(BigInt(page.latestSequence) > BigInt(page.acknowledgedSequence))
        } finally { retained.close() }
        process.stdout.write(`${JSON.stringify({ passed: true, retirement: true, runtimeCrash, realRuntime: runtime.runtimeId, cancelledBeforeDisconnect: !runtimeCrash, waitsForConnectedDesktop: true, retiresAfterDisconnect: true, transcriptSurvivesDaemonStop: true, externalModelCalls: 0 })}\n`)
      } finally {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      first.release()
      return
    }
    const boot = first.status.daemonBootId
    const generation = first.client.generation
    children.at(-1)!.kill()
    for (let i = 0; first.state === 'ready' && i < 100; i++) await delay(10)
    assert.equal(first.state, 'offline')
    unavailable = true
    let retries = 0
    await recoverRemoteTaskWithRetry(async () => {
      const next = await manager.acquire('probe-host', installation)
      assert.equal(next.status.daemonBootId, boot)
      assert(next.client.generation > generation)
      assert.equal(first.client, next.client)
      const status = await next.client.request('agent/status', {})
      assert.equal((status as { state: string }).state, 'ready')
      next.release()
    }, AbortSignal.timeout(15_000), () => { retries++; unavailable = false })
    assert.equal(retries, 1)
    assert.equal(attaches, 2)
    first.release()
    process.stdout.write(`${JSON.stringify({ passed: true, platform: process.platform, architecture: process.arch, relayDisconnect: true, retryAfterOutage: true, retainedLeaseRecovered: true, attaches, retries, modelCalls: 0 })}\n`)
  } finally {
    await manager.dispose()
    for (const child of children) child.kill()
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
