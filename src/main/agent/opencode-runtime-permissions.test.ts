// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OpenCodeRuntime } from './opencode-runtime'

const cachedBinary = join(
  process.cwd(), '.runtime-resources', process.arch,
  process.platform === 'win32' ? 'opencode.exe' : 'opencode'
)
const binaryPath = process.env.GOODBUDDY_TEST_OPENCODE_BINARY || cachedBinary

it.skipIf(!existsSync(binaryPath))(
  'completes native Task external reads and structured yes/no and text questions while Ask disables tools',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-permissions-'))
    const workspace = join(root, 'workspace')
    const externalFile = join(root, 'external.txt')
    await mkdir(workspace)
    await writeFile(externalFile, 'EXTERNAL_DIRECTORY_READ_OK\n')
    let requests = 0
    let readVerified = false
    let answerVerified = false
    let askTools: string[] | undefined
    const model = createServer((request, response) => {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += chunk.toString()
        const input = JSON.parse(body)
        if (++requests > 7) {
          response.writeHead(500).end('Unexpected extra model request')
          return
        }
        const messages = input.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>
        const user = JSON.stringify(messages.filter(message => message.role === 'user').at(-1)?.content)
        const results = messages.filter(message => message.role === 'tool')
        let content: string | undefined
        let tool: { name: string; arguments: object; id: string } | undefined
        if (user.includes('ASK_WITHOUT_TOOLS')) {
          askTools = (input.tools ?? []).map((entry: { function: { name: string } }) => entry.function.name)
          content = 'ASK_OK'
        } else if (user.includes('READ_EXTERNAL_SENTINEL')) {
          if (results.some(result => result.tool_call_id === 'external-read')) {
            readVerified = JSON.stringify(results).includes('EXTERNAL_DIRECTORY_READ_OK')
            content = 'CHILD_OK'
          } else {
            tool = { id: 'external-read', name: 'read', arguments: { filePath: externalFile } }
          }
        } else if (results.some(result => result.tool_call_id === 'native-question')) {
          answerVerified = JSON.stringify(results).includes('Yes') && JSON.stringify(results).includes('Custom answer')
          content = 'PARENT_OK'
        } else if (results.some(result => result.tool_call_id === 'native-task')) {
          tool = { id: 'native-question', name: 'question', arguments: { questions: [
            { header: 'Confirm', question: 'Continue?', options: [
              { label: 'Yes', description: 'Continue' }, { label: 'No', description: 'Stop' }
            ], custom: false },
            { header: 'Details', question: 'Add details', options: [], custom: true }
          ] } }
        } else {
          tool = {
            id: 'native-task', name: 'task',
            arguments: {
              subagent_type: 'general', description: 'Read external test file',
              prompt: `READ_EXTERNAL_SENTINEL: read ${externalFile}, then reply CHILD_OK.`
            }
          }
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const [delta, finishReason] of [
          [tool ? {
            role: 'assistant',
            tool_calls: [{ index: 0, id: tool.id, type: 'function', function: {
              name: tool.name, arguments: JSON.stringify(tool.arguments)
            } }]
          } : { role: 'assistant', content }, null],
          [{}, tool ? 'tool_calls' : 'stop']
        ]) {
          response.write(`data: ${JSON.stringify({
            id: `permissions-${requests}`, object: 'chat.completion.chunk', created: 1,
            model: 'permissions', choices: [{ index: 0, delta, finish_reason: finishReason }]
          })}\n\n`)
        }
        response.end('data: [DONE]\n\n')
      })().catch(() => response.destroy())
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    const address = model.address()
    if (!address || typeof address === 'string') throw new Error('No model port')
    const runtime = new OpenCodeRuntime({
      embedded: true, binaryPath: '', bundledBinaryPath: binaryPath, configPath: '',
      bundledConfigPath: join(process.cwd(), '.runtime-resources', 'opencode-config'),
      defaultWorkspace: workspace,
      modelProfile: {
        id: crypto.randomUUID(), name: 'Permissions fixture', modelName: 'permissions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        protocol: 'openai-chat-completions', authentication: 'none'
      }
    })
    try {
      for (const mode of ['execute', 'ask'] as const) {
        let text = ''
        for await (const event of runtime.run({
          requestId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
          workMode: mode, prompt: mode === 'execute' ? 'USE_NATIVE_TASK' : 'ASK_WITHOUT_TOOLS'
        }, AbortSignal.timeout(30_000))) {
          if (event.type === 'text') text += event.delta
          if (event.type === 'question') {
            expect(event.questions).toHaveLength(2)
            await runtime.respondToQuestion(event.questionId, [['Yes'], ['Custom answer']])
          }
        }
        expect(text).toBe(mode === 'execute' ? 'PARENT_OK' : 'ASK_OK')
      }
      expect(readVerified).toBe(true)
      expect(answerVerified).toBe(true)
      expect(askTools).toBeDefined()
      expect(askTools).not.toEqual(expect.arrayContaining(['task']))
      expect(askTools?.filter(name => ['bash', 'write', 'edit', 'read'].includes(name))).toEqual([])
      expect(requests).toBe(6)
    } finally {
      await runtime.dispose()
      model.closeAllConnections()
      await new Promise<void>(resolve => model.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  90_000
)
