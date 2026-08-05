import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { NetConnectOpts, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import {
  BrowserUrlPolicy,
  type BrowserResolvedAddress,
  type ValidatedBrowserUrl
} from './browser-url-policy'

const MAX_UPSTREAM_ADDRESSES = 8

export type FilteringProxyOptions = {
  policy: BrowserUrlPolicy
  maximumConnections?: number
  maximumRequestBytes?: number
  upstreamTimeoutMs?: number
  upstreamIdleTimeoutMs?: number
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

function canRetryHttpRequest(request: IncomingMessage): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false
  }
  const contentLength = Number(request.headers['content-length'] ?? 0)
  if (
    request.headers['transfer-encoding'] !== undefined ||
    !Number.isFinite(contentLength) ||
    contentLength > 0
  ) {
    return false
  }
  return ![
    'if-match',
    'if-unmodified-since',
    'if-none-match',
    'if-modified-since',
    'if-range'
  ].some((name) => request.headers[name] !== undefined)
}

function shouldRetryHttpStatus(statusCode: number | undefined): boolean {
  return statusCode === 412 || statusCode === 421 || statusCode === 425
}

function boundedApprovedAddresses(
  target: ValidatedBrowserUrl
): BrowserResolvedAddress[] {
  const seen = new Set<string>()
  return target.addresses
    .filter((address) => {
      const key = `${address.family}:${address.address}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    .slice(0, MAX_UPSTREAM_ADDRESSES)
}

export class FilteringProxy {
  private readonly policy: BrowserUrlPolicy
  private readonly maximumConnections: number
  private readonly maximumRequestBytes: number
  private readonly upstreamTimeoutMs: number
  private readonly upstreamIdleTimeoutMs: number
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
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? 3_000
    this.upstreamIdleTimeoutMs =
      options.upstreamIdleTimeoutMs ?? 15_000
    this.connectSocket = options.connect ?? netConnect
    if (
      !Number.isSafeInteger(this.upstreamTimeoutMs) ||
      this.upstreamTimeoutMs < 1 ||
      !Number.isSafeInteger(this.upstreamIdleTimeoutMs) ||
      this.upstreamIdleTimeoutMs < 1
    ) {
      throw new Error('浏览器过滤代理超时配置无效')
    }
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
      const addresses = boundedApprovedAddresses(target)
      if (addresses.length === 0) {
        rejectHttp(response)
        return
      }
      if (
        (incoming.destroyed && !incoming.complete) ||
        response.destroyed ||
        response.writableEnded ||
        responseClosed
      ) {
        return
      }
      const retryable = canRetryHttpRequest(incoming)
      let activeRequest: ActiveStream | undefined
      incoming.once('aborted', () => activeRequest?.destroy())
      incoming.once('error', () => activeRequest?.destroy())
      let bytes = 0
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > this.maximumRequestBytes) {
          activeRequest?.destroy(
            new Error('浏览器请求超过安全限制')
          )
          incoming.destroy()
        }
      })

      const attempt = (addressIndex: number): void => {
        const address = addresses[addressIndex]
        if (
          !address ||
          (incoming.destroyed && !incoming.complete) ||
          response.destroyed ||
          response.writableEnded ||
          responseClosed
        ) {
          if (!response.headersSent && !response.destroyed) {
            rejectHttp(response, 502)
          }
          return
        }
        let retryStarted = false
        let responseReceived = false
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
            responseReceived = true
            if (headerTimer) {
              clearTimeout(headerTimer)
            }
            const retry = (): boolean => {
              if (
                !retryStarted &&
                retryable &&
                addressIndex + 1 < addresses.length
              ) {
                retryStarted = true
                upstream.destroy()
                request.destroy()
                attempt(addressIndex + 1)
                return true
              }
              return false
            }
            if (
              shouldRetryHttpStatus(upstream.statusCode) &&
              retry()
            ) {
              return
            }
            const destroyForward = (): void => {
              upstream.destroy()
              request.destroy()
              if (!response.destroyed) {
                response.destroy()
              }
            }
            upstream.setTimeout(
              this.upstreamIdleTimeoutMs,
              destroyForward
            )
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
        activeRequest = request
        this.streams.add(request)
        request.once('close', () => this.releaseStream(request))
        request.once('error', () => {
          if (headerTimer) {
            clearTimeout(headerTimer)
          }
          if (retryStarted) {
            return
          }
          if (
            !responseReceived &&
            retryable &&
            addressIndex + 1 < addresses.length
          ) {
            retryStarted = true
            attempt(addressIndex + 1)
          } else if (response.headersSent) {
            response.destroy()
          } else if (!response.destroyed) {
            rejectHttp(response, 502)
          }
        })
        const headerTimer = setTimeout(() => {
          if (responseReceived || retryStarted) {
            return
          }
          retryStarted = true
          request.destroy(new Error('浏览器上游响应超时'))
          if (
            retryable &&
            addressIndex + 1 < addresses.length
          ) {
            attempt(addressIndex + 1)
          } else if (!response.headersSent && !response.destroyed) {
            rejectHttp(response, 504)
          }
        }, this.upstreamTimeoutMs)
        if (retryable) {
          request.end()
        } else {
          incoming.pipe(request)
        }
      }
      attempt(0)
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
      const addresses = boundedApprovedAddresses(target)
      if (addresses.length === 0) {
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
      const attempt = (addressIndex: number): void => {
        const address = addresses[addressIndex]
        if (!address || client.destroyed) {
          destroyTunnel()
          return
        }
        const connectedUpstream = this.connectSocket({
          // Pin the TCP destination to a policy-approved address. The CONNECT
          // tunnel remains opaque, so Chromium still verifies TLS against the
          // original authority hostname rather than this address.
          host: address.address,
          port,
          family: address.family
        })
        upstream = connectedUpstream
        this.streams.add(connectedUpstream)
        let settled = false
        const timer = setTimeout(() => {
          if (settled) {
            return
          }
          settled = true
          connectedUpstream.destroy()
          if (addressIndex + 1 < addresses.length) {
            attempt(addressIndex + 1)
          } else {
            destroyTunnel()
          }
        }, this.upstreamTimeoutMs)
        const release = (): void =>
          this.releaseStream(connectedUpstream)
        connectedUpstream.once('close', release)
        connectedUpstream.once('error', () => {
          if (settled) {
            if (connectedUpstream === upstream) {
              destroyTunnel()
            }
            return
          }
          settled = true
          clearTimeout(timer)
          connectedUpstream.destroy()
          if (addressIndex + 1 < addresses.length) {
            attempt(addressIndex + 1)
          } else {
            destroyTunnel()
          }
        })
        if (client.destroyed) {
          settled = true
          clearTimeout(timer)
          connectedUpstream.destroy()
          return
        }
        connectedUpstream.once('connect', () => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          if (client.destroyed) {
            connectedUpstream.destroy()
            return
          }
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length > 0) {
            connectedUpstream.write(head)
          }
          const upstreamWithTimeout = connectedUpstream as Socket & {
            setTimeout?(
              milliseconds: number,
              callback: () => void
            ): unknown
          }
          upstreamWithTimeout.setTimeout?.(
            this.upstreamIdleTimeoutMs,
            destroyTunnel
          )
          const clientWithTimeout = client as Duplex & {
            setTimeout?(
              milliseconds: number,
              callback: () => void
            ): unknown
          }
          clientWithTimeout.setTimeout?.(
            this.upstreamIdleTimeoutMs,
            destroyTunnel
          )
          connectedUpstream.pipe(client)
          client.pipe(connectedUpstream)
        })
      }
      attempt(0)
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
