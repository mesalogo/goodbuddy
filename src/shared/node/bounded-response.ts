export type BoundedResponseOptions = {
  maxBytes: number
  missingBodyMessage?: string
  tooLargeMessage: string
  truncatedMessage?: string
}

export class BoundedResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoundedResponseTooLargeError'
  }
}

export class BoundedResponseTruncatedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoundedResponseTruncatedError'
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  options: BoundedResponseOptions
): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  let parsedLength: number | undefined
  if (declaredLength !== null) {
    parsedLength = Number(declaredLength)
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > options.maxBytes
    ) {
      await response.body?.cancel().catch(() => undefined)
      throw new BoundedResponseTooLargeError(
        options.tooLargeMessage
      )
    }
  }
  if (!response.body) {
    if (options.missingBodyMessage) {
      throw new Error(options.missingBodyMessage)
    }
    if (
      options.truncatedMessage !== undefined &&
      parsedLength !== undefined &&
      parsedLength !== 0
    ) {
      throw new BoundedResponseTruncatedError(
        options.truncatedMessage
      )
    }
    return new Uint8Array()
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
        throw new BoundedResponseTooLargeError(
          options.tooLargeMessage
        )
      }
      chunks.push(value)
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
  if (
    options.truncatedMessage !== undefined &&
    parsedLength !== undefined &&
    response.headers.get('content-encoding') === null &&
    total !== parsedLength
  ) {
    throw new BoundedResponseTruncatedError(
      options.truncatedMessage
    )
  }
  return Buffer.concat(chunks, total)
}

export async function readBoundedResponseText(
  response: Response,
  options: BoundedResponseOptions
): Promise<string> {
  return Buffer.from(
    await readBoundedResponseBytes(response, options)
  ).toString('utf8')
}
