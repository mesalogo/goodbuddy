import { execFile } from 'node:child_process'
import type { WorkspaceAccess } from '../workspace'

const MAXIMUM_CAPTURE_BYTES = 4 * 1024 * 1024
const MAXIMUM_RESULT_BYTES = 240 * 1024

export type WorkspaceRipgrepInput = {
  pattern?: string
  path: string
  glob: string[]
  fixedStrings: boolean
  ignoreCase: boolean
  filesOnly: boolean
  maxResults: number
}

type RipgrepProcessResult = {
  stdout: string
  stderr: string
  code: number | string | null | undefined
  truncated: boolean
}

function runRipgrep(
  executablePath: string,
  args: string[],
  cwd: string,
  signal: AbortSignal
): Promise<RipgrepProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAXIMUM_CAPTURE_BYTES,
        signal,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(signal.reason ?? error)
          return
        }
        const processError = error as (Error & {
          code?: number | string
          killed?: boolean
        }) | null
        const output = stdout
        const errors = stderr
        if (
          processError &&
          processError.code !== 1 &&
          processError.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ) {
          reject(
            new Error(
              errors.trim().slice(0, 2_000) ||
                processError.message ||
                'ripgrep 执行失败',
              { cause: processError }
            )
          )
          return
        }
        resolve({
          stdout: output,
          stderr: errors,
          code: processError?.code ?? 0,
          truncated:
            processError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        })
      }
    )
  })
}

function normalizeResultPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '')
}

function appendBounded(
  lines: string[],
  line: string,
  state: { bytes: number }
): boolean {
  const bytes = Buffer.byteLength(line) + 1
  if (state.bytes + bytes > MAXIMUM_RESULT_BYTES) {
    return false
  }
  lines.push(line)
  state.bytes += bytes
  return true
}

function formatFileResults(
  stdout: string,
  maximumResults: number,
  initiallyTruncated: boolean
): string {
  const paths = stdout
    .split('\0')
    .filter(Boolean)
    .map(normalizeResultPath)
  const lines: string[] = []
  const state = { bytes: 0 }
  let truncated = initiallyTruncated || paths.length > maximumResults
  for (const path of paths.slice(0, maximumResults)) {
    if (!appendBounded(lines, path, state)) {
      truncated = true
      break
    }
  }
  if (truncated) {
    lines.push(`...[truncated after ${lines.length} files]`)
  }
  return lines.join('\n') || '[no files found]'
}

function textField(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('text' in value)) {
    return undefined
  }
  return typeof value.text === 'string' ? value.text : undefined
}

function formatMatchResults(
  stdout: string,
  maximumResults: number,
  initiallyTruncated: boolean
): string {
  const lines: string[] = []
  const state = { bytes: 0 }
  let truncated = initiallyTruncated
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine) continue
    let event: unknown
    try {
      event = JSON.parse(rawLine)
    } catch {
      continue
    }
    if (
      !event ||
      typeof event !== 'object' ||
      !('type' in event) ||
      event.type !== 'match' ||
      !('data' in event) ||
      !event.data ||
      typeof event.data !== 'object'
    ) {
      continue
    }
    const data = event.data as Record<string, unknown>
    const path = textField(data.path)
    const matchedLines = textField(data.lines)
    const lineNumber = data.line_number
    const submatches = data.submatches
    if (
      path === undefined ||
      matchedLines === undefined ||
      typeof lineNumber !== 'number' ||
      !Array.isArray(submatches)
    ) {
      continue
    }
    const first = submatches[0]
    const byteColumn =
      first &&
      typeof first === 'object' &&
      'start' in first &&
      typeof first.start === 'number'
        ? first.start + 1
        : 1
    const linePrefix = Buffer.from(matchedLines).subarray(0, byteColumn - 1)
    const column = [...linePrefix.toString('utf8')].length + 1
    const preview = matchedLines
      .replaceAll('\r', '')
      .replaceAll('\n', '\\n')
      .slice(0, 1_000)
    const formatted = `${normalizeResultPath(path)}:${lineNumber}:${column}:${preview}`
    if (
      lines.length >= maximumResults ||
      !appendBounded(lines, formatted, state)
    ) {
      truncated = true
      break
    }
  }
  if (truncated) {
    lines.push(`...[truncated after ${lines.length} matches]`)
  }
  return lines.join('\n') || '[no matches found]'
}

export async function searchWorkspaceWithRipgrep(
  executablePath: string,
  input: WorkspaceRipgrepInput,
  workspace: WorkspaceAccess,
  signal: AbortSignal
): Promise<string> {
  const identity = await workspace.getIdentity()
  if (identity.kind !== 'local') {
    throw new Error('内置 ripgrep 当前只支持本机工作区')
  }
  if (input.path !== '.') {
    await workspace.stat({ path: input.path, signal })
  }
  const args = ['--no-config', '--hidden', '--glob', '!.git/**']
  for (const glob of input.glob) {
    args.push('--glob', glob)
  }
  if (input.filesOnly) {
    args.push('--files', '--null', '--', input.path)
  } else {
    args.push('--json')
    if (input.fixedStrings) args.push('--fixed-strings')
    if (input.ignoreCase) args.push('--ignore-case')
    args.push('--regexp', input.pattern!, '--', input.path)
  }
  const result = await runRipgrep(
    executablePath,
    args,
    identity.canonicalDisplayPath,
    signal
  )
  return input.filesOnly
    ? formatFileResults(
        result.stdout,
        input.maxResults,
        result.truncated
      )
    : formatMatchResults(
        result.stdout,
        input.maxResults,
        result.truncated
      )
}
