import type { WorkspaceAccess } from '../workspace'

const READ_CHUNK_BYTES = 128 * 1024
const MAXIMUM_RESULT_BYTES = 240 * 1024
const MAXIMUM_LINE_CHARACTERS = 8_000

export async function readWorkspaceLines(
  workspace: WorkspaceAccess,
  input: { path: string; offset: number; limit: number; offsetBytes?: number },
  signal: AbortSignal
): Promise<string> {
  if (input.offsetBytes !== undefined) {
    const page = await workspace.readText({
      path: input.path,
      offsetBytes: input.offsetBytes,
      maximumBytes: MAXIMUM_RESULT_BYTES,
      allowTruncated: true,
      invalidUtf8Message: '工作区读取目标不是有效 UTF-8 文本',
      signal
    })
    const nextOffset = page.offsetBytes + page.bytesRead
    const footer = page.truncated
      ? `[bytes ${page.offsetBytes}-${nextOffset}; continue with offsetBytes=${nextOffset}]`
      : `[bytes ${page.offsetBytes}-${nextOffset}; end of file; ${page.size} bytes]`
    return `${page.content}\n${footer}`
  }
  let offsetBytes = 0
  let currentLine = 1
  let pending = ''
  let pendingTruncated = false
  let totalBytes: number | undefined
  let moreAvailable = false
  let resultBytes = 0
  const output: string[] = []

  while (true) {
    signal.throwIfAborted()
    const page = await workspace.readText({
      path: input.path,
      offsetBytes,
      maximumBytes: READ_CHUNK_BYTES,
      allowTruncated: true,
      invalidUtf8Message: '工作区读取目标不是有效 UTF-8 文本',
      signal
    })
    totalBytes = page.size
    offsetBytes += page.bytesRead
    const carriedLineTruncated: boolean = pendingTruncated
    const combined = pending + page.content
    const lines = combined.split('\n')
    pending = page.truncated ? lines.pop() ?? '' : ''
    pendingTruncated =
      page.truncated &&
      (carriedLineTruncated || pending.length > MAXIMUM_LINE_CHARACTERS)
    if (pending.length > MAXIMUM_LINE_CHARACTERS) {
      pending = pending.slice(0, MAXIMUM_LINE_CHARACTERS)
    }
    if (!page.truncated && lines.at(-1) === '') lines.pop()

    for (const [lineIndex, rawLine] of lines.entries()) {
      if (currentLine >= input.offset) {
        if (output.length >= input.limit) {
          moreAvailable = true
          break
        }
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        const lineTruncated =
          line.length > MAXIMUM_LINE_CHARACTERS ||
          (lineIndex === 0 && carriedLineTruncated)
        const preview = `${line.slice(0, MAXIMUM_LINE_CHARACTERS)}${
          lineTruncated ? '...[line truncated]' : ''
        }`
        const formatted = `${currentLine}: ${preview}`
        const bytes = Buffer.byteLength(formatted) + 1
        if (resultBytes + bytes > MAXIMUM_RESULT_BYTES) {
          moreAvailable = true
          break
        }
        output.push(formatted)
        resultBytes += bytes
      }
      currentLine += 1
    }
    if (moreAvailable) break
    if (!page.truncated) {
      if (pending && currentLine >= input.offset && output.length < input.limit) {
        const formatted = `${currentLine}: ${pending.slice(0, MAXIMUM_LINE_CHARACTERS)}`
        if (resultBytes + Buffer.byteLength(formatted) + 1 <= MAXIMUM_RESULT_BYTES) {
          output.push(formatted)
        } else {
          moreAvailable = true
        }
      }
      break
    }
    if (page.bytesRead === 0) {
      throw new Error('工作区读取分页无法继续')
    }
  }

  if (output.length === 0) {
    return `[no lines at offset ${input.offset}; ${totalBytes ?? 0} bytes]`
  }
  const lastLine = Number.parseInt(output.at(-1)!, 10)
  const footer = moreAvailable
    ? `[lines ${input.offset}-${lastLine}; more available]`
    : `[lines ${input.offset}-${lastLine}; end of file; ${totalBytes ?? 0} bytes]`
  return `${output.join('\n')}\n${footer}`
}
