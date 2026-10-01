// @vitest-environment node
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { expect, it } from 'vitest'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { OpenCodeRuntime } from './opencode-runtime'
import type { DesktopDiagnosticFailure } from '../desktop-diagnostics'

const binaryPath = join(
  process.cwd(), '.runtime-resources', process.arch,
  process.platform === 'win32' ? 'opencode.exe' : 'opencode'
)

it.skipIf(!existsSync(binaryPath))(
  'completes Execute with the real OpenCode binary when an assigned custom MCP returns HTTP 503',
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-mcp-unavailable-'))
    let modelCalls = 0
    const model = createServer((_request, response) => {
      modelCalls++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({
        id: 'unavailable', object: 'chat.completion.chunk', created: 1, model: 'unavailable',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'MCP_UNAVAILABLE_OK' }, finish_reason: 'stop' }]
      })}\n\ndata: [DONE]\n\n`)
    })
    let mcpRequests = 0
    const failureBody = 'private-mcp-failure-detail'
    const upstream = createServer((_request, response) => {
      mcpRequests++
      response.writeHead(503, { Connection: 'close' })
      response.end(failureBody)
    })
    const records: DesktopDiagnosticFailure[] = []
    const gateway = new KnowledgeMcpGateway({} as never, {
      observeFailure: failure => records.push(failure)
    })
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 30_000)
    let runtime: OpenCodeRuntime | undefined
    try {
      await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
      const modelAddress = model.address()
      const mcpAddress = upstream.address()
      if (!modelAddress || typeof modelAddress === 'string') throw new Error('No model port')
      if (!mcpAddress || typeof mcpAddress === 'string') throw new Error('No MCP port')
      await gateway.start()
      const secret = 'private-mcp-fixture-secret'
      const url = `http://127.0.0.1:${mcpAddress.port}/mcp`
      runtime = new OpenCodeRuntime({
        embedded: true, binaryPath: '', bundledBinaryPath: binaryPath,
        configPath: '', defaultWorkspace: workspace, knowledgeGateway: gateway,
        mcpServers: [{
          id: crypto.randomUUID(), name: 'Unavailable MCP', description: '',
          enabled: true, allowDynamicTools: false, assignments: ['opencode'],
          secretConfigured: true, secret, transport: 'http', url
        }],
        modelProfile: {
          id: crypto.randomUUID(), name: 'Unavailable MCP fixture', modelName: 'unavailable',
          baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
          protocol: 'openai-chat-completions', authentication: 'none'
        }
      })
      let text = ''
      let lastEventType: string | undefined
      for await (const event of runtime.run({
        requestId: crypto.randomUUID(), conversationId: crypto.randomUUID(), workMode: 'execute',
        prompt: 'Reply MCP_UNAVAILABLE_OK without tools.'
      }, controller.signal)) {
        if (event.type === 'text') text += event.delta
        lastEventType = event.type
      }
      expect(mcpRequests).toBeGreaterThan(0)
      expect(text).toBe('MCP_UNAVAILABLE_OK')
      expect(lastEventType).toBe('done')
      expect(modelCalls).toBe(1)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        code: 'runtime.mcp.failed',
        mcp: { phase: 'tool-discovery', category: 'handler-failure' }
      })
      const diagnostics = JSON.stringify(records, (_key, value) => value instanceof Error
        ? { message: value.message, stack: value.stack, cause: value.cause }
        : value)
      expect(diagnostics).not.toContain(secret)
      expect(diagnostics).not.toContain(url)
      expect(diagnostics).not.toContain(failureBody)
    } finally {
      clearTimeout(deadline)
      await runtime?.dispose()
      await gateway.dispose()
      upstream.closeAllConnections()
      model.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await new Promise<void>(resolve => model.close(() => resolve()))
      await rm(workspace, { recursive: true, force: true })
    }
  },
  60_000
)

