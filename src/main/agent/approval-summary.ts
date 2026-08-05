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
      /\bAuthorization\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/giu,
      'Authorization$1[REDACTED]'
    )
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(
      /(["']?)(api[-_ ]?key|token|secret|password|authorization)\1(\s*[:=]\s*)"[^"\r\n]*"/giu,
      '$1$2$1$3"[REDACTED]"'
    )
    .replace(
      /(["']?)(api[-_ ]?key|token|secret|password|authorization)\1(\s*[:=]\s*)'[^'\r\n]*'/giu,
      "$1$2$1$3'[REDACTED]'"
    )
    .replace(
      /\b(api[-_ ]?key|token|secret|password|authorization)\b(\s*[:=]\s*|\s+)(["']?)[^\s"',}]+/giu,
      '$1$2[REDACTED]'
    )
}

export function safeToolErrorDetail(
  value: unknown,
  maximum = 2_000
): string | undefined {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    return undefined
  }
  const parts: string[] = []
  let remaining = maximum
  const seen = new WeakSet<object>()

  const collect = (candidate: unknown, depth = 0): void => {
    if (remaining <= 0 || depth > 4 || candidate === undefined) {
      return
    }
    if (typeof candidate === 'string') {
      const boundedCandidate = candidate.slice(
        0,
        Math.min(candidate.length, remaining * 4)
      )
      const text = redactSensitiveText(
        [...boundedCandidate]
          .filter((character) => {
            const code = character.charCodeAt(0)
            return (
              code === 9 ||
              code === 10 ||
              code === 13 ||
              (code > 31 && code !== 127)
            )
          })
          .join('')
      ).trim()
      if (!text) {
        return
      }
      const separator = parts.length > 0 ? '\n' : ''
      const available = Math.max(0, remaining - separator.length)
      if (available === 0) {
        return
      }
      const bounded = text.slice(0, available)
      parts.push(`${separator}${bounded}`)
      remaining -= separator.length + bounded.length
      return
    }
    if (!candidate || typeof candidate !== 'object') {
      return
    }
    if (seen.has(candidate)) {
      return
    }
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      for (const item of candidate.slice(0, 20)) {
        collect(item, depth + 1)
      }
      return
    }
    const record = candidate as Record<string, unknown>
    for (const key of [
      'content',
      'message',
      'error',
      'stderr',
      'detail',
      'data'
    ]) {
      collect(record[key], depth + 1)
    }
  }

  collect(value)
  return parts.join('').trim() || undefined
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
