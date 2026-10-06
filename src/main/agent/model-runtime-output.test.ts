// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { expect, it, vi } from 'vitest'
import { ModelAgentRuntime } from './model-runtime'
import type { RuntimeEvent } from './runtime'
import { SubagentScheduler } from '../assistant/subagent-scheduler'
import { createDesktopStorageFiles, openDesktopStorageFiles, type DesktopFilesCaller } from '../desktop-storage-files'
import { conversationSubagentActivitySchema, conversationToolActivitySchema } from '../../shared/assistant-contracts'
import { AssistantDatabase } from '../assistant/assistant-database'
import { conversationMessageResourceIds } from '../../shared/conversation-output'
import { readConversationOutput } from './conversation-output'
import { storageDataBytes, STORAGE_MAX_BYTES } from '../desktop-storage-contracts'

it.each(['completed', 'failed', 'cancelled'] as const)('adopts process, search and %s subagent output into persisted history before release without copying', async (state) => {
  const parent = resolve('temp/goodbuddy-model-output')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'runtime-'))
  const databasePath = join(root, 'assistant.sqlite')
  let database = new AssistantDatabase(databasePath)
  await database.initialize(root)
  const hasOwner = (conversationId: string, kind: string, id: string) => database.hasAttachmentOwner(conversationId, kind, id)
  let owner = await openDesktopStorageFiles(root, hasOwner)
  const call: DesktopFilesCaller['call'] = async (domain, method, args) =>
    structuredClone(await owner.dispatch(domain, method, structuredClone(args))) as never
  const { attachments, backingStore } = createDesktopStorageFiles({ call })
  const controller = new AbortController()
  const captureBacking = { ...backingStore, append: async (...args: Parameters<typeof backingStore.append>) => {
    await backingStore.append(...args)
    if (state === 'cancelled' && args[1].startsWith('subagent:')) controller.abort(new Error('Fixture cancelled'))
  } }
  const conversationId = randomUUID(), messageId = randomUUID()
  const requestId = randomUUID()
  const project = database.createSshProject({
    project: { name: 'Recovery fixture', description: '', rootPath: '/srv/fixture', runtimeSelection: { provider: 'opencode' } },
    executionSpace: { kind: 'ssh', hostId: randomUUID(), remoteRootPath: '/srv/fixture' }, assertCurrent: () => {}
  })
  const header = { id: conversationId, projectId: project.id, title: 'Output', updatedAt: Date.now() }
  database.saveLocalConversations([{ header, messages: [] }])
  database.createTask({ id: requestId, projectId: header.projectId, conversationId,
    title: 'Output', instructions: 'Run fixtures', remoteRecovery: {
      recoverable: true, currentUserMessageId: randomUUID(), currentAssistantMessageId: messageId
    } })
  const adopted: string[] = []
  const outputAdopt = vi.fn(async (...args: Parameters<typeof attachments.outputAdopt>) => {
    expect(args.slice(2)).toEqual([conversationId, 'message', messageId])
    const id = await attachments.outputAdopt(...args)
    adopted.push(args[1])
    return id
  })
  const scheduler = new SubagentScheduler({ concurrency: 1, queueLimit: 2, timeoutMs: 30_000 })
  const text = 'match-\u4e2d\ud83d\ude00'.repeat(20_000) + '-tail'
  const childText = 'child-\u4e2d\ud83d\ude00'.repeat(20_000) + '-child-tail'
  const inlineStderr = 'inline'.repeat(4_000) + '-stderr-tail'
  const tool = (id: string, name: string, args: unknown) => ({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [
      { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
    ] } }]
  })
  const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] })
  const responses = [
    tool('process', 'process_execute', { command: 'node output.cjs' }),
    tool('rg', 'workspace_rg', { args: ['match', 'search.txt'] }),
    tool('delegate', 'subagent_delegate', { task: 'Return child output' }),
    tool('child-process', 'process_execute', { command: 'node output.cjs' }),
    state === 'failed' ? { choices: [{ message: { ...tool('invalid', 'unknown-tool', {}).choices[0]!.message, content: childText } }] } : reply(childText),
    reply('complete')
  ]
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(responses.shift()))
  const runtime = new ModelAgentRuntime({
    baseUrl: 'https://example.test/v1', model: 'fixture', authentication: 'none',
    protocol: 'openai-chat-completions', defaultWorkspace: root, fetcher,
    directModelSubagentScheduler: scheduler, ripgrepExecutablePath: rgPath,
    outputStore: { backingStore: captureBacking }, outputAdopt
  })
  const events: RuntimeEvent[] = []
  try {
    await writeFile(join(root, 'output.cjs'), `process.stdout.write(${JSON.stringify(text)}); process.stderr.write(${JSON.stringify(inlineStderr)})`)
    await writeFile(join(root, 'search.txt'), text + '\n')
    try {
      for await (const event of runtime.run({
        requestId, conversationId, currentAssistantMessageId: messageId, prompt: 'Run fixtures'
      }, controller.signal)) {
        if (event.type === 'tool') {
          if (event.output) expect(Buffer.byteLength(event.output)).toBeLessThanOrEqual(256 * 1024)
          for (const reference of event.outputReferences ?? []) expect(adopted).toContain(reference.handle)
          const { requestId, type, ...activity } = event
          void requestId; void type
          expect(conversationToolActivitySchema.parse(activity)).toEqual(activity)
        } else if (event.type === 'subagent') {
          if (event.outputReference) expect(adopted).toContain(event.outputReference.handle)
          const { requestId, type, ...activity } = event
          void requestId; void type
          expect(conversationSubagentActivitySchema.parse(activity)).toEqual(activity)
        }
        events.push(event)
        if (event.type === 'tool' || event.type === 'subagent' || event.type === 'done') {
          const input = { taskId: requestId, bindingId: 'output-binding', operationId: 'output-operation',
            conversationId, assistantMessageId: messageId, semanticSequence: String(events.length), eventIndex: 0, event }
          expect(database.appendRemoteConversationTaskEventOnce(input)).toBe(true)
          expect(database.appendRemoteConversationTaskEventOnce(input)).toBe(false)
        }
      }
    } catch (error) {
      if (state !== 'cancelled') throw error
      expect(error).toBe(controller.signal.reason)
      const event = { requestId, type: 'error' as const, status: 'cancelled' as const, message: 'Fixture cancelled' }
      events.push(event)
      database.appendRemoteConversationTaskEventOnce({ taskId: requestId, bindingId: 'output-binding', operationId: 'output-operation',
        conversationId, assistantMessageId: messageId, semanticSequence: String(events.length), eventIndex: 0, event })
    }
    expect(events.at(-1)).toMatchObject({ type: state === 'cancelled' ? 'error' : 'done' })
    expect(fetcher).toHaveBeenCalledTimes(state === 'cancelled' ? 5 : 6)
    expect(outputAdopt).toHaveBeenCalledTimes(4)
    const processEvent = events.find(event => event.type === 'tool' && event.callId === 'process' && event.state === 'completed')
    expect(processEvent?.type).toBe('tool')
    if (processEvent?.type === 'tool') {
      expect(JSON.parse(processEvent.output!).stderr).toBe(inlineStderr)
    }
    expect(outputAdopt.mock.calls.some(([captureOwner]) => captureOwner !== conversationId)).toBe(true)
    const references = events.flatMap(event => event.type === 'tool' ? event.outputReferences ?? []
      : event.type === 'subagent' && event.outputReference ? [event.outputReference] : [])
    expect(references).toHaveLength(4)
    const message = database.getConversation(conversationId).messages.find(message => message.id === messageId)!
    expect(message.tools?.flatMap(tool => tool.outputReferences ?? [])).toHaveLength(3)
    expect(message.subagents?.[0]?.outputReference).toEqual(references.at(-1))
    expect(message.subagents?.[0]?.state).toBe(state)
    const save = [{ header, messages: [message] }]
    expect(storageDataBytes(save)).toBeLessThan(STORAGE_MAX_BYTES)
    await attachments.reference(conversationId, 'message', messageId, conversationMessageResourceIds(message))
    database.saveLocalConversations(save)
    await runtime.dispose()
    await owner.close()
    database.close()
    database = new AssistantDatabase(databasePath)
    await database.initialize(root)
    owner = await openDesktopStorageFiles(root, hasOwner)
    owner.attachments.reconcile(hasOwner, true)
    expect(database.getConversation(conversationId).messages.find(message => message.id === messageId)).toEqual(message)
    for (const reference of references) {
      let restored = ''
      for (let cursor = 0; cursor < reference.totalBytes;) {
        const page = await readConversationOutput(attachments, { conversationId, handle: reference.handle, cursor })
        expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(32768)
        expect(page.nextCursor).toBeGreaterThan(cursor)
        restored += page.content
        cursor = page.nextCursor
      }
      expect(restored).toBe(reference.handle.startsWith('subagent:') ? childText
        : reference.handle.startsWith('rg:') ? `1:${text}\n` : text)
      const id = reference.handle.split(':').at(-1)!
      expect((await readdir(join(root, 'conversation-assets', conversationId, 'documents', id))).sort())
        .toEqual(['original.txt', 'request.json'])
    }
    await expect(readConversationOutput(attachments, { conversationId: randomUUID(), handle: references[0]!.handle })).rejects.toThrow('owner')
    await expect(readConversationOutput(attachments, { conversationId, handle: references[0]!.handle, limitBytes: 32769 })).rejects.toThrow()
    await attachments.deleteConversation(conversationId)
    for (const reference of references) {
      await expect(attachments.outputRead(conversationId, reference.handle, 0, 1)).rejects.toThrow()
    }
  } finally {
    await runtime.dispose()
    scheduler.dispose()
    await owner.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})
