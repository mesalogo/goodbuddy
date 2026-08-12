export type BoundedResponseTextOptions = {
  maxBytes: number
  missingBodyMessage?: string
  tooLargeMessage: string
}

export async function readBoundedResponseText(
  response: Response,
  options: BoundedResponseTextOptions
): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > options.maxBytes
    ) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(options.tooLargeMessage)
    }
  }
  if (!response.body) {
    if (options.missingBodyMessage) {
      throw new Error(options.missingBodyMessage)
    }
    return ''
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let completed = false
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      total += value.byteLength
      if (total > options.maxBytes) {
        throw new Error(options.tooLargeMessage)
      }
      chunks.push(value)
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}
