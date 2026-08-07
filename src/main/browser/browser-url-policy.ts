import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type BrowserResolvedAddress = {
  address: string
  family: 4 | 6
}

export type BrowserDnsResolver = (
  hostname: string,
  signal: AbortSignal
) => Promise<readonly BrowserResolvedAddress[]>

export type ValidatedBrowserUrl = {
  url: URL
  origin: string
  addresses: readonly BrowserResolvedAddress[]
}

export function canonicalizeBrowserUrl(input: string): URL {
  if (input !== input.trim() || input.length === 0 || input.length > 8_192) {
    throw new Error('浏览器 URL 无效')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('浏览器 URL 无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('浏览器仅支持 HTTP(S) URL')
  }
  if (!url.hostname || url.origin === 'null') {
    throw new Error('浏览器 URL 缺少有效主机名')
  }
  url.hash = ''
  return url
}

async function defaultResolver(
  hostname: string,
  signal: AbortSignal
): Promise<readonly BrowserResolvedAddress[]> {
  signal.throwIfAborted()
  const result = await dnsLookup(hostname, {
    all: true,
    verbatim: true
  })
  signal.throwIfAborted()
  return result
    .filter(
      (entry): entry is { address: string; family: 4 | 6 } =>
        entry.family === 4 || entry.family === 6
    )
    .map((entry) => ({ address: entry.address, family: entry.family }))
}

export class BrowserUrlPolicy {
  constructor(
    private readonly resolveDns: BrowserDnsResolver = defaultResolver,
    private readonly resolutionTimeoutMs = 10_000
  ) {
    if (
      !Number.isSafeInteger(resolutionTimeoutMs) ||
      resolutionTimeoutMs < 1
    ) {
      throw new Error('浏览器 DNS 解析期限无效')
    }
  }

  private async resolve(
    hostname: string,
    signal: AbortSignal
  ): Promise<readonly BrowserResolvedAddress[]> {
    const timeout = AbortSignal.timeout(this.resolutionTimeoutMs)
    const effectiveSignal = AbortSignal.any([signal, timeout])
    const resolution = this.resolveDns(hostname, effectiveSignal)
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        reject(
          signal.aborted
            ? signal.reason
            : new Error(`浏览器 DNS 解析超时（${this.resolutionTimeoutMs}ms）`)
        )
      }
      effectiveSignal.addEventListener('abort', abort, { once: true })
      void resolution.then(
        (addresses) => {
          effectiveSignal.removeEventListener('abort', abort)
          if (effectiveSignal.aborted) {
            abort()
          } else {
            resolve(addresses)
          }
        },
        (error: unknown) => {
          effectiveSignal.removeEventListener('abort', abort)
          reject(error)
        }
      )
    })
  }

  /**
   * Resolves the target up front so the filtering proxy connects to the exact
   * addresses seen here instead of re-resolving, which keeps a host from
   * pointing at a different machine between approval and connection.
   */
  async validate(
    input: string | URL,
    signal: AbortSignal
  ): Promise<ValidatedBrowserUrl> {
    signal.throwIfAborted()
    const url = canonicalizeBrowserUrl(
      typeof input === 'string' ? input : input.toString()
    )
    const literalHostname =
      url.hostname.startsWith('[') && url.hostname.endsWith(']')
        ? url.hostname.slice(1, -1)
        : url.hostname
    const literalFamily = isIP(literalHostname)
    const addresses =
      literalFamily === 4 || literalFamily === 6
        ? [{
            address: literalHostname,
            family: literalFamily
          } as const]
        : await this.resolve(url.hostname, signal)
    signal.throwIfAborted()
    if (addresses.length === 0) {
      throw new Error('浏览器目标无法解析到任何地址')
    }
    return {
      url,
      origin: url.origin,
      addresses: [...addresses]
    }
  }

  async validateRedirect(
    input: string,
    signal: AbortSignal
  ): Promise<ValidatedBrowserUrl> {
    return this.validate(input, signal)
  }
}