it.skipIf(!existsSync(binaryPath))(
  'recovers a lost MCP add response with the real OpenCode binary and gateway',
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-mcp-retry-'))
    let modelCalls = 0
    const model = createServer((_request, response) => {
      modelCalls++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({
        id: 'retry', object: 'chat.completion.chunk', created: 1, model: 'retry',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'RETRY_OK' }, finish_reason: 'stop' }]
      })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    const address = model.address()
    if (!address || typeof address === 'string') throw new Error('No model port')
    const gateway = new KnowledgeMcpGateway({} as never)
    await gateway.start()
    const controller = new AbortController()
    const requestId = crypto.randomUUID()
    const token = gateway.grant(requestId, [crypto.randomUUID()], controller.signal)!
    const records: DesktopDiagnosticFailure[] = []
    const operations: string[] = []
    const registrations: Array<{ name: string; config: { headers: { Authorization: string } } }> = []
    const runtime = new OpenCodeRuntime({
      embedded: true, binaryPath: '', bundledBinaryPath: binaryPath,
      configPath: '', defaultWorkspace: workspace, knowledgeGateway: gateway,
      observeFailure: failure => records.push(failure),
      modelProfile: {
        id: crypto.randomUUID(), name: 'Retry fixture', modelName: 'retry',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        protocol: 'openai-chat-completions', authentication: 'none'
      }
    }, {
      createClient: options => createOpencodeClient({
        ...options,
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init)
          const pathname = new URL(request.url).pathname
          if (pathname === '/mcp' && request.method === 'POST') {
            const registration = await request.clone().json() as typeof registrations[number]
            registrations.push(registration)
            const response = await fetch(request, init)
            const status = await response.clone().json() as Record<string, { status: string }>
            expect(status[registration.name]?.status).toBe('connected')
            operations.push('add-connected')
            if (registrations.length === 1) {
              // The server and gateway are already connected when the response is lost.
              await response.body?.cancel()
              throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) })
            }
            return response
          }
          const response = await fetch(request, init)
          if (pathname.endsWith('/disconnect')) {
            expect(await response.clone().json()).toBe(true)
            operations.push('disconnect-succeeded')
          }
          return response
        }
      })
    })
    const deadline = setTimeout(() => controller.abort(), 30_000)
    try {
      let text = ''
      for await (const event of runtime.run({
        requestId, conversationId: crypto.randomUUID(), workMode: 'ask',
        prompt: 'Reply RETRY_OK without tools.', knowledgeCapabilityToken: token
      }, controller.signal)) {
        if (event.type === 'text') text += event.delta
      }
      expect(text).toBe('RETRY_OK')
      expect(modelCalls).toBe(1)
      expect(operations).toEqual(['add-connected', 'disconnect-succeeded', 'add-connected', 'disconnect-succeeded'])
      expect(registrations).toHaveLength(2)
      expect(registrations[1]?.name).not.toBe(registrations[0]?.name)
      expect(registrations[1]?.config).toEqual(registrations[0]?.config)
      expect(registrations[0]?.config.headers.Authorization).toBe(`Bearer ${token}`)
      expect(records).toHaveLength(1)
      expect(records[0]?.mcp).toMatchObject({
        phase: 'connect', category: 'transport-failure', attempt: 1, kind: 'builtin',
        correlationId: `sha256:${createHash('sha256').update(token).digest('hex')}`
      })
      expect(JSON.stringify(records)).not.toContain(token)
      const unauthorized = await fetch(gateway.getEndpoint()!, { method: 'POST' })
      expect(unauthorized.status).toBe(401)
      await unauthorized.body?.cancel()
    } finally {
      clearTimeout(deadline)
      await runtime.dispose()
      gateway.revoke(token)
      await gateway.dispose()
      model.closeAllConnections()
      await new Promise<void>(resolve => model.close(() => resolve()))
      await rm(workspace, { recursive: true, force: true })
    }
  },
  60_000
)

