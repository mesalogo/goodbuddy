import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import {
  request as httpRequest,
  type RequestOptions
} from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_MODEL_GATEWAY_LIMITS,
  type RemoteModelGatewayRequest,
  type RemoteModelGatewayResponse
} from '../shared/remote-model-gateway-contracts'
import {
  createOpenCodeModelBridgeProviderConfig,
  MODEL_BRIDGE_SDK_AUTH_SENTINEL,
  ModelBridgeLoopbackProxy
} from './model-bridge-helper'
import {
  createUnixModelBridgeExchange,
  MODEL_BRIDGE_BROKER_SOCKET_NAME,
  ModelBridgeBrokerServer,
  type ModelBridgeExchange
} from './model-bridge-broker'

const temporaryPaths: string[] = []
const modelBridgeRouteToken = 'A'.repeat(43)
const validResponse: RemoteModelGatewayResponse = {
  status: 201,
  headers: {
    'content-type': 'application/json',
    'x-request-id': 'provider-request'
  },
  bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString(
    'base64'
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('model bridge loopback helper', () => {
  it('forwards only the bounded request contract and returns the response', async () => {
    const exchange = vi.fn<ModelBridgeExchange>(
      async () => validResponse
    )
    const proxy = new ModelBridgeLoopbackProxy({ exchange })
    const origin = await proxy.listen()
    try {
      const response = await sendHttp(origin, {
        path: '/v1/messages',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': MODEL_BRIDGE_SDK_AUTH_SENTINEL
        },
        body: '{"model":"private-model","messages":[]}'
      })

      expect(response).toEqual({
        status: 201,
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-request-id': 'provider-request'
        }),
        body: '{"ok":true}'
      })
      expect(exchange).toHaveBeenCalledOnce()
      const [request, context] = exchange.mock.calls[0]!
      expect(request).toEqual({
        method: 'POST',
        path: '/v1/messages',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        bodyBase64: Buffer.from(
          '{"model":"private-model","messages":[]}',
          'utf8'
        ).toString('base64')
      })
      expect(context.requestId).toMatch(/^model-/u)
      expect(context.signal.aborted).toBe(false)
    } finally {
      await proxy.close()
    }
  })

  it('acknowledges delivery only after the HTTP response flushes', async () => {
    const acknowledgeDelivery = vi.fn(async () => undefined)
    const failDelivery = vi.fn(async () => undefined)
    const proxy = new ModelBridgeLoopbackProxy({
      exchange: async () => ({
        response: validResponse,
        acknowledgeDelivery,
        failDelivery
      })
    })
    const origin = await proxy.listen()
    try {
      const response = await sendHttp(origin, {
        path: '/v1/messages',
        body: '{}'
      })
      expect(response.body).toBe('{"ok":true}')
      expect(acknowledgeDelivery).toHaveBeenCalledOnce()
      expect(failDelivery).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
    }
  })

  it('flushes and acknowledges a multi-frame-sized HTTP response', async () => {
    const body = Buffer.alloc(600 * 1024, 0x61)
    const acknowledgeDelivery = vi.fn(async () => undefined)
    const failDelivery = vi.fn(async () => undefined)
    const proxy = new ModelBridgeLoopbackProxy({
      exchange: async () => ({
        response: {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          bodyBase64: body.toString('base64')
        },
        acknowledgeDelivery,
        failDelivery
      })
    })
    const origin = await proxy.listen()
    try {
      const response = await sendHttp(origin, {
        path: '/v1/messages',
        body: '{}'
      })
      expect(Buffer.byteLength(response.body)).toBe(body.byteLength)
      expect(acknowledgeDelivery).toHaveBeenCalledOnce()
      expect(failDelivery).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
    }
  })

  it.each([
    {
      name: 'non-POST method',
      request: { method: 'GET', path: '/v1/messages' },
      status: 405
    },
    {
      name: 'unknown path',
      request: { path: '/images/generations' },
      status: 404
    },
    {
      name: 'path query',
      request: { path: '/v1/messages?token=secret' },
      status: 404
    },
    {
      name: 'credential header',
      request: {
        path: '/v1/messages',
        headers: { authorization: 'Bearer remote-secret' }
      },
      status: 400
    }
  ])('rejects $name without dispatch', async ({ request, status }) => {
    const exchange = vi.fn(async () => validResponse)
    const proxy = new ModelBridgeLoopbackProxy({ exchange })
    const origin = await proxy.listen()
    try {
      const response = await sendHttp(origin, request)
      expect(response.status).toBe(status)
      expect(response.body).not.toContain('remote-secret')
      expect(exchange).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
    }
  })

  it('rejects a declared oversized body before dispatch', async () => {
    const exchange = vi.fn(async () => validResponse)
    const proxy = new ModelBridgeLoopbackProxy({ exchange })
    const origin = await proxy.listen()
    try {
      const response = await sendHttp(origin, {
        path: '/v1/messages',
        headers: {
          'content-length': String(
            REMOTE_MODEL_GATEWAY_LIMITS.maximumRequestBodyBytes + 1
          )
        },
        body: ''
      })
      expect(response.status).toBe(413)
      expect(exchange).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
    }
  })

  it('rejects loopback requests without the per-helper route capability', async () => {
    const exchange = vi.fn(async () => validResponse)
    const proxy = new ModelBridgeLoopbackProxy({ exchange })
    const origin = await proxy.listen()
    try {
      const response = await sendHttp(origin, {
        authenticated: false,
        path: '/v1/messages',
        headers: {
          'x-api-key': MODEL_BRIDGE_SDK_AUTH_SENTINEL
        },
        body: '{}'
      })

      expect(response.status).toBe(404)
      expect(exchange).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
    }
  })

  it('drops harmless SDK metadata headers but rejects chunked framing', async () => {
    const exchange = vi.fn<ModelBridgeExchange>(
      async () => validResponse
    )
    const proxy = new ModelBridgeLoopbackProxy({ exchange })
    const origin = await proxy.listen()
    try {
      const accepted = await sendHttp(origin, {
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-stainless-runtime': 'node'
        },
        body: '{}'
      })
      expect(accepted.status).toBe(201)
      expect(exchange).toHaveBeenCalledOnce()
      expect(exchange.mock.calls[0]![0].headers).toEqual({
        'content-type': 'application/json'
      })

      const rejected = await sendHttp(origin, {
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked'
        },
        body: '{}'
      })
      expect(rejected.status).toBe(400)
      expect(exchange).toHaveBeenCalledOnce()
    } finally {
      await proxy.close()
    }
  })

  it('accepts only the fixed SDK compatibility marker and strips it', async () => {
    const exchange = vi.fn<ModelBridgeExchange>(
      async () => validResponse
    )
    const proxy = new ModelBridgeLoopbackProxy({ exchange })
    const origin = await proxy.listen()
    try {
      const accepted = await sendHttp(origin, {
        path: '/v1/responses',
        headers: {
          authorization: `Bearer ${MODEL_BRIDGE_SDK_AUTH_SENTINEL}`
        },
        body: '{}'
      })
      expect(accepted.status).toBe(201)
      expect(exchange).toHaveBeenCalledOnce()
      expect(exchange.mock.calls[0]![0].headers).toEqual({})

      for (const authorization of [
        'Bearer remote-secret',
        `Basic ${MODEL_BRIDGE_SDK_AUTH_SENTINEL}`
      ]) {
        const rejected = await sendHttp(origin, {
          path: '/v1/responses',
          headers: { authorization },
          body: '{}'
        })
        expect(rejected.status).toBe(400)
      }
      expect(exchange).toHaveBeenCalledOnce()
    } finally {
      await proxy.close()
    }
  })

  it('times out once, aborts dispatch, and never returns raw errors', async () => {
    let dispatchSignal: AbortSignal | undefined
    const exchange = vi.fn(
      async (
        _request: RemoteModelGatewayRequest,
        context: { signal: AbortSignal }
      ) => {
        dispatchSignal = context.signal
        await new Promise(() => undefined)
        return validResponse
      }
    )
    const proxy = new ModelBridgeLoopbackProxy({
      exchange,
      requestTimeoutMs: 20
    })
    const origin = await proxy.listen()
    try {
      const response = await sendHttp(origin, {
        path: '/v1/messages',
        body: '{}'
      })
      expect(response.status).toBe(504)
      expect(response.body).toBe(
        '{"error":{"code":"bridge-timeout"}}'
      )
      expect(dispatchSignal?.aborted).toBe(true)
      expect(exchange).toHaveBeenCalledOnce()
    } finally {
      await proxy.close()
    }
  })

  it('maps dispatch errors without leaking credentials', async () => {
    const privateValue = 'provider-key-do-not-leak'
    const proxy = new ModelBridgeLoopbackProxy({
      exchange: async () => {
        throw new Error(`Upstream used ${privateValue}`)
      }
    })
    const origin = await proxy.listen()
    try {
      const response = await sendHttp(origin, {
        path: '/v1/messages',
        body: '{}'
      })
      expect(response.status).toBe(502)
      expect(response.body).toBe(
        '{"error":{"code":"bridge-failed"}}'
      )
      expect(response.body).not.toContain(privateValue)
    } finally {
      await proxy.close()
    }
  })

  it('queues concurrent OpenCode requests instead of returning bridge-busy', async () => {
    let markStarted: (() => void) | undefined
    let releaseFirst: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let callIndex = 0
    const exchange = vi.fn(async () => {
      const index = callIndex++
      if (index === 0) {
        markStarted?.()
        await firstGate
      }
      return validResponse
    })
    const proxy = new ModelBridgeLoopbackProxy({
      exchange
    })
    const origin = await proxy.listen()
    const first = sendHttp(origin, {
      path: '/v1/messages',
      body: '{}'
    })
    await started
    const second = sendHttp(origin, {
      path: '/v1/messages',
      body: '{}'
    })
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(exchange).toHaveBeenCalledOnce()
      releaseFirst?.()
      await expect(first).resolves.toMatchObject({ status: 201 })
      await expect(second).resolves.toMatchObject({ status: 201 })
      expect(exchange).toHaveBeenCalledTimes(2)
    } finally {
      await proxy.close()
    }
  })

  it('aborts an in-flight dispatch when the proxy closes', async () => {
    let dispatchSignal: AbortSignal | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted
    })
    const proxy = new ModelBridgeLoopbackProxy({
      exchange: async (_request, context) => {
        dispatchSignal = context.signal
        markStarted?.()
        await new Promise(() => undefined)
        return validResponse
      }
    })
    const origin = await proxy.listen()
    const pending = sendHttp(origin, {
      path: '/v1/messages',
      body: '{}'
    }).catch(() => undefined)
    await started

    await proxy.close()
    await pending
    expect(dispatchSignal?.aborted).toBe(true)
  })

  it.each([
    {
      protocol: 'anthropic-messages' as const,
      providerId: 'goodbuddy-anthropic',
      npm: '@ai-sdk/anthropic',
      requiresSdkAuthSentinel: true
    },
    {
      protocol: 'openai-chat-completions' as const,
      providerId: 'goodbuddy-openai-chat',
      npm: '@ai-sdk/openai-compatible',
      requiresSdkAuthSentinel: false
    },
    {
      protocol: 'openai-responses' as const,
      providerId: 'goodbuddy-openai-responses',
      npm: '@ai-sdk/openai',
      requiresSdkAuthSentinel: true
    }
  ])(
    'creates secret-free $protocol OpenCode metadata',
    ({ protocol, providerId, npm, requiresSdkAuthSentinel }) => {
      const config = createOpenCodeModelBridgeProviderConfig({
        protocol,
        model: 'private-model',
        name: 'Private model',
        loopbackOrigin:
          `http://127.0.0.1:12345/${modelBridgeRouteToken}`,
        supportsImageInput: true
      })

      expect(config).toMatchObject({
        model: `${providerId}/private-model`,
        agent: {
          title: {
            disable: true
          }
        },
        provider: {
          [providerId]: {
            npm,
            options: {
              baseURL:
                `http://127.0.0.1:12345/${modelBridgeRouteToken}/v1`
            },
            models: {
              'private-model': {
                attachment: true,
                provider: { npm }
              }
            }
          }
        }
      })
      const options = config.provider[providerId]!.options
      expect(options.apiKey).toBe(
        requiresSdkAuthSentinel
          ? MODEL_BRIDGE_SDK_AUTH_SENTINEL
          : undefined
      )
      expect(JSON.stringify(config)).not.toContain('provider.example')
    }
  )
})

