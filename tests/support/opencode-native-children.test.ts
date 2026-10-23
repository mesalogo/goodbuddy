// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { expect, it, vi } from 'vitest'
import { OpenCodeRuntime } from '../../src/main/agent/opencode-runtime'
import type { RuntimeEvent } from '../../src/main/agent/runtime'

const binary = process.env.GOODBUDDY_TEST_OPENCODE_BINARY ?? join(process.cwd(),
  '.runtime-resources', process.arch, process.platform === 'win32' ? 'opencode.exe' : 'opencode')

// The model is scripted, but the server, SDK, tools, child sessions and adapter are real.
it.skipIf(!existsSync(binary)).each(['concurrent', 'failure', 'cancel', 'answer', 'shell-observation', 'native-stop'] as const)(
  'validates native OpenCode children: %s', async scenario => {
    const base = join(process.cwd(), 'temp', 'opencode-native-children')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, `${scenario}-`))
    vi.stubEnv('TEMP', root)
    vi.stubEnv('TMP', root)
    vi.stubEnv('TMPDIR', root)
    await writeFile(join(root, 'sentinel.txt'), 'CHILD_READ_SENTINEL\n')
    await writeFile(join(root, 'spawn.cjs'), `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(join(root, 'detached-done.txt'))},'DETACHED_DONE'),3500)`)}],{detached:true,stdio:'ignore'});
