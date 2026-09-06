// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { expect, it } from 'vitest'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { OpenCodeRuntime } from './opencode-runtime'

const binaryPath = join(
  process.cwd(), '.runtime-resources', process.arch,
  process.platform === 'win32' ? 'opencode.exe' : 'opencode'
)

it.skipIf(!existsSync(binaryPath))(
  'closes real event streams after parallel runs without cancelling a peer',
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-lifecycle-'))
    let cancelledController: AbortController | undefined
    const model = createServer((request, response) => {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += chunk.toString()
        if (body.includes('CANCEL_LIFECYCLE')) {
          setTimeout(() => cancelledController?.abort(
            new DOMException('Cancelled', 'AbortError')
          ), 30)
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const [delta, finishReason] of [
          [{ role: 'assistant', content: 'LIFECYCLE_OK' }, null],
          [{}, 'stop']
        ]) {
          response.write(`data: ${JSON.stringify({
            id: 'lifecycle', object: 'chat.completion.chunk', created: 1,
            model: 'lifecycle',
            choices: [{ index: 0, delta, finish_reason: finishReason }]
          })}\n\n`)
        }
        response.end('data: [DONE]\n\n')
      })().catch(() => response.destroy())
    })
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    const address = model.address()
    if (!address || typeof address === 'string') throw new Error('No model port')
    const gateway = new KnowledgeMcpGateway({} as never)
    await gateway.start()
    let openEventBodies = 0
    const runtime = new OpenCodeRuntime({
      embedded: true, binaryPath: '', bundledBinaryPath: binaryPath,
      configPath: '', defaultWorkspace: workspace, knowledgeGateway: gateway,
      modelProfile: {
        id: crypto.randomUUID(), name: 'Lifecycle fixture', modelName: 'lifecycle',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        protocol: 'openai-chat-completions', authentication: 'none'
      }
    }, {
      createClient: (options) => createOpencodeClient({
        ...options,
        fetch: async (request, init) => {
          const response = await fetch(request, init)
          const url = request instanceof Request ? request.url : request
          if (new URL(url).pathname !== '/event' || !response.body) return response
          openEventBodies++
          const reader = response.body.getReader()
          let closed = false
          const close = (): void => {
            if (!closed) openEventBodies--
            closed = true
          }
          return new Response(new ReadableStream({
            async pull(controller) {
              try {
                const item = await reader.read()
                if (item.done) {
                  close()
                  controller.close()
                } else controller.enqueue(item.value)
              } catch (error) {
                close()
                controller.error(error)
              }
            },
            async cancel(reason) {
              close()
              await reader.cancel(reason)
            }
          }), { status: response.status, headers: response.headers })
        }
      })
    })
    const run = async (controller = new AbortController(), cancel = false): Promise<string> => {
      const requestId = crypto.randomUUID()
      const token = gateway.grant(requestId, [crypto.randomUUID()], controller.signal)!
      const deadline = setTimeout(() => controller.abort(), 30_000)
      let text = ''
      try {
        for await (const event of runtime.run({
          requestId, conversationId: crypto.randomUUID(), workMode: 'ask',
          prompt: cancel ? 'CANCEL_LIFECYCLE' : 'Reply LIFECYCLE_OK without tools.',
          knowledgeCapabilityToken: token
        }, controller.signal)) {
          if (event.type === 'text') text += event.delta
        }
        return text
      } finally {
        clearTimeout(deadline)
        gateway.revoke(token)
      }
    }
    try {
      for (const concurrency of [1, 4, 8]) {
        const results = await Promise.all(Array.from({ length: concurrency }, () => run()))
        expect(results).toEqual(Array(concurrency).fill('LIFECYCLE_OK'))
        await expect.poll(() => openEventBodies).toBe(0)
      }
      cancelledController = new AbortController()
      const cancelled = run(cancelledController, true)
      await Promise.all([
        expect(cancelled).rejects.toMatchObject({ name: 'AbortError' }),
        expect(run()).resolves.toBe('LIFECYCLE_OK')
      ])
      await expect.poll(() => openEventBodies).toBe(0)
    } finally {
      await runtime.dispose()
      await gateway.dispose()
      model.closeAllConnections()
      await new Promise<void>((resolve) => model.close(() => resolve()))
      await rm(workspace, { recursive: true, force: true })
    }
  },
  120_000
)
