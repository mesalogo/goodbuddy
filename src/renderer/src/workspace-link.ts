export function resolveWorkspaceLink(href: string, rootPath?: string): string | undefined {
  let decoded: string
  try { decoded = decodeURIComponent(href).replaceAll('\\', '/') } catch { return undefined }
  if (!decoded || decoded.startsWith('#') || decoded.startsWith('//')) return undefined
  decoded = decoded.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L\d+)?)$/u, '')
  if (/^[a-z][a-z\d+.-]*:/iu.test(decoded) && !/^[A-Za-z]:\//u.test(decoded)) return undefined
  const normalize = (value: string): string | undefined => {
    const segments = value.split('/').filter(segment => segment && segment !== '.')
    return segments.includes('..') ? undefined : segments.join('/')
  }
  const rootSource = rootPath?.replaceAll('\\', '/')
  const root = rootSource ? normalize(rootSource) : undefined
  const windows = /^[A-Za-z]:\//u.test(rootSource ?? '')
  const absolute = decoded.startsWith('/') || /^[A-Za-z]:\//u.test(decoded)
  if (!absolute) return normalize(decoded)
  const normalized = normalize(decoded)
  if (!root || !normalized) return undefined
  const prefix = `${root}/`
  if (!(windows ? normalized.toLowerCase().startsWith(prefix.toLowerCase()) : normalized.startsWith(prefix))) return undefined
  return normalized.slice(prefix.length) || undefined
}
