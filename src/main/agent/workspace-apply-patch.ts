import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep, win32 } from 'node:path'
import type { WorkspaceAccess } from '../workspace'

type PatchOperation =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'update'; path: string; hunks: PatchHunk[] }
  | { kind: 'delete'; path: string }

type PatchHunk = {
  section?: string
  lines: Array<{ kind: 'context' | 'add' | 'delete'; text: string }>
}

type PreparedOperation =
  | { kind: 'write'; path: string; target: string; content: string; mode: number }
  | { kind: 'delete'; path: string; target: string }

const MAXIMUM_RESULT_BYTES = 200 * 1024

function normalizedPatchPath(value: string): string {
  const path = value.trim().replaceAll('\\', '/')
  if (
    !path ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes('\0')
  ) {
    throw new Error(`补丁路径无效：${value}`)
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`补丁路径不能超出工作区：${value}`)
  }
  return segments.join('/')
}

function parseUpdateHunks(lines: string[], path: string): PatchHunk[] {
  const hunks: PatchHunk[] = []
  let current: PatchHunk | undefined
  for (const line of lines) {
    if (line === '@@' || line.startsWith('@@ ')) {
      current = {
        ...(line.length > 3 ? { section: line.slice(3) } : {}),
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) {
      if (!line) continue
      throw new Error(`更新文件 ${path} 的补丁缺少 @@ hunk`)
    }
    const prefix = line[0]
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
      throw new Error(`更新文件 ${path} 包含无效补丁行`)
    }
    current.lines.push({
      kind: prefix === '+' ? 'add' : prefix === '-' ? 'delete' : 'context',
      text: line.slice(1)
    })
  }
  if (hunks.length === 0 || hunks.some((hunk) => hunk.lines.length === 0)) {
    throw new Error(`更新文件 ${path} 的补丁 hunk 为空`)
  }
  return hunks
}

export function parseWorkspacePatch(patch: string): PatchOperation[] {
  const lines = patch.replaceAll('\r\n', '\n').split('\n')
  if (lines.shift() !== '*** Begin Patch') {
    throw new Error('补丁必须以 *** Begin Patch 开始')
  }
  const operations: PatchOperation[] = []
  while (lines.length > 0) {
    const header = lines.shift()!
    if (header === '*** End Patch') {
      if (lines.some(Boolean)) {
        throw new Error('*** End Patch 后不能包含其他内容')
      }
      if (operations.length === 0) {
        throw new Error('补丁不包含文件操作')
      }
      return operations
    }
    const match = header.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/u)
    if (!match) {
      throw new Error(`无效补丁文件头：${header}`)
    }
    const path = normalizedPatchPath(match[2]!)
    const body: string[] = []
    while (lines.length > 0 && !lines[0]!.startsWith('*** ')) {
      body.push(lines.shift()!)
    }
    if (match[1] === 'Add') {
      if (body.some((line) => !line.startsWith('+'))) {
        throw new Error(`新增文件 ${path} 的每一行都必须以 + 开始`)
      }
      operations.push({
        kind: 'add',
        path,
        content: body.map((line) => line.slice(1)).join('\n')
      })
    } else if (match[1] === 'Update') {
      operations.push({ kind: 'update', path, hunks: parseUpdateHunks(body, path) })
    } else {
      if (body.some(Boolean)) {
        throw new Error(`删除文件 ${path} 不能包含补丁正文`)
      }
      operations.push({ kind: 'delete', path })
    }
  }
  throw new Error('补丁缺少 *** End Patch')
}

function sequenceMatches(
  source: string[],
  expected: string[],
  index: number,
  relaxed: boolean
): boolean {
  return expected.every((line, offset) =>
    relaxed
      ? source[index + offset]?.trimEnd() === line.trimEnd()
      : source[index + offset] === line
  )
}

function findSequence(
  source: string[],
  expected: string[],
  start: number
): number {
  if (expected.length === 0) return start
  for (const relaxed of [false, true]) {
    for (let index = start; index <= source.length - expected.length; index += 1) {
      if (sequenceMatches(source, expected, index, relaxed)) return index
    }
  }
  return -1
}

