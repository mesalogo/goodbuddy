import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { parseDocument, type ParsedDocument } from './document-parser'

type ResolvedAddress = {
  address: string
  family: number
}

type RawResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

export type UrlImportResult = {
  url: string
  title: string
  contentType: string
  etag?: string
  lastModified?: string
  document: ParsedDocument
  discoveredUrls: string[]
}

export type UrlImporterOptions = {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>
  transport?: (
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal,
    maximumBytes: number
  ) => Promise<RawResponse>
  maximumBytes?: number
  maximumRedirects?: number
}

const blockedHostnames = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal'
])

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true
  }
  const [first = 0, second = 0] = parts
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    first >= 224
  )
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? ''
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  ) {
    return true
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? isPrivateIpv4(mapped[1] ?? '') : false
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4
    ? !isPrivateIpv4(address)
    : family === 6
      ? !isPrivateIpv6(address)
      : false
}

export function normalizeSourceUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('请输入有效的网页 URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('网页来源仅支持 HTTP(S)')
  }
  if (
    url.username ||
    url.password ||
    blockedHostnames.has(url.hostname.toLowerCase()) ||
    url.hostname.toLowerCase().endsWith('.localhost')
  ) {
    throw new Error('该网页地址不允许导入')
  }
  url.hash = ''
  return url
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, {
    all: true,
    verbatim: true
  })
}

function defaultTransport(
  url: URL,
  resolved: ResolvedAddress,
  signal: AbortSignal,
  maximumBytes: number
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        headers: {
          accept:
            'text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9',
          'user-agent': 'GoodBuddy/0.1 Knowledge Importer'
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, resolved.address, resolved.family)
        },
        signal
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > maximumBytes) {
            request.destroy(new Error('网页响应超过安全限制'))
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks)
          })
        })
      }
    )
    request.setTimeout(15_000, () => {
      request.destroy(new Error('网页请求超时'))
    })
    request.on('error', reject)
    request.end()
  })
}

function headerValue(
  headers: RawResponse['headers'],
  name: string
): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function extractLinks(html: string, baseUrl: URL): string[] {
  const links = new Set<string>()
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi
  for (const match of html.matchAll(pattern)) {
    const href = match[1] ?? match[2] ?? match[3]
    if (!href) {
      continue
    }
    try {
      const candidate = new URL(href, baseUrl)
      candidate.hash = ''
      if (
        candidate.origin === baseUrl.origin &&
        ['http:', 'https:'].includes(candidate.protocol)
      ) {
        links.add(candidate.toString())
      }
    } catch {
      continue
    }
    if (links.size >= 100) {
      break
    }
  }
  return [...links]
}

export class UrlImporter {
  private readonly lookup: NonNullable<UrlImporterOptions['lookup']>
  private readonly transport: NonNullable<UrlImporterOptions['transport']>
  private readonly maximumBytes: number
  private readonly maximumRedirects: number

  constructor(options: UrlImporterOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup
    this.transport = options.transport ?? defaultTransport
    this.maximumBytes = options.maximumBytes ?? 5 * 1024 * 1024
    this.maximumRedirects = options.maximumRedirects ?? 5
  }

  private async resolvePublic(url: URL): Promise<ResolvedAddress> {
    const addresses = await this.lookup(url.hostname)
    const address = addresses.find((candidate) =>
      isPublicAddress(candidate.address)
    )
    if (
      addresses.length === 0 ||
      addresses.some((candidate) => !isPublicAddress(candidate.address)) ||
      !address
    ) {
      throw new Error('网页地址解析到本机、私网或不可用地址')
    }
    return address
  }

  async import(input: string, signal: AbortSignal): Promise<UrlImportResult> {
    let url = normalizeSourceUrl(input)
    let response: RawResponse | undefined

    for (let redirect = 0; redirect <= this.maximumRedirects; redirect += 1) {
      signal.throwIfAborted()
      const address = await this.resolvePublic(url)
      response = await this.transport(
        url,
        address,
        signal,
        this.maximumBytes
      )
      if (response.body.byteLength > this.maximumBytes) {
        throw new Error('网页响应超过 5MB 安全限制')
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break
      }
      const location = headerValue(response.headers, 'location')
      if (!location || redirect === this.maximumRedirects) {
        throw new Error('网页重定向无效或次数过多')
      }
      url = normalizeSourceUrl(new URL(location, url).toString())
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error(`网页请求失败（HTTP ${response?.status ?? 0}）`)
    }
    const contentType = (
      headerValue(response.headers, 'content-type') ?? ''
    )
      .split(';')[0]
      ?.trim()
      .toLowerCase()
    const supportedTypes = new Set([
      'application/json',
      'application/xhtml+xml',
      'application/xml',
      'text/html',
      'text/plain',
      'text/xml'
    ])
    if (!contentType || !supportedTypes.has(contentType)) {
      throw new Error(`不支持的网页响应类型：${contentType || '未知'}`)
    }

    const isHtml = ['text/html', 'application/xhtml+xml'].includes(
      contentType
    )
    const rawText = response.body.toString('utf8')
    const title = isHtml
      ? (
          rawText
            .match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
            ?.replace(/<[^>]+>/g, ' ')
            .replaceAll('&amp;', '&')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replace(/\s+/g, ' ')
            .trim() || url.hostname
        ).slice(0, 240)
      : url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname
    const document = await parseDocument(
      isHtml ? `${title}.html` : `${title}.txt`,
      response.body
    )
    return {
      url: url.toString(),
      title,
      contentType,
      etag: headerValue(response.headers, 'etag'),
      lastModified: headerValue(response.headers, 'last-modified'),
      document,
      discoveredUrls: isHtml ? extractLinks(rawText, url) : []
    }
  }
}
