const sensitiveKey = /token|secret|password|api.?key|authorization/iu

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0
): unknown {
  if (depth > 8) {
    return '[TRUNCATED]'
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[CIRCULAR]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => redactValue(item, seen, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        sensitiveKey.test(key)
          ? '[REDACTED]'
          : redactValue(item, seen, depth + 1)
      ])
  )
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\bAuthorization\b(\s*[:=]\s*)Bearer\s+\S+/giu,
      'Authorization$1[REDACTED]'
    )
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(api[-_ ]?key|token|secret|password|authorization)\b(\s*[:=]\s*|\s+)(["']?)[^\s"',}]+/giu,
      '$1$2[REDACTED]'
    )
}

export function safeToolArgumentSummary(
  toolArguments: Record<string, unknown>,
  preview?: unknown[],
  maximum = 1_000
): string {
  const previewText = preview
    ?.slice(0, 100)
    .flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return []
      }
      const content = (item as Record<string, unknown>).content
      return typeof content === 'string' ? [content] : []
    })
    .join(' ')
    .trim()
  if (previewText) {
    return redactSensitiveText(previewText).slice(0, maximum)
  }
  return JSON.stringify(
    redactValue(toolArguments, new WeakSet())
  ).slice(0, maximum)
}
