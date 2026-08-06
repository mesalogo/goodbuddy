const INTRANET_HOST_SUFFIXES = [
  '.home',
  '.internal',
  '.intranet',
  '.lan',
  '.local',
  '.localdomain',
  '.localhost'
] as const

const BLOCKED_HOSTNAMES = new Set([
  '100.100.100.200',
  'fd00:ec2::254',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata',
  'metadata.aws.internal',
  'metadata.google.internal'
])

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '')
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized
}

function parseIpv4(hostname: string): readonly number[] | undefined {
  const octets = hostname.split('.')
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) =>
        !/^(?:0|[1-9]\d{0,2})$/u.test(octet) ||
        Number(octet) > 255
    )
  ) {
    return undefined
  }
  return octets.map(Number)
}

function isIntranetIpv4(hostname: string): boolean {
  const octets = parseIpv4(hostname)
  if (!octets) {
    return false
  }
  const [first = -1, second = -1] = octets
  return (
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

function isIntranetIpv6(hostname: string): boolean {
  const withoutZone = hostname.split('%', 1)[0] ?? ''
  return (
    withoutZone === '::1' ||
    /^f[cd][0-9a-f]{2}(?::|$)/u.test(withoutZone)
  )
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  const ipv4 = parseIpv4(normalized)
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    ipv4?.[0] === 127
  )
}

export function isIntranetHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (!normalized || BLOCKED_HOSTNAMES.has(normalized)) {
    return false
  }
  if (parseIpv4(normalized)) {
    return isIntranetIpv4(normalized)
  }
  if (normalized.includes(':')) {
    return isIntranetIpv6(normalized)
  }
  return (
    isLoopbackHostname(normalized) ||
    !normalized.includes('.') ||
    INTRANET_HOST_SUFFIXES.some(
      (suffix) =>
        normalized === suffix.slice(1) || normalized.endsWith(suffix)
    )
  )
}
