// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { connectDirectModelTestHost } from './support/remote-direct-model-connection'
import { RemoteModelTools } from '../src/main/remote-agent/remote-model-tools'
import { createAgentRuntime } from '../src/main/agent/create-runtime'
import { defaultRuntimeSettings } from '../src/shared/contracts'
import type { ResolvedRuntimeSettings } from '../src/main/runtime-settings-store'
import type { PagedOutputBackingStore } from '../src/main/agent/paged-output-store'
import type { RuntimeEvent } from '../src/main/agent/runtime'
import { SubagentScheduler } from '../src/main/assistant/subagent-scheduler'
it.skipIf(!process.env.GB_DIRECT_MODEL_HOST || !process.env.GB_DIRECT_MODEL_HOST_NODE)('runs direct-model file, search, process, long output and cancellation paths on the real Host', async () => {
  const host = process.env.GB_DIRECT_MODEL_HOST!
  const node = process.env.GB_DIRECT_MODEL_HOST_NODE!
  const { local, remote, workspace, capabilities, close } = await connectDirectModelTestHost(host, node)
  try {
    expect(capabilities.capabilities).toContainEqual({ name: 'workspace/model-tools', version: 1, critical: false })
    const stored = new Map<string, Buffer>()
    const backingStore: PagedOutputBackingStore = {
      create: async (_owner, handle) => { stored.set(handle, Buffer.alloc(0)) },
      append: async (_owner, handle, bytes) => { stored.set(handle, Buffer.concat([stored.get(handle)!, bytes])) },
      finish: async () => {}, read: async (_owner, handle, cursor, length) => stored.get(handle)!.subarray(cursor, cursor + length),
      release: async (_owner, handle) => { stored.delete(handle) }
    }
    const remoteTools = new RemoteModelTools(workspace, { outputStore: { backingStore } })
    expect((await remoteTools.listTools(new AbortController().signal)).map(tool => tool.name).sort())
      .toEqual(['process_execute', 'workspace_apply_patch', 'workspace_read_text', 'workspace_rg'])
    const context = { conversationId: randomUUID(), runtimeTarget: 'model' as const }
    const run = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => remoteTools.callTool(name, args, signal, context)
    const text = (result: Awaited<ReturnType<typeof run>>) => result.parts.map(part => part.type === 'text' ? part.text : '').join('\n')
    const tool = (name: string, args: unknown) => ({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
    const responses = [
      tool('workspace_apply_patch', { patch: '*** Begin Patch\n*** Add File: example.txt\n+remote-parity\n*** End Patch' }),
      tool('workspace_read_text', { path: 'example.txt' }),
      tool('workspace_rg', { args: ['remote-parity', 'example.txt'] }),
      tool('process_execute', { command: 'pwd' }),
      tool('subagent_delegate', { task: 'Create child.txt with the inherited remote command tool' }),
      tool('process_execute', { command: 'printf inherited-remote > child.txt' }),
      { choices: [{ message: { role: 'assistant', content: 'child complete' } }] },
      { choices: [{ message: { role: 'assistant', content: 'verified' } }] }
    ]
    let calls = 0
    const profile = { id: randomUUID(), name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', modelName: 'fixture', protocol: 'openai-chat-completions' as const, authentication: 'none' as const, apiKey: '' }
    const runtime = createAgentRuntime(local, { ...defaultRuntimeSettings, provider: 'model', modelProfiles: [profile], defaultModelProfileId: profile.id } as ResolvedRuntimeSettings, {
      executionSpace: { kind: 'ssh', hostId: 'host-test', remoteRootPath: `${remote}/workspace`, cacheIdentity: remote, routeIdentity: remote, workspaceAccess: workspace },
      directModelSubagentScheduler: new SubagentScheduler({ concurrency: 1, queueLimit: 2, timeoutMs: 30000 }),
      remoteModelTools: remoteTools, outputStore: { backingStore }, modelFetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body))
        expect(request.tools.map((entry: { function: { name: string } }) => entry.function.name)).toContain('workspace_apply_patch')
        calls++
        return Response.json(responses.shift())
      }
    })
    const events: RuntimeEvent[] = []
    for await (const event of runtime.run({ requestId: randomUUID(), projectId: randomUUID(), conversationId: context.conversationId, prompt: 'Run the remote fixture' }, new AbortController().signal)) events.push(event)
    expect(events.filter(event => event.type === 'error')).toEqual([])
    expect(events.filter(event => event.type === 'tool' && event.state === 'failed')).toEqual([])
    expect(calls).toBe(8)
    expect(events.some(event => event.type === 'subagent' && event.state === 'completed')).toBe(true)
    expect(text(await run('workspace_read_text', { path: 'child.txt' }))).toContain('inherited-remote')
    expect(text(await run('workspace_read_text', { path: 'example.txt' }))).toContain('remote-parity')
    expect(text(await run('process_execute', { command: 'pwd' }))).toContain(`${remote}/workspace`)
    const long = await run('process_execute', { command: `printf '%120000s' x; printf 'tail'` })
    expect(long.outputReferences?.length).toBe(1)
    const reference = long.outputReferences![0]!
    expect(reference.handle).toMatch(/^remote:/u)
    expect(text(await run('output_read', { handle: reference.handle, cursor: reference.totalBytes - 4 }))).toContain('tail')
    const failedCommand = JSON.parse(text(await run('process_execute', { command: 'printf expected-error >&2; exit 7' })))
    expect(failedCommand.exitCode).toBe(7)
    expect(failedCommand.stderr).toContain('expected-error')
    const timedOut = JSON.parse(text(await run('process_execute', { command: 'sleep 10; echo unexpected > timed-out.txt', timeoutMs: 1000 })))
    expect(timedOut.terminationReason).toBe('timeout')
    const controller = new AbortController()
    const peer = run('process_execute', { command: 'sleep 2; printf peer-survived' })
    const pending = run('process_execute', { command: 'echo $$ > running.pid; sleep 30 & echo $! > child.pid; wait; echo bad > completed.txt' }, controller.signal)
    for (let attempt = 0; attempt < 60; attempt++) {
      const check = JSON.parse(text(await run('process_execute', { command: 'test -f child.pid' })))
      if (check.exitCode === 0) break
      if (attempt === 59) throw new Error('Remote cancellation fixture did not start')
    }
    controller.abort(new Error('Validation cancellation'))
    const cancelled = JSON.parse(text(await pending))
    expect(cancelled.terminationReason).toBe('cancelled')
    expect(text(await peer)).toContain('peer-survived')
    expect(JSON.parse(text(await run('process_execute', { command: 'test ! -e completed.txt && ! kill -0 "$(cat running.pid)" 2>/dev/null && ! kill -0 "$(cat child.pid)" 2>/dev/null' }))).exitCode).toBe(0)
    expect(text(await run('process_execute', { command: 'printf after-cancel' }))).toContain('after-cancel')
    expect(JSON.parse(text(await run('process_execute', { command: 'test ! -e timed-out.txt' }))).exitCode).toBe(0)
    await runtime.dispose()
    expect(stored.size).toBe(0)
    console.log(JSON.stringify({ hostTools: 4, scriptedModelCalls: calls, remoteWorkingDirectory: true, longOutputTransferred: true, cancellationSettled: true, connectionReusable: true }))
  } finally {
    await close()
  }
}, 180000)