try { require('node:fs').writeFileSync(${JSON.stringify(join(root, 'detached.pid'))},String(child.pid)); }
catch(error) { child.kill(); throw error; }
console.log('DETACHED_PID='+child.pid); child.unref();`)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 45_000)
    let calls = 0
    const modelRoutes: string[] = []
    const started = new Set<string>()
    const tools = new Map<string, unknown>()
    const events: RuntimeEvent[] = []
    const native: unknown[] = []
    let client: ReturnType<typeof createOpencodeClient> | undefined
    let releaseChildren!: () => void
    const bothStarted = new Promise<void>(resolve => { releaseChildren = resolve })
    const model = createServer((request, response) => {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += chunk.toString()
        const input = JSON.parse(body)
        if (++calls > 12) { response.writeHead(400).end('Fixture call limit'); return }
        for (const tool of input.tools ?? []) tools.set(tool.function.name, tool.function.parameters)
        const messages = input.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>
        const user = JSON.stringify(messages.filter(message => message.role === 'user').at(-1)?.content)
        const results = messages.filter(message => message.role === 'tool')
        const child = user.includes('CHILD_A') ? 'A' : user.includes('CHILD_B') ? 'B' : undefined
        modelRoutes.push(`${child ?? 'parent'}:${results.map(result => result.tool_call_id).join(',')}`)
        let content = 'PARENT_FINISHED'
        let actions: Array<{ id: string; name: string; args: object }> = []
        if (user.includes('RECOVER_ONLY')) content = 'RECOVERED'
        else if (scenario === 'shell-observation' && !results.length) actions = [{ id: 'shell-detach', name: 'bash', args: {
          command: `node "${join(root, 'spawn.cjs')}"`, workdir: root, timeout: 10_000
        } }]
        else if (scenario === 'shell-observation') content = 'SHELL_PARENT_FINISHED'
        else if (child) {
          started.add(child)
          if (started.size === 2 || (scenario !== 'concurrent' && scenario !== 'native-stop')) releaseChildren()
          await bothStarted
          if (!results.length) actions = [{ id: `read-${child}`, name: 'read', args: {
            filePath: join(root, child === 'B' ? 'missing.txt' : 'sentinel.txt')
          } }]
          else if (['cancel', 'answer', 'native-stop'].includes(scenario) && !results.some(item => item.tool_call_id === 'child-question')) {
            actions = [{ id: 'child-question', name: 'question', args: { questions: [
              { header: 'Child', question: `Hold child ${child} for cancellation?`, options: [], custom: true }
            ] } }]
          } else content = `CHILD_${child}_FINISHED:${'x'.repeat(child === 'A' ? 17_000 : 10)}`
        } else if (!results.length) {
          actions = (scenario === 'concurrent' || scenario === 'native-stop' ? ['A', 'B'] : ['A']).map(id => ({
            id: `task-${id}`, name: 'task', args: {
              subagent_type: scenario === 'failure' ? 'missing-agent-fixture' : 'general',
              description: `Native child ${id}`, prompt: `CHILD_${id}: Execute fixture.`
            }
          }))
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = actions.length ? { role: 'assistant', tool_calls: actions.map((action, index) => ({
          index, id: action.id, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) }
        })) } : { role: 'assistant', content }
        for (const [value, finish] of [[delta, null], [{}, actions.length ? 'tool_calls' : 'stop']]) {
          response.write(`data: ${JSON.stringify({ id: `fixture-${calls}`, object: 'chat.completion.chunk',
            created: 1, model: 'children', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`)
        }
        response.end('data: [DONE]\n\n')
      })().catch(() => response.destroy())
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    const address = model.address()
    if (!address || typeof address === 'string') throw new Error('No model port')
    const runtime = new OpenCodeRuntime({ embedded: true, binaryPath: '', bundledBinaryPath: binary,
      bundledConfigPath: join(process.cwd(), '.runtime-resources', 'opencode-config'),
      sharedCacheRoot: join(root, 'cache'), configPath: '', defaultWorkspace: root,
      modelProfile: { id: crypto.randomUUID(), name: 'Child fixture', modelName: 'children',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: 'openai-chat-completions', authentication: 'none' }
    }, { createClient: options => {
      client = createOpencodeClient(options)
      const subscribe = client.event.subscribe.bind(client.event)
      client.event.subscribe = async (...args) => {
        const result = await subscribe(...args)
        const stream = result.stream
        return { ...result, stream: (async function* () {
          for await (const event of stream) { native.push(event); yield event }
        })() }
      }
      return client
    } })
    const conversationId = crypto.randomUUID()
    const pendingQuestions: Extract<RuntimeEvent, { type: 'question' }>[] = []
    let abortedSessionId: string | undefined
    const cleanupDetached = async (): Promise<void> => {
      // The launcher's PID file survives missing tool output and failed assertions.
      const recordedPid = await readFile(join(root, 'detached.pid'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (recordedPid === undefined) return
      const pid = Number(recordedPid)
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned detached PID')
      const alive = (): boolean => {
        try { process.kill(pid, 0); return true } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          throw error
        }
      }
      if (alive()) {
        try { process.kill(pid) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await expect.poll(alive, { timeout: 5000, interval: 50 }).toBe(false)
      console.log('DETACHED_CLEANUP', JSON.stringify({ pid, exited: true }))
    }
    try {
      let interruption: unknown
      try {
        for await (const event of runtime.run({ requestId: crypto.randomUUID(), conversationId,
          prompt: 'RUN_CHILD_FIXTURE' }, controller.signal)) {
          events.push(event)
          if (event.type === 'question') {
            expect(event.childTaskId).toBeDefined()
            if (scenario === 'native-stop') {
              pendingQuestions.push(event)
              if (pendingQuestions.length === 2) {
                const asked = native.filter(value => (value as { type: string }).type === 'question.asked') as Array<{
                  properties: { id: string; sessionID: string; questions: Array<{ question: string }> }
                }>
                const target = asked.find(value => value.properties.questions[0]?.question.includes('child A'))!
                abortedSessionId = target.properties.sessionID
                await client!.session.abort({ sessionID: target.properties.sessionID }, { throwOnError: true })
                const sibling = pendingQuestions.find(question => question.questions[0]?.question.includes('child B'))!
                await runtime.respondToQuestion(sibling.questionId, [['SIBLING_SURVIVED']])
                console.log('NATIVE_TARGETED_ABORT', JSON.stringify({ sessionID: target.properties.sessionID,
                  questionID: target.properties.id, siblingChildTaskId: sibling.childTaskId }))
              }
            } else if (scenario === 'answer') await runtime.respondToQuestion(event.questionId, [['CHILD_ANSWER']])
            else controller.abort(new Error('Fixture parent cancellation'))
          }
        }
      } catch (error) { interruption = error }
      const shellFinishedAtParentReturn = existsSync(join(root, 'detached-done.txt'))
      const children = events.filter(event => event.type === 'subagent')
      const sessions = (await client!.session.list({ directory: root }, { throwOnError: true })).data!
      const histories = await Promise.all(sessions.map(async session => ({ id: session.id, parentID: session.parentID,
        messages: (await client!.session.messages({ sessionID: session.id, directory: root }, { throwOnError: true })).data
      })))
      const summary = { scenario, calls, modelRoutes, interruption: interruption instanceof Error ? interruption.message : interruption,
        sessions: sessions.map(session => ({ id: session.id, parentID: session.parentID })),
        childStates: children.map(event => ({ call: event.runtimeCallId, id: event.childTaskId, state: event.state,
          outputLength: event.output?.length, tools: event.progress?.filter(block => block.type === 'tool').map(block => ({
            callId: block.tool.callId, name: block.tool.name, state: block.tool.state
          })) })),
        questions: events.filter(event => event.type === 'question'),
        toolNames: [...tools.keys()], bashSchema: tools.get('bash'), taskSchema: tools.get('task'),
        nativeEventTypes: [...new Set(native.map(event => (event as { type: string }).type))] }
      console.log('NATIVE_CHILD_EVIDENCE', JSON.stringify(summary))
      expect(tools.has('task')).toBe(true)
      expect(tools.has('bash')).toBe(true)
      if (scenario === 'concurrent') {
        expect(interruption).toBeUndefined()
        expect(started.size).toBe(2)
        expect(calls).toBe(6)
        expect(sessions.filter(session => session.parentID)).toHaveLength(2)
        for (const id of ['task-A', 'task-B']) expect(children.some(event => event.runtimeCallId === id && event.state === 'completed')).toBe(true)
        expect(JSON.stringify(children)).toContain('CHILD_READ_SENTINEL')
        expect(JSON.stringify(children)).toContain('failed')
        expect(JSON.stringify(histories)).toContain('x'.repeat(17_000))
        expect(children.some(event => event.output?.length === 16_000)).toBe(true)
        const parentText = events.findIndex(event => event.type === 'text' && event.delta.includes('PARENT_FINISHED'))
        expect(parentText).toBeGreaterThan(Math.max(...events.map((event, index) =>
          event.type === 'subagent' && event.state === 'completed' ? index : -1)))
      } else if (scenario === 'failure') {
        expect(interruption).toBeUndefined()
        expect(calls).toBe(2)
        expect(children.some(event => event.state === 'failed')).toBe(true)
        expect(sessions.filter(session => session.parentID)).toHaveLength(0)
      } else if (scenario === 'cancel') {
        expect(events.some(event => event.type === 'question')).toBe(true)
        expect(children.some(event => event.state === 'cancelled')).toBe(true)
        await expect.poll(async () => Object.keys((await client!.session.status({ directory: root }, { throwOnError: true })).data!),
          { timeout: 5000 }).toHaveLength(0)
        let recovery = ''
        for await (const event of runtime.run({ requestId: crypto.randomUUID(), conversationId,
          prompt: 'RECOVER_ONLY' }, AbortSignal.timeout(15_000))) if (event.type === 'text') recovery += event.delta
        expect(recovery).toBe('RECOVERED')
        console.log('CANCEL_RECOVERY', JSON.stringify({ calls, modelRoutes }))
      } else if (scenario === 'answer') {
        expect(interruption).toBeUndefined()
        expect(calls).toBe(5)
        expect(children.some(event => event.state === 'completed')).toBe(true)
        expect(JSON.stringify(histories)).toContain('CHILD_ANSWER')
      } else if (scenario === 'native-stop') {
        expect(interruption).toBeUndefined()
        expect(pendingQuestions).toHaveLength(2)
        expect(calls).toBe(7)
        expect(abortedSessionId).toBeDefined()
        const targetEvents = children.filter(event => event.runtimeCallId === 'task-A')
        expect(targetEvents.at(-1)?.state).toBe('cancelled')
        expect(targetEvents.some(event => event.state === 'cancelled')).toBe(true)
        expect(targetEvents.some(event => event.state === 'completed' || event.state === 'failed')).toBe(false)
        expect(JSON.stringify(targetEvents)).not.toContain('CHILD_A_FINISHED')
        const targetHistory = histories.find(history => history.id === abortedSessionId)
        expect(targetHistory).toBeDefined()
        expect(JSON.stringify(targetHistory)).not.toContain('CHILD_A_FINISHED')
        const nativeErrors = native.filter(value => {
          const event = value as { type: string; properties?: { sessionID?: string } }
          return event.type === 'session.error' && event.properties?.sessionID === abortedSessionId
        })
        expect(nativeErrors.length).toBeGreaterThan(0)
        console.log('NATIVE_TARGET_ABORT_RESULT', JSON.stringify({ sessionID: abortedSessionId,
          adapterTerminal: targetEvents.at(-1)?.state, nativeErrors }))
        expect(JSON.stringify(histories)).toContain('SIBLING_SURVIVED')
        expect(children.some(event => event.runtimeCallId === 'task-B' && event.state === 'completed')).toBe(true)
        expect(events.some(event => event.type === 'text' && event.delta.includes('PARENT_FINISHED'))).toBe(true)
        await expect.poll(async () => Object.keys((await client!.session.status({ directory: root }, { throwOnError: true })).data!),
          { timeout: 5000 }).toHaveLength(0)
      } else {
        expect(interruption).toBeUndefined()
        expect(calls).toBe(2)
        expect(JSON.stringify(histories)).toContain('DETACHED_PID=')
        const outlivedParent = !shellFinishedAtParentReturn
        await expect.poll(async () => readFile(join(root, 'detached-done.txt'), 'utf8').catch(() => ''),
          { timeout: 8000 }).toBe('DETACHED_DONE')
        console.log('SHELL_DETACH_EVIDENCE', JSON.stringify({ outlivedParent,
          backgroundEvents: events.filter(event => event.type.includes('background')).length }))
        expect(events.filter(event => event.type === 'subagent')).toHaveLength(0)
      }
    } finally {
      clearTimeout(deadline)
      releaseChildren()
      try {
        try { await runtime.dispose() } finally {
          model.closeAllConnections()
          await new Promise<void>(resolve => model.close(() => resolve()))
          await cleanupDetached()
          await rm(root, { recursive: true, force: true })
        }
      } finally { vi.unstubAllEnvs() }
    }
  }, 75_000)
