// Kept self-contained so the Continue host can use it before truncating input.
export function toolOperationSummary(
  input: unknown,
  title?: unknown
): string | undefined {
  const singleLine = (value: unknown): string =>
    typeof value === 'string'
      ? [...value].map((character) => {
          const code = character.charCodeAt(0)
          return code <= 31 || code === 127 ? ' ' : character
        }).join('').replace(/\s+/gu, ' ').trim()
      : ''
  const nativeTitle = singleLine(title)
  if (nativeTitle) return nativeTitle.slice(0, 240)
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      return undefined
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const args = input as Record<string, unknown>
  const first = (keys: string[]): string =>
    keys.map((key) => singleLine(args[key])).find(Boolean) ?? ''
  const command = first(['command'])
  const path = first(['path', 'filePath', 'file_path', 'filepath', 'dirpath'])
  const search = first(['query', 'pattern', 'glob'])
  const filter = first(['filePattern', 'include'])
  const summary = command || (search
    ? [search, path, filter].filter(Boolean).join(' | ')
    : path || first(['url']))
  return summary ? summary.slice(0, 240) : undefined
}