it.skipIf(!existsSync(binaryPath))(
  'keeps a later MCP connection when a timed-out OpenCode add settles afterwards',
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-mcp-late-add-'))
    let releaseModel!: () => void
    const modelReleased = new Promise<void>(resolve => { releaseModel = resolve })
    let modelStarted!: () => void
    const modelPending = new Promise<void>(resolve => { modelStarted = resolve })
    const model = createServer((_request, response) => {
      modelStarted()
      void modelReleased.then(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({
          id: 'late', object: 'chat.completion.chunk', created: 1, model: 'late',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'LATE_OK' }, finish_reason: 'stop' }]
        })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    const modelAddress = model.address()
    if (!modelAddress || typeof modelAddress === 'string') throw new Error('No model port')
    const gateway = new KnowledgeMcpGateway({} as never)
    await gateway.start()
    const upstream = new URL(gateway.getEndpoint()!)
    // Holds the first MCP initialize so OpenCode keeps initializing after the client gives up.
    let releaseInitialize!: () => void
    const initializeReleased = new Promise<void>(resolve => { releaseInitialize = resolve })
    let heldInitializeSettled!: () => void
    const heldInitializeDone = new Promise<void>(resolve => { heldInitializeSettled = resolve })
    let heldInitialize = false
    const proxy = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)
        const hold = !heldInitialize && request.method === 'POST' && body.toString().includes('"initialize"')
        if (hold) {
          heldInitialize = true
          await initializeReleased
        }
        const forwarded = httpRequest({
          host: upstream.hostname, port: upstream.port, path: request.url,
          method: request.method, headers: request.headers
        }, upstreamResponse => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
          upstreamResponse.pipe(response)
          if (hold) upstreamResponse.on('end', heldInitializeSettled)
        })
        forwarded.on('error', () => response.destroy())
        response.on('close', () => forwarded.destroy())
        forwarded.end(body)
      })().catch(() => response.destroy())
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('No proxy port')
    const proxiedGateway = new Proxy(gateway, {
      get: (target, key, receiver) => key === 'getEndpoint'
        ? () => `http://127.0.0.1:${proxyAddress.port}/mcp`
        : Reflect.get(target, key, receiver)
    })
    let client: ReturnType<typeof createOpencodeClient> | undefined
    const added: string[] = []
    const runtime = new OpenCodeRuntime({
      embedded: true, binaryPath: '', bundledBinaryPath: binaryPath,
      configPath: '', defaultWorkspace: workspace, knowledgeGateway: proxiedGateway,
      modelProfile: {
        id: crypto.randomUUID(), name: 'Late add fixture', modelName: 'late',
        baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
        protocol: 'openai-chat-completions', authentication: 'none'
      }
    }, {
      controlRequestTimeoutMs: 3_000,
      createClient: options => {
        client = createOpencodeClient({
          ...options,
          fetch: async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init)
            if (new URL(request.url).pathname === '/mcp' && request.method === 'POST') {
              added.push((await request.clone().json() as { name: string }).name)
            }
            return fetch(request, init)
          }
        })
        return client
      }
    })
    const conversationId = crypto.randomUUID()
    const run = async (): Promise<string> => {
      const controller = new AbortController()
      const token = gateway.grant(crypto.randomUUID(), [crypto.randomUUID()], controller.signal)!
      const deadline = setTimeout(() => controller.abort(), 30_000)
      let text = ''
      try {
        for await (const event of runtime.run({
          requestId: crypto.randomUUID(), conversationId, workMode: 'ask',
          prompt: 'Reply LATE_OK without tools.', knowledgeCapabilityToken: token
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
      await expect(run()).rejects.toThrow('超时')
      expect(added).toHaveLength(1)
      const second = run()
      await modelPending
      expect(added).toHaveLength(2)
      expect((await client!.mcp.status({ directory: workspace })).data?.[added[1]!]?.status).toBe('connected')
      // The late add now finishes with a revoked token while the second request is live.
      releaseInitialize()
      await heldInitializeDone
      await new Promise(resolve => setTimeout(resolve, 500))
      const status = await client!.mcp.status({ directory: workspace })
      expect(status.data?.[added[1]!]?.status).toBe('connected')
      expect(added[1]).not.toBe(added[0])
      releaseModel()
      await expect(second).resolves.toBe('LATE_OK')
    } finally {
      releaseInitialize()
      releaseModel()
      await runtime.dispose()
      await gateway.dispose()
      proxy.closeAllConnections()
      model.closeAllConnections()
      await new Promise<void>(resolve => proxy.close(() => resolve()))
      await new Promise<void>(resolve => model.close(() => resolve()))
      await rm(workspace, { recursive: true, force: true })
    }
  },
  90_000
)

it.skipIf(!existsSync(binaryPath))(
  'closes real event streams after parallel runs and compaction without cancelling a peer',
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
    let delayedAbort: Promise<void> | undefined
    let abortStarted: (() => void) | undefined
    let promptCount = 0
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
          const url = request instanceof Request ? request.url : request
          const pathname = new URL(url).pathname
          if (pathname.endsWith('/abort') && delayedAbort) {
            abortStarted?.()
            await delayedAbort
          }
          if (pathname.endsWith('/prompt_async')) promptCount++
          const response = await fetch(request, init)
          if (new URL(url).pathname !== '/event' || !response.body) return response
          openEventBodies++
          const reader = response.body.getReader()
          let closed = false
          const close = (): void => {
            if (!closed) openEventBodies--
            closed = true
          }
          // The wrapper may stay full after fetch aborts, with no further pull.
          void reader.closed.then(close, close)
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
    const run = async (
      controller = new AbortController(),
      cancel = false,
      conversationId = crypto.randomUUID()
    ): Promise<string> => {
      const requestId = crypto.randomUUID()
      const token = gateway.grant(requestId, [crypto.randomUUID()], controller.signal)!
      const deadline = setTimeout(() => controller.abort(), 30_000)
      let text = ''
      try {
        for await (const event of runtime.run({
          requestId, conversationId, workMode: 'ask',
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
      let releaseAbort!: () => void
      delayedAbort = new Promise<void>((resolve) => { releaseAbort = resolve })
      const abortPending = new Promise<void>((resolve) => { abortStarted = resolve })
      const reusedConversation = crypto.randomUUID()
      cancelledController = new AbortController()
      const first = run(cancelledController, true, reusedConversation).catch((error: unknown) => error)
      let second: Promise<string> | undefined
      try {
        await abortPending
        const beforeResend = promptCount
        second = run(new AbortController(), false, reusedConversation)
        await new Promise((resolve) => setTimeout(resolve, 100))
        const beforeAbortCompletes = promptCount
        releaseAbort()
        expect(await first).toMatchObject({ name: 'AbortError' })
        await expect(second).resolves.toBe('LIFECYCLE_OK')
        expect(beforeAbortCompletes).toBe(beforeResend)
        expect(promptCount).toBe(beforeResend + 1)
        await expect.poll(() => openEventBodies).toBe(0)
      } finally {
        releaseAbort()
        await Promise.allSettled([first, second])
        delayedAbort = undefined
      }
      const conversationId = crypto.randomUUID()
      await expect(run(new AbortController(), false, conversationId)).resolves.toBe('LIFECYCLE_OK')
      await expect(runtime.compactConversation({
        requestId: crypto.randomUUID(),
        conversationId,
        runtimeSelection: { provider: 'opencode' },
        history: [],
        historyMessageIds: []
      }, new AbortController().signal)).resolves.toMatchObject({
        result: { compacted: true }
      })
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
