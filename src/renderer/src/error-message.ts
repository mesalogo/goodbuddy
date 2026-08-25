export function displayErrorMessage(
  reason: unknown,
  fallback: string
): string {
  const rawMessage =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'object' &&
          reason !== null &&
          'message' in reason &&
          typeof reason.message === 'string'
        ? reason.message
        : undefined
  if (!rawMessage) {
    return fallback
  }
  const message = rawMessage
    .replace(
      /^Error invoking remote method '[^']+':\s*(?:(?:[A-Za-z][A-Za-z0-9]*)?Error:\s*)?/u,
      ''
    )
    .trim()
  return message || fallback
}
