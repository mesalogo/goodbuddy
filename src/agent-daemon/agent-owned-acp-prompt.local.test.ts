// @vitest-environment node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentOwnedAcpPrompt } from './agent-owned-acp-prompt'
import { SemanticPromptStore } from './semantic-prompt-store'
import { ModelBridgeLoopbackProxy, createOpenCodeModelBridgeProviderConfig } from './model-bridge-helper'
import type { RuntimeAcpProcessOwner } from './runtime-acp-backend'

const binary = join(process.cwd(), '.runtime-resources', process.arch, process.platform === 'win32' ? 'opencode.exe' : 'opencode')

it.skipIf(!existsSync(binary))('keeps a real OpenCode answer completed after a delayed ACK and cleanup error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-acp-completion-'))
  const transcript = new SemanticPromptStore(join(root, 'prompts.sqlite'))
  let releaseAck!: () => void
  const ack = new Promise<void>(resolve => { releaseAck = resolve })
  let enteredCompletion!: () => void
  const completion = new Promise<void>(resolve => { enteredCompletion = resolve })
  let requests = 0
  let acknowledged = false
  const body = [
    ...[{ role: 'assistant', content: 'ACK_OK' }, {}].map((delta, index) => `data: ${JSON.stringify({
      id: 'local-ack', object: 'chat.completion.chunk', created: 1, model: 'local-ack',
      choices: [{ index: 0, delta, finish_reason: index === 1 ? 'stop' : null }]
    })}\n\n`), 'data: [DONE]\n\n'
  ].join('')
  const proxy = new ModelBridgeLoopbackProxy({ exchange: async () => {
    if (++requests > 1) throw new Error('Unexpected extra model request')
    return {
      response: { status: 200, headers: { 'content-type': 'text/event-stream' }, bodyBase64: Buffer.from(body).toString('base64') },
      acknowledgeDelivery: async () => { await ack; acknowledged = true },
      failDelivery: () => { throw new Error('Unexpected failed delivery') }
    }
  } })
  const origin = await proxy.listen()
  const child = spawn(binary, ['acp'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
      TEMP: root, TMP: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_CONFIG_DIR: join(process.cwd(), '.runtime-resources', 'opencode-config'),
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_SHARE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(createOpenCodeModelBridgeProviderConfig({
        protocol: 'openai-chat-completions', model: 'local-ack', loopbackOrigin: origin, workMode: 'ask'
      }))
    }
  })
  child.stderr.resume()
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  const processOwner = {
    writeStdin: (payload: Uint8Array) => new Promise<void>((resolve, reject) => child.stdin.write(payload, error => error ? reject(error) : resolve())),
    subscribeOutput: (listener: Parameters<RuntimeAcpProcessOwner['subscribeOutput']>[0]) => {
      const onData = (data: Buffer) => { void listener({ stream: 'stdout', data }) }
      child.stdout.on('data', onData)
      return () => { child.stdout.off('data', onData) }
    },
    subscribeExit: (listener: () => void) => { child.on('close', listener); return () => { child.off('close', listener) } }
  } as RuntimeAcpProcessOwner
  const owner = new AgentOwnedAcpPrompt({
    bindingId: 'binding', controllerId: 'controller', workspaceDirectory: root, process: processOwner, transcript,
    completePrompt: async (_operation, _status, _response, commitTerminal) => {
      enteredCompletion()
      await ack
      commitTerminal()
      throw new Error('Simulated post-terminal cleanup failure')
    }
  })
  let timer: NodeJS.Timeout | undefined
  try {
    transcript.prepare({ bindingId: 'binding', operationId: 'operation', requestId: 'operation', controllerId: 'controller',
      preparationDigest: `sha256:${'a'.repeat(64)}`, promptSequence: 0 })
    await Promise.race([
      (async () => {
        await owner.start({ bindingId: 'binding', operationId: 'operation', requestId: 'operation',
          prompt: [{ type: 'text', text: 'Reply ACK_OK without using tools.' }] }, 'ask')
        await completion
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Local ACP completion timed out')), 20_000) })
    ])
    const page = () => transcript.page({ bindingId: 'binding', operationId: 'operation', controllerId: 'controller', afterSequence: '0', limit: 128 })
    expect(acknowledged).toBe(false)
    expect(page().state).toBe('running')
    expect(JSON.stringify(page().events)).toContain('ACK_OK')
    releaseAck()
    await expect.poll(() => page().state).toBe('completed')
    await expect.poll(() => acknowledged).toBe(true)
    expect(page().events.filter(event => event.kind === 'prompt-terminal')).toMatchObject([
      { payload: { status: 'completed', response: { stopReason: 'end_turn' } } }
    ])
    expect(requests).toBe(1)
  } finally {
    clearTimeout(timer)
    releaseAck()
    owner.close()
    child.kill()
    await exited
    await proxy.close()
    transcript.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
