export function directoryStorageKey(projectId: string, conversationId: string): string {
  return `composer.directories:${projectId}:${conversationId}`
}

export function readDirectories(key: string): string[] {
  const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]')
  return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : []
}

export function mergeDirectories(existing: string[], added: string[]): string[] {
  const paths = new Map<string, string>()
  for (const path of [...existing, ...added]) {
    const key = /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.replaceAll('/', '\\').toLowerCase() : path
    if (!paths.has(key)) paths.set(key, path)
  }
  return [...paths.values()]
}
