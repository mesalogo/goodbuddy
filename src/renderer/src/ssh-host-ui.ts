export function sshHostErrorMessage(
  reason: unknown,
  fallback: string
): string {
  return reason instanceof Error && reason.message.trim()
    ? reason.message
    : fallback
}
