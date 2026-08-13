import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'

const remoteTaskSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(100_000),
    workMode: z.literal('ask')
  })
  .strict()

export type RemoteDelegationTask = z.infer<typeof remoteTaskSchema>

type RemoteResult = {
  status: 'completed' | 'failed'
  output?: string
  error?: string
}

type ResolvedAddress = {
  address: string
  family: number
}

type RemoteTransport = (
  url: URL,
  address: ResolvedAddress,
  token: string,
  method: 'GET' | 'POST',
  signal: AbortSignal,
  body?: string
) => Promise<{ status: number; body: string }>

type RemoteDelegationOptions = {
  endpoint: string
  token: string
  onTask: (task: RemoteDelegationTask) => Promise<RemoteResult>
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>
  transport?: RemoteTransport
  intervalMs?: number
  outbox?: {
    listPending: () => Array<{ taskId: string; result: RemoteResult }>
    getStatus: (
      taskId: string
    ) => 'pending' | 'delivered' | undefined
    save: (taskId: string, result: RemoteResult) => void
    markDelivered: (taskId: string) => void
  }
}

function normalizeEndpoint(input: string): URL {
  const url = new URL(input.trim())
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('远程委派地址必须使用 HTTP 或 HTTPS')
  }
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/u, '')
  return url
}

/** Keeps any reverse-proxy path prefix carried by the configured endpoint. */
function endpointUrl(endpoint: URL, path: string): URL {
  const target = new URL(endpoint.toString())
  const prefix =
    endpoint.pathname === '/'
      ? ''
      : endpoint.pathname.replace(/\/+$/u, '')
  target.pathname = `${prefix}${path}`
  return target
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

function defaultTransport(
  url: URL,
  address: ResolvedAddress,
  token: string,
  method: 'GET' | 'POST',
  signal: AbortSignal,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(body
            ? { 'content-length': String(Buffer.byteLength(body)) }
            : {})
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family)
        },
        ...(url.protocol === 'https:'
          ? { servername: url.hostname }
          : {}),
        signal
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > 1024 * 1024) {
            request.destroy(new Error('远程委派响应超过 1MB 限制'))
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        response.on('end', () => {
          if (settled) {
            return
          }
          settled = true
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
        response.on('aborted', () => {
          fail(new Error('远程委派响应意外中断'))
        })
        response.on('error', fail)
      }
    )
    request.setTimeout(15_000, () => {
      request.destroy(new Error('远程委派请求超时'))
    })
    request.on('error', fail)
    request.end(body)
  })
}

export class RemoteDelegationService {
  private readonly endpoint: URL
  private readonly lookup: NonNullable<RemoteDelegationOptions['lookup']>
  private readonly transport: RemoteTransport
  private readonly deliveredIds = new Set<string>()
  private readonly pendingResults = new Map<string, RemoteResult>()
  private interval?: NodeJS.Timeout
  private activeRequest?: AbortController
  private activePoll?: Promise<void>

  constructor(private readonly options: RemoteDelegationOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint)
    if (!options.token.trim() || options.token.length > 8_192) {
      throw new Error('远程委派 Token 无效')
    }
    this.lookup = options.lookup ?? defaultLookup
    this.transport = options.transport ?? defaultTransport
  }

  start(): void {
    if (this.interval) {
      return
    }
    this.interval = setInterval(
      () => void this.pollOnce().catch(() => undefined),
      this.options.intervalMs ?? 60_000
    )
    void this.pollOnce().catch(() => undefined)
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
    this.activeRequest?.abort()
    await this.activePoll?.catch(() => undefined)
  }

  pollOnce(): Promise<void> {
    if (this.activePoll) {
      return this.activePoll
    }
    const operation = this.performPoll()
    this.activePoll = operation
    return operation.finally(() => {
      if (this.activePoll === operation) {
        this.activePoll = undefined
      }
    })
  }

  private async performPoll(): Promise<void> {
    const controller = new AbortController()
    this.activeRequest = controller
    try {
      const address = await this.resolveAddress()
      const durablePending = this.options.outbox?.listPending()[0]
      const memoryPending = this.pendingResults.entries().next().value
      const pending = durablePending
        ? ([durablePending.taskId, durablePending.result] as const)
        : memoryPending
      if (pending) {
        await this.deliverResult(
          pending[0],
          pending[1],
          address,
          controller.signal
        )
        this.markDelivered(pending[0])
      }
      const nextUrl = endpointUrl(this.endpoint, '/goodbuddy/tasks/next')
      const response = await this.transport(
        nextUrl,
        address,
        this.options.token,
        'GET',
        controller.signal
      )
      if (response.status === 204) {
        return
      }
      if (response.status !== 200) {
        throw new Error(`远程委派服务返回 HTTP ${response.status}`)
      }
      const task = remoteTaskSchema.parse(JSON.parse(response.body))
      if (
        this.deliveredIds.has(task.id) ||
        this.options.outbox?.getStatus(task.id) === 'delivered'
      ) {
        return
      }
      const existingResult =
        this.options.outbox
          ?.listPending()
          .find((item) => item.taskId === task.id)?.result ??
        this.pendingResults.get(task.id)
      let result: RemoteResult
      if (existingResult) {
        result = existingResult
      } else {
        try {
          result = await this.options.onTask(task)
        } catch (error) {
          result = {
            status: 'failed',
            error: error instanceof Error ? error.message : '远程任务执行失败'
          }
        }
        if (this.options.outbox) {
          this.options.outbox.save(task.id, result)
        } else {
          this.pendingResults.set(task.id, result)
        }
      }
      await this.deliverResult(task.id, result, address, controller.signal)
      this.markDelivered(task.id)
    } finally {
      if (this.activeRequest === controller) {
        this.activeRequest = undefined
      }
    }
  }

  private async deliverResult(
    taskId: string,
    result: RemoteResult,
    address: ResolvedAddress,
    signal: AbortSignal
  ): Promise<void> {
    const resultUrl = endpointUrl(
      this.endpoint,
      `/goodbuddy/tasks/${encodeURIComponent(taskId)}/result`
    )
    const response = await this.transport(
      resultUrl,
      address,
      this.options.token,
      'POST',
      signal,
      JSON.stringify({
        status: result.status,
        output: result.output?.slice(0, 1_000_000),
        error: result.error?.slice(0, 2_000)
      })
    )
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`远程委派结果提交失败（HTTP ${response.status}）`)
    }
  }

  private markDelivered(taskId: string): void {
    this.pendingResults.delete(taskId)
    this.options.outbox?.markDelivered(taskId)
    this.deliveredIds.add(taskId)
    if (this.deliveredIds.size > 1_000) {
      const oldest = this.deliveredIds.values().next().value
      if (oldest) {
        this.deliveredIds.delete(oldest)
      }
    }
  }

  private async resolveAddress(): Promise<ResolvedAddress> {
    const address = (await this.lookup(this.endpoint.hostname))[0]
    if (!address) {
      throw new Error('远程委派地址无法解析到任何 IP')
    }
    return address
  }
}