describe('model bridge Unix broker', () => {
  const runOnUnix = process.platform === 'win32' ? it.skip : it

  runOnUnix('rejects a socket path beyond the Unix kernel limit', () => {
    const scratch = resolve(
      privateTemporaryDirectory(),
      'a'.repeat(150)
    )
    expect(
      () =>
        new ModelBridgeBrokerServer({
          scratchDirectory: scratch,
          dispatch: async () => validResponse
        })
    ).toThrow('endpoint path is too long')
  })

  runOnUnix(
    'uses a private owned socket, exchanges one request, and cleans up',
    async () => {
      const scratch = privateTemporaryDirectory()
      const dispatch = vi.fn(async () => validResponse)
      const broker = new ModelBridgeBrokerServer({
        scratchDirectory: scratch,
        dispatch
      })
      await broker.listen()
      const socketPath = resolve(
        scratch,
        MODEL_BRIDGE_BROKER_SOCKET_NAME
      )
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o600)

      const exchange = createUnixModelBridgeExchange({
        socketPath,
        requestTimeoutMs: 1_000
      })
      const request: RemoteModelGatewayRequest = {
        method: 'POST',
        path: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from('{}').toString('base64')
      }
      const exchanged = await exchange(request, {
        requestId: 'request-a',
        signal: new AbortController().signal
      })
      expect(
        'response' in exchanged ? exchanged.response : exchanged
      ).toEqual(validResponse)
      if ('response' in exchanged) {
        await exchanged.acknowledgeDelivery()
      }
      expect(dispatch).toHaveBeenCalledWith(request, {
        requestId: 'request-a',
        signal: expect.any(AbortSignal)
      })

      await broker.close()
      expect(existsSync(socketPath)).toBe(false)
    }
  )

  runOnUnix(
    'drains a response larger than the Unix socket receive buffer',
    async () => {
      const scratch = privateTemporaryDirectory()
      const responseBody = Buffer.alloc(256 * 1024, 0x61)
      const broker = new ModelBridgeBrokerServer({
        scratchDirectory: scratch,
        dispatch: async () => ({
          ...validResponse,
          bodyBase64: responseBody.toString('base64')
        })
      })
      await broker.listen()
      try {
        const exchange = createUnixModelBridgeExchange({
          socketPath: broker.socketPath,
          requestTimeoutMs: 2_000
        })
        const exchanged = await exchange(
          {
            method: 'POST',
            path: '/v1/responses',
            headers: { 'content-type': 'application/json' },
            bodyBase64: Buffer.from('{}').toString('base64')
          },
          {
            requestId: 'request-large-response',
            signal: new AbortController().signal
          }
        )
        expect('response' in exchanged).toBe(true)
        if ('response' in exchanged) {
          expect(
            Buffer.from(
              exchanged.response.bodyBase64,
              'base64'
            ).byteLength
          ).toBe(responseBody.byteLength)
          await exchanged.acknowledgeDelivery()
        }
      } finally {
        await broker.close()
      }
    }
  )

  runOnUnix(
    'refuses to replace or remove a non-socket endpoint path',
    async () => {
      const scratch = privateTemporaryDirectory()
      const socketPath = join(
        scratch,
        MODEL_BRIDGE_BROKER_SOCKET_NAME
      )
      writeFileSync(socketPath, 'user-owned')
      chmodSync(socketPath, 0o600)
      const broker = new ModelBridgeBrokerServer({
        scratchDirectory: scratch,
        dispatch: async () => validResponse
      })

      await expect(broker.listen()).rejects.toThrow(
        'not an owned Unix socket'
      )
      await broker.close()
      expect(existsSync(socketPath)).toBe(true)
    }
  )

  runOnUnix(
    'bounds dispatch time and forwards only a generic failure code',
    async () => {
      const scratch = privateTemporaryDirectory()
      const privateValue = 'provider-secret-in-error'
      let dispatchSignal: AbortSignal | undefined
      const broker = new ModelBridgeBrokerServer({
        scratchDirectory: scratch,
        requestTimeoutMs: 20,
        dispatch: async (_request, context) => {
          dispatchSignal = context.signal
          await new Promise(() => undefined)
          throw new Error(privateValue)
        }
      })
      await broker.listen()
      try {
        const exchange = createUnixModelBridgeExchange({
          socketPath: broker.socketPath,
          requestTimeoutMs: 1_000
        })
        await expect(
          exchange(
            {
              method: 'POST',
              path: '/v1/messages',
              headers: {},
              bodyBase64: ''
            },
            {
              requestId: 'request-timeout',
              signal: new AbortController().signal
            }
          )
        ).rejects.toMatchObject({
          code: 'request-timeout',
          message: 'Model bridge request timed out'
        })
        expect(dispatchSignal?.aborted).toBe(true)
      } finally {
        await broker.close()
      }
    }
  )
})

function privateTemporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-model-bridge-'))
  temporaryPaths.push(path)
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return resolve(path)
}

async function sendHttp(
  origin: string,
  options: {
    method?: string
    path?: string
    authenticated?: boolean
    headers?: Record<string, string>
    body?: string
  }
): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}> {
  const url = new URL(origin)
  const body = options.body ?? ''
  const requestPath = options.path ?? '/v1/messages'
  const basePath =
    url.pathname === '/'
      ? ''
      : url.pathname.replace(/\/$/u, '')
  const requestOptions: RequestOptions = {
    hostname: url.hostname,
    port: url.port,
    method: options.method ?? 'POST',
    path:
      options.authenticated === false
        ? requestPath
        : `${basePath}${requestPath}`,
    headers: {
      ...(options.headers ?? {}),
      ...(!hasHeader(options.headers, 'content-length') &&
      !hasHeader(options.headers, 'transfer-encoding')
        ? { 'content-length': Buffer.byteLength(body) }
        : {})
    }
  }
  return await new Promise((resolveResponse, reject) => {
    const request = httpRequest(requestOptions, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        resolveResponse({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    })
    request.once('error', reject)
    request.end(body)
  })
}

function hasHeader(
  headers: Record<string, string> | undefined,
  expected: string
): boolean {
  return Object.keys(headers ?? {}).some(
    (name) => name.toLowerCase() === expected
  )
}
