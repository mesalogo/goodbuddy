// @vitest-environment node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { AgentOwnedAcpPrompt } from './agent-owned-acp-prompt'
import { SemanticPromptStore } from './semantic-prompt-store'
import { openCodeSubagentPluginSource } from './opencode-subagent-plugin'
import { createOpenCodeModelBridgeProviderConfig } from './model-bridge-helper'
import type { RuntimeAcpProcessOwner } from './runtime-acp-backend'
import { OpenCodeSubagentProgress } from '../main/agent/opencode-subagent'

const binary = process.env.GOODBUDDY_TEST_OPENCODE_BINARY ?? join(process.cwd(),
  '.runtime-resources', process.arch, process.platform === 'win32' ? 'opencode.exe' : 'opencode')

it.skipIf(!existsSync(binary)).each(['parent', 'child', 'reject', 'cancel', 'native-stop'] as const)(
  'round trips native ACP %s questions through the production plugin and Agent owner', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-remote-question-'))
  await mkdir(join(root, 'state'), { mode: 0o700 })
  // OpenCode installs dependencies in both config locations before loading plugins.
  const configDirectory = join(root, 'config', 'opencode')
  await cp(join(process.cwd(), '.runtime-resources', 'opencode-config'), configDirectory, { recursive: true })
  const pluginPath = join(root, 'plugin.mjs')
  const productionPlugin = join(root, 'production-plugin.mjs')
  await writeFile(productionPlugin, openCodeSubagentPluginSource())
  // Test driver invokes the real native child abort; forwarding stays production code.
  await writeFile(pluginPath, scenario === 'native-stop' ? `
import factory from ${JSON.stringify(pathToFileURL(productionPlugin).href)};
export default async input => {
  const hooks = await factory(input);
  const questions = [];
  return { ...hooks, event: async payload => {
    await hooks.event(payload);
    if (payload.event.type !== 'question.asked') return;
    questions.push(payload.event.properties);
    if (questions.length === 2) {
      const target = questions.find(q => q.questions[0].question.includes('TARGET'));
      void input.client.session.abort({ path: { id: target.sessionID }, throwOnError: true });
    }
  } };
}` : `export { default } from ${JSON.stringify(pathToFileURL(productionPlugin).href)};`)
  let calls = 0
  let answered = false
  let tools: string[] = []
  const model = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      const input = JSON.parse(body)
      tools = (input.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)
      if (++calls > (scenario === 'native-stop' ? 6 : 4)) { response.writeHead(500).end(); return }
      const messages = input.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>
      const results = messages.filter(message => message.role === 'tool')
      answered ||= JSON.stringify(results).includes('REMOTE_ANSWER') ||
        (scenario === 'reject' && JSON.stringify(results).includes('dismissed'))
      const childPrompt = JSON.stringify(messages.filter(message => message.role === 'user').at(-1)).includes('CHILD_DECISION')
      const task = (scenario === 'child' || scenario === 'native-stop') && !childPrompt && results.length === 0
      const target = JSON.stringify(messages.filter(message => message.role === 'user').at(-1)).includes('TARGET')
      const finished = results.length > 0
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [delta, finish] of [
        [finished ? { role: 'assistant', content: 'QUESTION_OK' } : {
          role: 'assistant', tool_calls: (task && scenario === 'native-stop' ? ['TARGET', 'SIBLING'] : ['single']).map((label, index) => ({ index, id: task ? (scenario === 'native-stop' ? label : 'native-task') : 'native-question', type: 'function',
            function: { name: task ? 'task' : 'question', arguments: JSON.stringify(task ? {
              subagent_type: 'general', description: 'Ask child question', prompt: `CHILD_DECISION: ${label} Ask a question.`
            } : { questions: [
              { header: 'Details', question: target ? 'TARGET decision?' : 'Remote decision?', options: [], custom: true }
            ] }) } }))
        }, null], [{}, finished ? 'stop' : 'tool_calls']
      ]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const address = model.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const config = createOpenCodeModelBridgeProviderConfig({ protocol: 'openai-chat-completions',
    model: 'fixture', loopbackOrigin: `http://127.0.0.1:${address.port}/${'a'.repeat(43)}` })
  const child = spawn(binary, ['acp'], { cwd: root, stdio: 'pipe', env: {
    ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugin: [pathToFileURL(pluginPath).href] }),
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_ENABLE_QUESTION_TOOL: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config')
  } })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data.toString() })
  const transcript = new SemanticPromptStore(join(root, 'state', 'prompts.sqlite'))
  transcript.prepare({ bindingId: 'binding', operationId: 'operation', requestId: 'operation',
    controllerId: 'controller', preparationDigest: `sha256:${'a'.repeat(64)}`, promptSequence: 0 })
  let complete = false
  const owner = new AgentOwnedAcpPrompt({ bindingId: 'binding', controllerId: 'controller',
    workspaceDirectory: root, transcript,
    process: {
      writeStdin: async (data: Uint8Array) => { child.stdin.write(data) },
      subscribeOutput: (listener: (event: { stream: string; data: Uint8Array }) => void) => {
        const onData = (data: Uint8Array) => listener({ stream: 'stdout', data })
        child.stdout.on('data', onData)
        return () => { child.stdout.off('data', onData) }
      },
      subscribeExit: (listener: () => void) => { child.on('exit', listener); return () => { child.off('exit', listener) } }
    } as unknown as RuntimeAcpProcessOwner,
    completePrompt: () => { complete = true }
  })
  try {
    await owner.start({ bindingId: 'binding', operationId: 'operation', requestId: 'operation',
      prompt: [{ type: 'text', text: 'Ask the native question tool for the decision.' }] })
    let questionId: string | undefined
    await expect.poll(async () => {
      const page = transcript.page({ bindingId: 'binding', operationId: 'operation',
        controllerId: 'controller', afterSequence: '0', limit: 100 })
      for (const event of page.events) {
        const notification = event.payload as { update?: { _meta?: { goodbuddyQuestion?: {
          question: { id: string }; endpoint?: string; childCallId?: string
        } } } }
        const extension = notification.update?._meta?.goodbuddyQuestion
        if (scenario === 'native-stop' && extension?.childCallId === 'TARGET') continue
        if (extension && !questionId) {
          expect(extension.endpoint).toBeUndefined()
          if (scenario === 'child') expect(extension.childCallId).toBe('native-task')
          questionId = extension.question.id
          expect(owner.pendingQuestions('other')).toEqual([])
          if (scenario !== 'native-stop') expect(owner.pendingQuestions('operation')).toHaveLength(1)
          await expect(owner.respondToQuestion({ bindingId: 'other', operationId: 'operation', questionId,
            answers: [['WRONG']] })).rejects.toThrow('no longer pending')
          if (scenario === 'cancel') {
            await owner.cancel()
            expect(owner.pendingQuestions('operation')).toEqual([])
            continue
          }
          await owner.respondToQuestion({ bindingId: 'binding', operationId: 'operation', questionId,
            answers: scenario === 'reject' ? [] : [['REMOTE_ANSWER']] })
        }
      }
      return complete
    }, { timeout: 30_000, interval: 50 }).toBe(true)
    expect(tools).toContain('question')
    expect(questionId, stderr).toBeDefined()
    if (scenario === 'reject') {
      expect(JSON.stringify(transcript.page({ bindingId: 'binding', operationId: 'operation',
        controllerId: 'controller', afterSequence: '0', limit: 100 }).events)).toContain('dismissed')
    } else if (scenario !== 'cancel') expect(answered).toBe(true)
    expect(owner.pendingQuestions('operation')).toEqual([])
    expect(calls).toBe(scenario === 'native-stop' ? 5 : scenario === 'child' ? 4 : scenario === 'reject' || scenario === 'cancel' ? 1 : 2)
    if (scenario === 'native-stop') {
      const tracker = new OpenCodeSubagentProgress('operation')
      const states: Record<string, string[]> = { TARGET: [], SIBLING: [] }
      let aborts = 0
      for (const event of transcript.page({ bindingId: 'binding', operationId: 'operation',
        controllerId: 'controller', afterSequence: '0', limit: 1000 }).events) {
        const update = (event.payload as { update?: { toolCallId?: string; _meta?: {
          goodbuddySubagentEvent?: { type: string; properties: { error?: { name?: string } } }
        } } }).update
        const native = update?._meta?.goodbuddySubagentEvent
        if (!native) continue
        if (native.type === 'session.error' && native.properties.error?.name === 'MessageAbortedError') aborts++
        const projected = tracker.update(native, update?.toolCallId)
        if (projected?.runtimeCallId) states[projected.runtimeCallId]?.push(projected.state)
      }
      expect(aborts).toBe(1)
      expect(states.TARGET.at(-1)).toBe('cancelled')
      expect(states.TARGET).not.toContain('completed')
      expect(states.TARGET).not.toContain('failed')
      expect(states.SIBLING.at(-1)).toBe('completed')
    }
    await expect(owner.respondToQuestion({ bindingId: 'binding', operationId: 'operation',
      questionId: questionId!, answers: [['LATE']] })).rejects.toThrow('no longer pending')
  } catch (error) {
    console.error({ calls, tools, stderr, events: transcript.page({ bindingId: 'binding',
      operationId: 'operation', controllerId: 'controller', afterSequence: '0', limit: 100 }).events })
    throw error
  } finally {
    owner.close()
    child.kill()
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()) })
    transcript.close()
    model.closeAllConnections()
    await new Promise<void>(resolve => model.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
