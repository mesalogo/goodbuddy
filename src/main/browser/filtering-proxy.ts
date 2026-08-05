import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { NetConnectOpts, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { BrowserUrlPolicy, type ValidatedBrowserUrl } from './browser-url-policy'

export type FilteringProxyOptions = {
  policy: BrowserUrlPolicy
  maximumConnections?: number
  maximumRequestBytes?: number
  connect?: (options: NetConnectOpts) => Socket
}

type ActiveStream = {
  destroy(error?: Error): void
}

function rejectHttp(response: ServerResponse, status = 403): void {
  if (!response.headersSent) {
    response.writeHead(status, {
      connection: 'close',
      'content-type': 'text/plain; charset=utf-8'
    })
  }
  response.end('Request blocked')
}

function stripProxyHeaders(
  headers: IncomingMessage['headers']
): Record<string, string | string[] | undefined> {
  const result = { ...headers }
  delete result.authorization
  delete result['proxy-authorization']
  delete result['proxy-connection']
  delete result.connection
  delete result['keep-alive']
  delete result.te
  delete result.trailer
  delete result['transfer-encoding']
  delete result.upgrade
  return result
}

export class FilteringProxy {
  private readonly policy: BrowserUrlPolicy
  private readonly maximumConnections: number
  private readonly maximumRequestBytes: number
  private readonly connectSocket: (options: NetConnectOpts) => Socket
  private readonly controller = new AbortController()
  private readonly streams = new Set<ActiveStream>()
  private readonly reservations = new Set<ActiveStream>()
  private server?: Server
  private proxyUrl?: string
  private disposed = false

  constructor(options: FilteringProxyOptions) {
    this.policy = options.policy
    this.maximumConnections = options.maximumConnections ?? 32
    this.maximumRequestBytes = options.maximumRequestBytes ?? 1024 * 1024
    this.connectSocket = options.connect ?? netConnect
  }

  async start(): Promise<string> {
    if (this.proxyUrl) {
      return this.proxyUrl
    }
    if (this.disposed) {
      throw new Error('浏览器过滤代理已关闭')
    }
    const server = createHttpServer((request, response) => {
      void this.handleHttp(request, response)
    })
    server.on('connect', (request, client, head) => {
      void this.handleConnect(request, client, head)
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError)
          resolve()
        })
      })
    } catch (error) {
      await this.dispose()
      throw new Error('浏览器过滤代理启动失败', { cause: error })
    }
    const address = server.address()
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      await this.dispose()
      throw new Error('浏览器过滤代理未安全绑定到回环地址')
    }
    this.proxyUrl = `http://127.0.0.1:${address.port}`
    return this.proxyUrl
  }

  private reserve(stream: ActiveStream): boolean {
    if (
      this.disposed ||
      this.controller.signal.aborted ||
      this.reservations.size >= this.maximumConnections
    ) {
      return false
    }
    this.streams.add(stream)
    this.reservations.add(stream)
    return true
  }

  private releaseStream(stream: ActiveStream): void {
    this.streams.delete(stream)
  }

  private releaseReservation(stream: ActiveStream): void {
    this.reservations.delete(stream)
  }

  private async validateAtConnect(url: URL): Promise<ValidatedBrowserUrl> {
    return this.policy.validate(url, this.controller.signal)
  }

  private async handleHttp(
    incoming: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!this.reserve(incoming)) {
      rejectHttp(response, 503)
      return
    }
    incoming.once('error', () => response.destroy())
    response.once('error', () => incoming.destroy())
    incoming.once('close', () => this.releaseStream(incoming))
    let responseClosed = false
    const releaseReservation = (): void =>
      this.releaseReservation(incoming)
    response.once('finish', releaseReservation)
    response.once('close', () => {
      responseClosed = true
      releaseReservation()
    })
    try {
      if (!incoming.url) {
        rejectHttp(response)
        return
      }
      const target = await this.validateAtConnect(new URL(incoming.url))
      const address = target.addresses[0]
      if (!address) {
        rejectHttp(response)
        return
      }
      if (
        incoming.destroyed ||
        response.destroyed ||
        response.writableEnded ||
        responseClosed
      ) {
        return
      }
      const request = (
        target.url.protocol === 'https:' ? httpsRequest : httpRequest
      )(
        target.url,
        {
          method: incoming.method,
          headers: {
            ...stripProxyHeaders(incoming.headers),
            host: target.url.host
          },
          lookup: (_hostname, options, callback) => {
            if (options.all) {
              callback(null, [
                { address: address.address, family: address.family }
              ])
            } else {
              callback(null, address.address, address.family)
            }
          },
          signal: this.controller.signal
        },
        (upstream) => {
          const destroyForward = (): void => {
            upstream.destroy()
            request.destroy()
            if (!response.destroyed) {
              response.destroy()
            }
          }
          upstream.once('error', destroyForward)
          response.once('error', destroyForward)
          response.once('close', () => {
            if (!upstream.complete) {
              upstream.destroy()
            }
          })
          response.writeHead(
            upstream.statusCode ?? 502,
            stripProxyHeaders(upstream.headers)
          )
          upstream.pipe(response)
        }
      )
      this.streams.add(request)
      request.once('close', () => this.releaseStream(request))
      request.once('error', () => {
        if (response.headersSent) {
          response.destroy()
        } else if (!response.destroyed) {
          rejectHttp(response, 502)
        }
      })
      incoming.once('aborted', () => request.destroy())
      incoming.once('error', () => request.destroy())
      let bytes = 0
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > this.maximumRequestBytes) {
          request.destroy(new Error('浏览器请求超过安全限制'))
          incoming.destroy()
        }
      })
      incoming.pipe(request)
    } catch {
      rejectHttp(response)
    }
  }

  private async handleConnect(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer
  ): Promise<void> {
    if (!this.reserve(client)) {
      client.destroy()
      return
    }
    let upstream: Socket | undefined
    const destroyUpstream = (): void => {
      if (upstream && !upstream.destroyed) {
        upstream.destroy()
      }
    }
    const destroyTunnel = (): void => {
      destroyUpstream()
      if (!client.destroyed) {
        client.destroy()
      }
    }
    // A browser can abandon a CONNECT tunnel while validation or a piped
    // write is in flight. Socket errors are connection-local; without an
    // error listener Node promotes them to an uncaught main-process error.
    client.once('error', destroyTunnel)
    client.once('close', () => {
      this.releaseStream(client)
      this.releaseReservation(client)
      destroyUpstream()
    })
    try {
      if (!request.url || request.url.length > 1_000) {
        client.destroy()
        return
      }
      const authority = new URL(`https://${request.url}`)
      if (
        authority.username ||
        authority.password ||
        authority.pathname !== '/' ||
        authority.search ||
        authority.hash
      ) {
        client.destroy()
        return
      }
      const target = await this.validateAtConnect(authority)
      const address = target.addresses[0]
      if (!address) {
        client.destroy()
        return
      }
      const port = authority.port ? Number(authority.port) : 443
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        client.destroy()
        return
      }
      if (client.destroyed) {
        return
      }
      const connectedUpstream = this.connectSocket({
        // Pin the TCP destination to the policy-approved address. The CONNECT
        // tunnel remains opaque, so Chromium still verifies TLS against the
        // original authority hostname rather than this address.
        host: address.address,
        port,
        family: address.family
      })
      upstream = connectedUpstream
      this.streams.add(connectedUpstream)
      const release = (): void => this.releaseStream(connectedUpstream)
      connectedUpstream.once('close', release)
      connectedUpstream.once('error', destroyTunnel)
      if (client.destroyed) {
        connectedUpstream.destroy()
        return
      }
      connectedUpstream.once('connect', () => {
        if (client.destroyed) {
          connectedUpstream.destroy()
          return
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) {
          connectedUpstream.write(head)
        }
        connectedUpstream.pipe(client)
        client.pipe(connectedUpstream)
      })
    } catch {
      destroyTunnel()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.controller.abort(new Error('浏览器过滤代理已关闭'))
    for (const stream of this.streams) {
      stream.destroy()
    }
    this.streams.clear()
    this.reservations.clear()
    const server = this.server
    this.server = undefined
    this.proxyUrl = undefined
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
