import spawn from 'cross-spawn'
import { basename, extname } from 'node:path'
import type {
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceDirectoryListing,
  WorkspaceFilePreview
} from '../../shared/assistant-contracts'
import {
  getCanonicalWorkspace,
  listBoundedDirectoryEntries,
  readBoundedUtf8File,
  resolveExistingWorkspacePath
} from '../workspace-file-access'

const MAX_OUTPUT_BYTES = 512 * 1024
const COMMAND_TIMEOUT_MS = 10_000
const MAX_DIRECTORY_ENTRIES = 500
const MAX_CHANGED_FILES = 2_000
const MAX_PREVIEW_BYTES = 256 * 1024
const previewExtensions = new Set([
  '.c',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.log',
  '.md',
  '.markdown',
  '.php',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml'
])
const previewFileNames = new Set([
  'dockerfile',
  'license',
  'makefile',
  'notice',
  'readme'
])

type CommandResult = {
  code: number | null
  stdout: string
  stderr: string
  truncated: boolean
}

function runGit(
  rootPath: string,
  args: string[]
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: rootPath,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let truncated = false
    const capture = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.from(chunk)
      const remaining = MAX_OUTPUT_BYTES - bytes
      if (remaining <= 0) {
        truncated = true
        return
      }
      target.push(buffer.subarray(0, remaining))
      bytes += Math.min(buffer.byteLength, remaining)
      truncated ||= buffer.byteLength > remaining
    }
    child.stdout?.on('data', (chunk: Buffer | string) =>
      capture(stdout, chunk)
    )
    child.stderr?.on('data', (chunk: Buffer | string) =>
      capture(stderr, chunk)
    )
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('读取文件更改超时'))
    }, COMMAND_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated
      })
    })
  })
}

function pathSegments(inputPath: string, allowRoot: boolean): string[] {
  const normalized = inputPath.replaceAll('\\', '/')
  if (allowRoot && normalized === '') {
    return []
  }
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//u.test(normalized)
  ) {
    throw new Error('路径必须是工作区内的相对路径')
  }
  const segments = normalized.split('/')
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || segment.includes('\0')
    )
  ) {
    throw new Error('路径必须是工作区内的相对路径')
  }
  return segments
}

async function resolveWorkspacePath(
  rootPath: string,
  inputPath: string,
  expected: 'file' | 'directory'
): Promise<{ canonicalPath: string; path: string }> {
  const canonicalRoot = await getCanonicalWorkspace(rootPath)
  const segments = pathSegments(inputPath, expected === 'directory')
  const canonicalPath = await resolveExistingWorkspacePath(
    canonicalRoot,
    segments,
    expected
  )
  return {
    canonicalPath,
    path: segments.join('/')
  }
}

function parseChangedFiles(status: string): {
  files: WorkspaceChangedFile[]
  truncated: boolean
} {
  const records = status.split('\0')
  const files: WorkspaceChangedFile[] = []
  let index = 0
  while (index < records.length && files.length < MAX_CHANGED_FILES) {
    const record = records[index]
    index += 1
    if (!record) {
      continue
    }
    const statusCode = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) {
      continue
    }
    const renamed = statusCode.includes('R') || statusCode.includes('C')
    const previousPath = renamed ? records[index] : undefined
    if (renamed) {
      index += 1
    }
    files.push({
      path,
      status: statusCode,
      ...(previousPath ? { previousPath } : {})
    })
  }
  return {
    files,
    truncated: index < records.length - 1
  }
}

function formatChangedFiles(files: WorkspaceChangedFile[]): string {
  return files
    .map((file) =>
      file.previousPath
        ? `${file.status} ${file.previousPath} -> ${file.path}`
        : `${file.status} ${file.path}`
    )
    .join('\n')
}

export async function getWorkspaceChanges(
  rootPath: string
): Promise<WorkspaceChanges> {
  if (!rootPath.trim()) {
    return {
      rootPath,
      available: false,
      status: '',
      patch: '',
      files: [],
      truncated: false,
      error: '项目尚未配置工作区目录'
    }
  }
  try {
    const [status, patch] = await Promise.all([
      runGit(rootPath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal'
      ]),
      runGit(rootPath, ['diff', '--no-ext-diff', '--no-color', 'HEAD'])
    ])
    if (status.code !== 0 || patch.code !== 0) {
      const detail = status.stderr || patch.stderr
      return {
        rootPath,
        available: false,
        status: '',
        patch: '',
        files: [],
        truncated: status.truncated || patch.truncated,
        error: detail.trim().slice(0, 2_000) || '无法读取 Git 工作区'
      }
    }
    const changedFiles = parseChangedFiles(status.stdout)
    return {
      rootPath,
      available: true,
      status: formatChangedFiles(changedFiles.files),
      patch: patch.stdout,
      files: changedFiles.files,
      truncated:
        status.truncated || patch.truncated || changedFiles.truncated
    }
  } catch (error) {
    return {
      rootPath,
      available: false,
      status: '',
      patch: '',
      files: [],
      truncated: false,
      error:
        error instanceof Error ? error.message : '无法读取 Git 工作区'
    }
  }
}

export async function listWorkspaceDirectory(
  rootPath: string,
  inputPath: string
): Promise<WorkspaceDirectoryListing> {
  const directory = await resolveWorkspacePath(
    rootPath,
    inputPath,
    'directory'
  )
  const listing = await listBoundedDirectoryEntries(
    directory.canonicalPath,
    MAX_DIRECTORY_ENTRIES,
    (entry) =>
      entry.name !== '.git' && (entry.isDirectory() || entry.isFile())
  )
  const entries = listing.entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })
  return {
    path: directory.path,
    entries: entries.map((entry) => ({
      name: entry.name,
      path: [directory.path, entry.name].filter(Boolean).join('/'),
      type: entry.isDirectory() ? 'directory' : 'file'
    })),
    truncated: listing.truncated
  }
}

export async function readWorkspaceFile(
  rootPath: string,
  inputPath: string
): Promise<WorkspaceFilePreview> {
  const file = await resolveWorkspacePath(rootPath, inputPath, 'file')
  const name = basename(file.canonicalPath)
  const extension = extname(name).toLowerCase()
  if (
    !previewExtensions.has(extension) &&
    !previewFileNames.has(name.toLowerCase())
  ) {
    throw new Error('当前文件类型不支持安全预览')
  }
  const preview = await readBoundedUtf8File(
    file.canonicalPath,
    MAX_PREVIEW_BYTES,
    '工作区文件超过 256KB 预览限制',
    '工作区文件不是有效 UTF-8 文本'
  )
  return {
    path: file.path,
    name,
    content: preview.content,
    mimeType:
      extension === '.md' || extension === '.markdown'
        ? 'text/markdown'
        : extension === '.json'
          ? 'application/json'
          : 'text/plain',
    size: preview.size
  }
}
