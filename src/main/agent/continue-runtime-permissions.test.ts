// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ContinueAgentRuntime } from './continue-runtime'

it('completes Execute external writes and native free-text questions without a second approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-continue-permissions-'))
  const workspace = join(root, 'workspace')
  const externalFile = join(root, 'external.txt')
  await mkdir(workspace)
  const command = process.platform === 'win32'
    ? `Set-Content -LiteralPath '${externalFile.replaceAll("'", "''")}' -Value 'CONTINUE_EXTERNAL_OK' -NoNewline`
    : `printf CONTINUE_EXTERNAL_OK > '${externalFile.replaceAll("'", "'\\''")}'`
  let requests = 0
  let questions = 0
  const server = createServer((request, response) => {
    void (async () => {
      for await (const chunk of request) { void chunk }
      if (++requests > 3) {
        response.writeHead(500).end('Unexpected extra model request')
        return
      }
      const tool = requests <= 2
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [delta, finishReason] of [
        [tool ? {
          role: 'assistant', tool_calls: [{
            index: 0, id: requests === 1 ? 'external-write' : 'native-question', type: 'function',
            function: requests === 1
              ? { name: 'Bash', arguments: JSON.stringify({ command }) }
              : { name: 'AskQuestion', arguments: JSON.stringify({ question: 'Add details', options: [] }) }
          }]
        } : { role: 'assistant', content: 'CONTINUE_DONE' }, null],
        [{}, tool ? 'tool_calls' : 'stop']
      ]) {
        response.write(`data: ${JSON.stringify({
          id: `continue-${requests}`, object: 'chat.completion.chunk', created: 1,
          model: 'permissions', choices: [{ index: 0, delta, finish_reason: finishReason }]
        })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No model port')
  const runtime = new ContinueAgentRuntime({
    binaryPath: '', bundledBinaryPath: join(process.cwd(), 'node_modules', '@continuedev', 'cli', 'dist', 'cn.js'),
    configPath: '', defaultWorkspace: workspace, hostCacheRoot: join(root, 'cache'),
    modelProfile: {
      id: crypto.randomUUID(), name: 'Permissions fixture', modelName: 'permissions',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      protocol: 'openai-chat-completions', authentication: 'none'
    }
  })
  try {
    let text = ''
    for await (const event of runtime.run({
      requestId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      workMode: 'execute', prompt: 'Write the external test sentinel, then reply CONTINUE_DONE.'
    }, AbortSignal.timeout(30_000))) {
      if (event.type === 'text') text += event.delta
      if (event.type === 'question') {
        questions++
        expect(event.questions[0]).toMatchObject({ custom: true, options: [] })
        await runtime.respondToQuestion(event.questionId, [['Custom answer']])
      }
    }
    expect(text).toContain('CONTINUE_DONE')
    expect(await readFile(externalFile, 'utf8')).toBe('CONTINUE_EXTERNAL_OK')
    expect(requests).toBe(3)
    expect(questions).toBe(1)
  } finally {
    await runtime.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