it.skipIf(!process.env.GB_DIRECT_MODEL_HOST || !process.env.GB_DIRECT_MODEL_HOST_NODE)('does not replay a remote side effect after a direct-model provider failure', async () => {
  const connection = await connectDirectModelTestHost(process.env.GB_DIRECT_MODEL_HOST!, process.env.GB_DIRECT_MODEL_HOST_NODE!)
  const tools = new RemoteModelTools(connection.workspace, {})
  const profile = { id: randomUUID(), name: 'Failure fixture', baseUrl: 'https://fixture.invalid/v1', modelName: 'fixture', protocol: 'openai-chat-completions' as const, authentication: 'none' as const, apiKey: '' }
  let calls = 0
  const runtime = createAgentRuntime(connection.local, { ...defaultRuntimeSettings, provider: 'model', modelProfiles: [profile], defaultModelProfileId: profile.id } as ResolvedRuntimeSettings, {
    executionSpace: { kind: 'ssh', hostId: 'host-test', remoteRootPath: `${connection.remote}/workspace`, cacheIdentity: connection.remote, routeIdentity: connection.remote, workspaceAccess: connection.workspace },
    remoteModelTools: tools,
    modelFetcher: async () => ++calls === 1
      ? Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'write-once', type: 'function', function: { name: 'process_execute', arguments: JSON.stringify({ command: 'printf once >> once.txt' }) } }] } }] })
      : Response.json({ error: { message: 'fixture authentication failure' } }, { status: 401 })
  })
  try {
    const execute = async () => { for await (const event of runtime.run({ requestId: randomUUID(), conversationId: randomUUID(), prompt: 'Run the fixture' }, new AbortController().signal)) { void event } }
    await expect(execute()).rejects.toThrow()
    expect(calls).toBe(2)
    const result = await tools.callTool('workspace_read_text', { path: 'once.txt' }, new AbortController().signal, { conversationId: randomUUID(), runtimeTarget: 'model' })
    const content = result.parts.map(part => part.type === 'text' ? part.text : '').join('\n')
    expect(content).toContain('once')
    expect(content).not.toContain('onceonce')
    console.log(JSON.stringify({ providerFailureAfterRemoteWrite: true, sideEffectNotReplayed: true, scriptedModelCalls: calls, externalModelCalls: 0 }))
  } finally { await runtime.dispose(); await tools.dispose(); await connection.close() }
}, 180000)
