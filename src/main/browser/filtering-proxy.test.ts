import {
  Server,
  createServer as createHttpServer,
  request as httpRequest
} from 'node:http'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import type { AddressInfo, NetConnectOpts, Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserUrlPolicy } from './browser-url-policy'
import { FilteringProxy } from './filtering-proxy'

const disposals: Array<() => Promise<void>> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(async () => {
  await Promise.allSettled(disposals.splice(0).map((dispose) => dispose()))
})

function closeServer(server: {
  close(callback: (error?: Error) => void): void
}): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function listen(server: {
  listen(port: number, host: string, callback: () => void): void
  address(): string | AddressInfo | null
}): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind')
  }
  return address.port
}

describe('FilteringProxy', () => {
  it('contains tunnel socket closure errors but still surfaces listen failures', async () => {
    const upstreams: PassThrough[] = []
    const policy = {
      validate: vi.fn(async (url: URL) => ({
        url,
        origin: url.origin,
        addresses: [{ address: '127.0.0.1', family: 4 as const }]
      }))
    } as unknown as BrowserUrlPolicy
    const proxy = new FilteringProxy({
      policy,
      connect: () => {
        const upstream = new PassThrough()
        upstreams.push(upstream)
        return upstream as unknown as Socket
      }
    })
    disposals.push(() => proxy.dispose())
    const handleConnect = (
      proxy as unknown as {
        handleConnect(
          request: { url: string },
          client: PassThrough,
          head: Buffer
        ): Promise<void>
      }
    ).handleConnect.bind(proxy)

    for (const code of ['ECONNABORTED', 'ECONNRESET', 'EPIPE']) {
      for (const failingSide of ['client', 'upstream'] as const) {
        const client = new PassThrough()
        await handleConnect(
          { url: 'example.com:443' },
          client,
          Buffer.alloc(0)
        )
        const upstream = upstreams.at(-1)
        expect(upstream).toBeDefined()
        upstream?.emit('connect')
        const socketError = Object.assign(new Error(`write ${code}`), {
          code
        })

        expect(() =>
          (failingSide === 'client' ? client : upstream)?.emit(
            'error',
            socketError
          )
        ).not.toThrow()
        expect(client.destroyed).toBe(true)
        expect(upstream?.destroyed).toBe(true)
      }
    }

    const listenFailure = Object.assign(new Error('listen denied'), {
      code: 'EACCES'
    })
    const listen = vi
      .spyOn(Server.prototype, 'listen')
      .mockImplementation(function (this: Server) {
        queueMicrotask(() => this.emit('error', listenFailure))
        return this
      } as typeof Server.prototype.listen)
    const failedProxy = new FilteringProxy({ policy })

    await expect(failedProxy.start()).rejects.toMatchObject({
      message: '浏览器过滤代理启动失败',
      cause: listenFailure
    })
    expect(listen).toHaveBeenCalled()
    listen.mockRestore()
  })

  it('binds only to loopback, pins HTTP to the validated address, and strips credentials', async () => {
    let receivedAuthorization: string | undefined
    const upstream = createHttpServer((request, response) => {
      receivedAuthorization = request.headers.authorization
      response.end('safe')
    })
    const upstreamPort = await listen(upstream)
    disposals.push(() => closeServer(upstream))
    const policy = {
      validate: vi.fn(async (url: URL) => ({
        url,
        origin: url.origin,
        addresses: [{ address: '127.0.0.1', family: 4 as const }]
      }))
    } as unknown as BrowserUrlPolicy
    const proxy = new FilteringProxy({ policy })
    disposals.push(() => proxy.dispose())
    const proxyUrl = new URL(await proxy.start())
    expect(proxyUrl.hostname).toBe('127.0.0.1')

    const body = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        {
          host: proxyUrl.hostname,
          port: proxyUrl.port,
          method: 'GET',
          path: `http://example.com:${upstreamPort}/resource`,
          headers: {
            authorization: 'Bearer secret',
            'proxy-authorization': 'Basic secret'
          }
        },
        (response) => {
          let value = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            value += chunk
          })
          response.on('end', () => resolve(value))
        }
      )
      request.once('error', reject)
      request.end()
    })

    expect(body).toBe('safe')
    expect(receivedAuthorization).toBeUndefined()
    expect(policy.validate).toHaveBeenCalled()
  })

  it('contains aborted upstream HTTP responses', async () => {
    const upstream = createHttpServer((_request, response) => {
      response.writeHead(200)
      response.write('partial')
      response.socket?.destroy()
    })
    const upstreamPort = await listen(upstream)
    disposals.push(() => closeServer(upstream))
    const policy = {
      validate: vi.fn(async (url: URL) => ({
        url,
        origin: url.origin,
        addresses: [{ address: '127.0.0.1', family: 4 as const }]
      }))
    } as unknown as BrowserUrlPolicy
    const proxy = new FilteringProxy({ policy })
    disposals.push(() => proxy.dispose())
    const proxyUrl = new URL(await proxy.start())

    await new Promise<void>((resolve) => {
      const request = httpRequest(
        {
          host: proxyUrl.hostname,
          port: proxyUrl.port,
          path: `http://example.com:${upstreamPort}/aborted`
        },
        (response) => {
          response.resume()
          response.once('aborted', resolve)
          response.once('error', resolve)
          response.once('end', resolve)
        }
      )
      request.once('error', () => resolve())
      request.end()
    })
  })

  it('does not create an upstream HTTP request after the client disconnects during validation', async () => {
    const upstreamRequest = vi.fn()
    const upstream = createHttpServer(upstreamRequest)
    const upstreamPort = await listen(upstream)
    disposals.push(() => closeServer(upstream))
    const validation = deferred<{
      url: URL
      origin: string
      addresses: Array<{ address: string; family: 4 }>
    }>()
    const policy = {
      validate: vi.fn(() => validation.promise)
    } as unknown as BrowserUrlPolicy
    const proxy = new FilteringProxy({ policy })
    disposals.push(() => proxy.dispose())
    const proxyUrl = new URL(await proxy.start())
    const request = httpRequest({
      host: proxyUrl.hostname,
      port: proxyUrl.port,
      path: `http://example.com:${upstreamPort}/cancelled`
    })
    request.once('error', () => undefined)
    request.end()
    await vi.waitFor(() => expect(policy.validate).toHaveBeenCalledOnce())

    request.destroy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    validation.resolve({
      url: new URL(`http://example.com:${upstreamPort}/cancelled`),
      origin: `http://example.com:${upstreamPort}`,
      addresses: [{ address: '127.0.0.1', family: 4 }]
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(upstreamRequest).not.toHaveBeenCalled()
  })

  it('pins CONNECT TCP destinations while leaving TLS hostname handling to the client', async () => {
    const upstream = createNetServer((socket) => socket.pipe(socket))
    const upstreamPort = await listen(upstream)
    disposals.push(() => closeServer(upstream))
    const policy = {
      validate: vi.fn(async (url: URL) => ({
        url,
        origin: url.origin,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      }))
    } as unknown as BrowserUrlPolicy
    let requestedOptions: NetConnectOpts | undefined
    const connect = vi.fn((options: NetConnectOpts): Socket => {
      requestedOptions = options
      return netConnect({
          host: '127.0.0.1',
          port: upstreamPort,
          family: 4
        })
    })
    const proxy = new FilteringProxy({ policy, connect })
    disposals.push(() => proxy.dispose())
    const proxyUrl = new URL(await proxy.start())

    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = netConnect({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port)
      })
      let response = ''
      let tunnelReady = false
      socket.setEncoding('utf8')
      socket.once('error', reject)
      socket.on('data', (chunk: string) => {
        response += chunk
        if (!tunnelReady && response.includes('\r\n\r\n')) {
          tunnelReady = true
          response = ''
          socket.write('tls-bytes')
        } else if (tunnelReady && response.includes('tls-bytes')) {
          socket.destroy()
          resolve(response)
        }
      })
      socket.once('connect', () => {
        socket.write(
          `CONNECT example.com:${upstreamPort} HTTP/1.1\r\nHost: example.com\r\n\r\n`
        )
      })
    })

    expect(echoed).toContain('tls-bytes')
    expect(requestedOptions).toEqual({
      host: '93.184.216.34',
      port: upstreamPort,
      family: 4
    })
  })

  it('fails closed when validation rejects and bounds active connections', async () => {
    const policy = {
      validate: vi.fn(async () => {
        throw new Error('blocked')
      })
    } as unknown as BrowserUrlPolicy
    const proxy = new FilteringProxy({
      policy,
      maximumConnections: 1
    })
    disposals.push(() => proxy.dispose())
    const proxyUrl = new URL(await proxy.start())

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          host: proxyUrl.hostname,
          port: proxyUrl.port,
          path: 'http://example.com/'
        },
        (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode))
        }
      )
      request.once('error', reject)
      request.end()
    })
    expect(status).toBe(403)
    await proxy.dispose()
    await expect(proxy.start()).rejects.toThrow('已关闭')
  })

  it('holds request reservations until slow upstream responses complete', async () => {
    const releaseUpstream = deferred<void>()
    let upstreamRequests = 0
    const upstream = createHttpServer(async (_request, response) => {
      upstreamRequests += 1
      await releaseUpstream.promise
      response.end('done')
    })
    const upstreamPort = await listen(upstream)
    disposals.push(() => closeServer(upstream))
    const policy = {
      validate: vi.fn(async (url: URL) => ({
        url,
        origin: url.origin,
        addresses: [{ address: '127.0.0.1', family: 4 as const }]
      }))
    } as unknown as BrowserUrlPolicy
    const proxy = new FilteringProxy({ policy, maximumConnections: 1 })
    disposals.push(() => proxy.dispose())
    const proxyUrl = new URL(await proxy.start())
    const requestStatus = (): Promise<number | undefined> =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            host: proxyUrl.hostname,
            port: proxyUrl.port,
            path: `http://example.com:${upstreamPort}/slow`
          },
          (response) => {
            response.resume()
            response.once('end', () => resolve(response.statusCode))
          }
        )
        request.once('error', reject)
        request.end()
      })

    const first = requestStatus()
    await vi.waitFor(() => expect(upstreamRequests).toBe(1))
    const rejected = await Promise.all(
      Array.from({ length: 12 }, () => requestStatus())
    )
    expect(rejected).toEqual(Array.from({ length: 12 }, () => 503))
    expect(upstreamRequests).toBe(1)

    releaseUpstream.resolve()
    await expect(first).resolves.toBe(200)
    await expect(requestStatus()).resolves.toBe(200)
    expect(upstreamRequests).toBe(2)
  })
})
