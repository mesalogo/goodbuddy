import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isIntranetCompatibilityEnabled } from '../intranet-compatibility-policy'

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

const LOCAL_HOST_SUFFIXES = [
  '.home',
  '.internal',
  '.lan',
  '.local',
  '.localdomain',
  '.localhost'
]

const BLOCKED_HOSTS = new Set([
  'instance-data',
  'instance-data.ec2.internal',
  'metadata',
  'metadata.aws.internal',
  'metadata.google.internal'
])

const ALWAYS_BLOCKED_HOST_SUFFIXES = ['.invalid', '.test']

function ipv4Number(address: string): number | undefined {
  if (isIP(address) !== 4) {
    return undefined
  }
  const octets = address.split('.').map(Number)
  if (octets.length !== 4) {
    return undefined
  }
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  )
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (base & mask)
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address)
  if (value === undefined) {
    return false
  }
  const blocked: Array<[number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4]
  ]
  return !blocked.some(([base, prefix]) =>
    inIpv4Range(value, base, prefix)
  )
}

function expandIpv6(address: string): readonly number[] | undefined {
  const withoutZone = address.toLowerCase().split('%', 1)[0] ?? ''
  if (isIP(withoutZone) !== 6) {
    return undefined
  }
  let normalized = withoutZone
  const ipv4Match = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/u)
  if (ipv4Match) {
    const ipv4 = ipv4Number(ipv4Match[1] ?? '')
    if (ipv4 === undefined) {
      return undefined
    }
    normalized = normalized.replace(
      ipv4Match[1] ?? '',
      `${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
    )
  }
  const halves = normalized.split('::')
  if (halves.length > 2) {
    return undefined
  }
  const left = (halves[0] ?? '').split(':').filter(Boolean)
  const right = (halves[1] ?? '').split(':').filter(Boolean)
  const missing = 8 - left.length - right.length
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return undefined
  }
  const groups = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => '0'),
    ...right
  ].map((group) => Number.parseInt(group, 16))
  return groups.length === 8 &&
    groups.every((group) => Number.isInteger(group) && group <= 0xffff)
    ? groups
    : undefined
}

function ipv6Prefix(
  groups: readonly number[],
  expected: readonly number[],
  prefixBits: number
): boolean {
  let remaining = prefixBits
  for (let index = 0; remaining > 0; index += 1) {
    const bits = Math.min(16, remaining)
    const mask = (0xffff << (16 - bits)) & 0xffff
    if (((groups[index] ?? 0) & mask) !== ((expected[index] ?? 0) & mask)) {
      return false
    }
    remaining -= bits
  }
  return true
}

function isPublicIpv6(address: string): boolean {
  const groups = expandIpv6(address)
  if (!groups) {
    return false
  }
  if (groups.slice(0, 5).every((group) => group === 0)) {
    const sixth = groups[5] ?? 0
    if (sixth === 0xffff) {
      const mapped = `${(groups[6] ?? 0) >>> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >>> 8}.${(groups[7] ?? 0) & 0xff}`
      return isPublicIpv4(mapped)
    }
    if (sixth === 0) {
      return false
    }
  }
  const blocked: Array<[readonly number[], number]> = [
    [[0, 0, 0, 0, 0, 0, 0, 0], 128],
    [[0, 0, 0, 0, 0, 0, 0, 1], 128],
    [[0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96],
    [[0x64, 0xff9b, 1, 0, 0, 0, 0, 0], 48],
    [[0x100, 0, 0, 0, 0, 0, 0, 0], 64],
    [[0x2001, 0, 0, 0, 0, 0, 0, 0], 32],
    [[0x2001, 2, 0, 0, 0, 0, 0, 0], 48],
    [[0x2001, 0x10, 0, 0, 0, 0, 0, 0], 28],
    [[0x2001, 0x20, 0, 0, 0, 0, 0, 0], 28],
    [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32],
    [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16],
    [[0x3fff, 0, 0, 0, 0, 0, 0, 0], 20],
    [[0x5f00, 0, 0, 0, 0, 0, 0, 0], 16],
    [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7],
    [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10],
    [[0xfec0, 0, 0, 0, 0, 0, 0, 0], 10],
    [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8]
  ]
  return !blocked.some(([prefix, bits]) =>
    ipv6Prefix(groups, prefix, bits)
  )
}

export function isPublicBrowserAddress(address: string): boolean {
  const family = isIP(address.split('%', 1)[0] ?? '')
  return family === 4
    ? isPublicIpv4(address)
    : family === 6
      ? isPublicIpv6(address)
      : false
}

function isIntranetBrowserIpv4(address: string): boolean {
  const value = ipv4Number(address)
  if (value === undefined || address === '100.100.100.200') {
    return false
  }
  return [
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xac100000, 12],
    [0xc0a80000, 16]
  ].some(([base, prefix]) =>
    inIpv4Range(value, base ?? 0, prefix ?? 0)
  )
}

function isIntranetBrowserIpv6(address: string): boolean {
  const groups = expandIpv6(address)
  if (!groups) {
    return false
  }
  if (groups.slice(0, 5).every((group) => group === 0)) {
    const sixth = groups[5] ?? 0
    if (sixth === 0xffff) {
      const mapped = `${(groups[6] ?? 0) >>> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >>> 8}.${(groups[7] ?? 0) & 0xff}`
      return isIntranetBrowserIpv4(mapped)
    }
    if (
      sixth === 0 &&
      groups[6] === 0 &&
      groups[7] === 1
    ) {
      return true
    }
  }
  const awsMetadata = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254]
  return (
    ipv6Prefix(groups, [0xfc00, 0, 0, 0, 0, 0, 0, 0], 7) &&
    !ipv6Prefix(groups, awsMetadata, 128)
  )
}

export function isIntranetBrowserAddress(address: string): boolean {
  const normalized = address.split('%', 1)[0] ?? ''
  const family = isIP(normalized)
  return family === 4
    ? isIntranetBrowserIpv4(normalized)
    : family === 6
      ? isIntranetBrowserIpv6(normalized)
      : false
}

function browserAddressClass(
  address: string
): 'public' | 'intranet' | 'blocked' {
  if (isPublicBrowserAddress(address)) {
    return 'public'
  }
  return isIntranetBrowserAddress(address) ? 'intranet' : 'blocked'
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
  if (url.username || url.password || !url.hostname || url.origin === 'null') {
    throw new Error('浏览器 URL 不允许包含凭据或无效来源')
  }
  const rawHostname = url.hostname.toLowerCase()
  const hostname = (
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname
  ).replace(/\.$/u, '')
  if (
    hostname !== (
      rawHostname.startsWith('[') && rawHostname.endsWith(']')
        ? rawHostname.slice(1, -1)
        : rawHostname
    ) ||
    BLOCKED_HOSTS.has(hostname) ||
    ALWAYS_BLOCKED_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
    ) ||
    (
      !isIntranetCompatibilityEnabled() &&
      (
        (!hostname.includes('.') && isIP(hostname) === 0) ||
        LOCAL_HOST_SUFFIXES.some(
          (suffix) =>
            hostname === suffix.slice(1) || hostname.endsWith(suffix)
        )
      )
    )
  ) {
    throw new Error('浏览器 URL 不允许访问本机或内部名称')
  }
  if (
    isIP(hostname) !== 0 &&
    (
      browserAddressClass(hostname) === 'blocked' ||
      (
        !isIntranetCompatibilityEnabled() &&
        !isPublicBrowserAddress(hostname)
      )
    )
  ) {
    throw new Error('浏览器 URL 不允许访问私有或保留地址')
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
    const addressClasses = addresses.map((entry) =>
      entry.family === isIP(entry.address)
        ? browserAddressClass(entry.address)
        : 'blocked'
    )
    if (
      addresses.length === 0 ||
      addressClasses.includes('blocked') ||
      new Set(addressClasses).size !== 1 ||
      (
        !isIntranetCompatibilityEnabled() &&
        addressClasses.some((addressClass) => addressClass !== 'public')
      )
    ) {
      throw new Error('浏览器目标解析到私有、保留或混合地址')
    }
    return {
      url,
      origin: url.origin,
      addresses: [...addresses]
    }
  }

  async validateRedirect(
    input: string,
    approvedOrigin: string,
    signal: AbortSignal
  ): Promise<ValidatedBrowserUrl> {
    const target = await this.validate(input, signal)
    if (target.origin !== approvedOrigin) {
      throw new Error('浏览器重定向超出已批准来源')
    }
    return target
  }
}
