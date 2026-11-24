// Stable machine-readable codes for cross-process "not found" errors. The
// renderer matches on these instead of the localized message text, so a
// wording change in one process cannot silently change behavior in the
// other.
export const CONVERSATION_NOT_FOUND_CODE = 'conversation-not-found'
export const MAGIC_NOTE_NOT_FOUND_CODE = 'magic-note-not-found'

export function isNotFoundError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === code
}