export function applyUpdateHunks(
  content: string,
  hunks: PatchHunk[],
  path: string
): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  let source = content.replaceAll('\r\n', '\n').split('\n')
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.section) {
      const sectionIndex = source.findIndex(
        (line, index) => index >= cursor && line.includes(hunk.section!)
      )
      if (sectionIndex < 0) {
        throw new Error(`无法在 ${path} 中找到补丁区段：${hunk.section}`)
      }
      cursor = sectionIndex
    }
    const expected = hunk.lines
      .filter((line) => line.kind !== 'add')
      .map((line) => line.text)
    const replacement = hunk.lines
      .filter((line) => line.kind !== 'delete')
      .map((line) => line.text)
    const index = findSequence(source, expected, cursor)
    if (index < 0) {
      throw new Error(`无法在 ${path} 中匹配补丁上下文`)
    }
    source = [
      ...source.slice(0, index),
      ...replacement,
      ...source.slice(index + expected.length)
    ]
    cursor = index + replacement.length
  }
  return source.join(newline)
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

async function resolveTarget(
  root: string,
  patchPath: string,
  createParents: boolean
): Promise<string> {
  const segments = patchPath.split('/')
  let current = root
  for (const [index, segment] of segments.slice(0, -1).entries()) {
    current = join(current, segment)
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!metadata) {
      if (!createParents) throw new Error(`补丁父目录不存在：${patchPath}`)
      return join(current, ...segments.slice(index + 1))
    } else if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`补丁路径包含非普通目录：${patchPath}`)
    }
  }
  const canonicalParent = await realpath(join(root, ...segments.slice(0, -1)))
  if (!isInside(root, canonicalParent)) {
    throw new Error(`补丁路径不能通过符号链接超出工作区：${patchPath}`)
  }
  return join(canonicalParent, segments.at(-1)!)
}

async function readUtf8(path: string): Promise<string> {
  const bytes = await readFile(path)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error('补丁只能修改有效 UTF-8 文本文件', { cause: error })
  }
}

async function writeAtomic(target: string, content: string, mode: number): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', mode)
  try {
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function applyWorkspacePatch(
  patch: string,
  workspace: WorkspaceAccess,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  const identity = await workspace.getIdentity()
  if (identity.kind !== 'local') {
    throw new Error('工作区补丁当前只支持本机工作区')
  }
  const root = await realpath(identity.canonicalDisplayPath)
  const operations = parseWorkspacePatch(patch)
  const seen = new Set<string>()
  const prepared: PreparedOperation[] = []
  for (const operation of operations) {
    signal.throwIfAborted()
    const targetKey = process.platform === 'win32' ? operation.path.toLowerCase() : operation.path
    if (seen.has(targetKey)) {
      throw new Error(`同一补丁不能重复操作文件：${operation.path}`)
    }
    seen.add(targetKey)
    const target = await resolveTarget(root, operation.path, operation.kind === 'add')
    const metadata = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (metadata?.isSymbolicLink() || (metadata && !metadata.isFile())) {
      throw new Error(`补丁目标不是普通文件：${operation.path}`)
    }
    if (operation.kind === 'add') {
      if (metadata) throw new Error(`新增文件已经存在：${operation.path}`)
      prepared.push({
        kind: 'write',
        path: operation.path,
        target,
        content: operation.content,
        mode: 0o600
      })
      continue
    }
    if (!metadata) throw new Error(`补丁目标不存在：${operation.path}`)
    if (operation.kind === 'delete') {
      prepared.push({ kind: 'delete', path: operation.path, target })
      continue
    }
    const content = applyUpdateHunks(
      await readUtf8(target),
      operation.hunks,
      operation.path
    )
    prepared.push({
      kind: 'write',
      path: operation.path,
      target,
      content,
      mode: (await stat(target)).mode & 0o777
    })
  }

  const applied: string[] = []
  try {
    for (const operation of prepared) {
      signal.throwIfAborted()
      if (operation.kind === 'delete') {
        await rm(operation.target)
      } else {
        await mkdir(dirname(operation.target), { recursive: true, mode: 0o700 })
        await writeAtomic(operation.target, operation.content, operation.mode)
      }
      applied.push(operation.path)
    }
  } catch (error) {
    throw new Error(
      `补丁仅完成 ${applied.length}/${prepared.length} 个文件：${applied.join(', ') || '无'}`,
      { cause: error }
    )
  }
  const header = `Applied patch to ${applied.length} file(s):`
  const result = [header]
  let resultBytes = Buffer.byteLength(header) + 1
  for (const path of applied) {
    const bytes = Buffer.byteLength(path) + 1
    if (resultBytes + bytes > MAXIMUM_RESULT_BYTES) {
      result.push(`...[${applied.length - result.length + 1} more files]`)
      break
    }
    result.push(path)
    resultBytes += bytes
  }
  return result.join('\n')
}
