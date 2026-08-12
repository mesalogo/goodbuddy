import type { Dirent } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const difference = relative(rootPath, candidatePath)
  return (
    difference === '' ||
    (!difference.startsWith('..') && !isAbsolute(difference))
  )
}

export async function getCanonicalWorkspace(
  rootPath: string,
  invalidDirectoryMessage = '项目工作区不是目录'
): Promise<string> {
  const canonicalRoot = await realpath(rootPath)
  if (!(await stat(canonicalRoot)).isDirectory()) {
    throw new Error(invalidDirectoryMessage)
  }
  return canonicalRoot
}

export async function resolveExistingWorkspacePath(
  canonicalRoot: string,
  pathSegments: string[],
  expected: 'file' | 'directory'
): Promise<string> {
  const candidate = resolve(canonicalRoot, ...pathSegments)
  if (!isPathInside(canonicalRoot, candidate)) {
    throw new Error('文件路径不能超出项目工作区')
  }
  const canonicalPath = await realpath(candidate)
  if (!isPathInside(canonicalRoot, canonicalPath)) {
    throw new Error('文件路径不能通过符号链接超出项目工作区')
  }
  const metadata = await stat(canonicalPath)
  if (
    (expected === 'file' && !metadata.isFile()) ||
    (expected === 'directory' && !metadata.isDirectory())
  ) {
    throw new Error(
      expected === 'file' ? '目标不是普通文件' : '目标不是目录'
    )
  }
  return canonicalPath
}

export async function readBoundedUtf8File(
  filePath: string,
  maximumBytes: number,
  tooLargeMessage: string,
  invalidUtf8Message: string
): Promise<{ content: string; size: number }> {
  const data = await readBoundedFile(
    filePath,
    maximumBytes,
    tooLargeMessage
  )
  try {
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(data),
      size: data.byteLength
    }
  } catch (error) {
    throw new Error(invalidUtf8Message, { cause: error })
  }
}

export async function readBoundedFile(
  filePath: string,
  maximumBytes: number,
  tooLargeMessage: string,
  invalidFileMessage = tooLargeMessage
): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new Error(invalidFileMessage)
    }
    if (metadata.size > maximumBytes) {
      throw new Error(tooLargeMessage)
    }
    const data = Buffer.alloc(metadata.size + 1)
    let bytesRead = 0
    while (bytesRead < data.length) {
      const result = await handle.read(
        data,
        bytesRead,
        data.length - bytesRead,
        bytesRead
      )
      if (result.bytesRead === 0) {
        break
      }
      bytesRead += result.bytesRead
      if (bytesRead > maximumBytes) {
        throw new Error(tooLargeMessage)
      }
    }
    return data.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function listBoundedDirectoryEntries(
  directoryPath: string,
  maximumEntries: number,
  include: (entry: Dirent) => boolean = () => true
): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const entries: Dirent[] = []
  const directory = await opendir(directoryPath)
  for await (const entry of directory) {
    if (!include(entry)) {
      continue
    }
    entries.push(entry)
    if (entries.length > maximumEntries) {
      break
    }
  }
  return {
    entries: entries.slice(0, maximumEntries),
    truncated: entries.length > maximumEntries
  }
}
