export const CONVERSATION_NOT_FOUND_CODE = 'conversation-not-found'
export const MAGIC_NOTE_NOT_FOUND_CODE = 'magic-note-not-found'
type NotFoundCode = typeof CONVERSATION_NOT_FOUND_CODE | typeof MAGIC_NOTE_NOT_FOUND_CODE

type IpcNotFound = { ok: false; code: NotFoundCode }

export function isNotFoundError(error: unknown, code: NotFoundCode): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export async function withIpcNotFound<T>(code: NotFoundCode, read: () => T | Promise<T>): Promise<T | IpcNotFound> {
  try {
    return await read()
  } catch (error) {
    if (!isNotFoundError(error, code)) throw error
    return { ok: false, code }
  }
}

function isIpcNotFound(value: object): value is IpcNotFound {
  return 'ok' in value && value.ok === false &&
    (isNotFoundError(value, CONVERSATION_NOT_FOUND_CODE) || isNotFoundError(value, MAGIC_NOTE_NOT_FOUND_CODE))
}

export function unwrapIpcNotFound<T extends object>(result: T | IpcNotFound): T {
  // Custom Error properties do not survive Electron IPC or contextBridge.
  if (isIpcNotFound(result)) throw result
  return result
}
