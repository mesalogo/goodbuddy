import { execFile } from 'node:child_process'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { workspaceManagementActionSchema, type WorkspaceManagementAction, type WorkspaceManagementResult } from '../../shared/workspace-management-contracts'
import { getCanonicalWorkspace, isPathInside } from '../workspace-file-access'

// Shared by the local workspace and the Agent after resolving its workspace handle.
export async function manageWorkspace(rootPath: string, input: WorkspaceManagementAction, signal?: AbortSignal): Promise<WorkspaceManagementResult> {
  const action = workspaceManagementActionSchema.parse(input)
  signal?.throwIfAborted()
  const root = await getCanonicalWorkspace(rootPath)
  const git = (args: string[]): Promise<string> => new Promise((resolveOutput, reject) => {
    execFile('git', ['--no-pager', '--literal-pathspecs', '-C', root, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolveOutput(stdout)
    })
  })
  if (['createFile', 'createDirectory', 'move', 'delete', 'properties'].includes(action.kind) && 'path' in action) {
    const target = resolve(root, action.path)
    const parent = await realpath(dirname(target))
    if (target === root || !isPathInside(root, target) || !isPathInside(root, parent)) throw new Error('Path is outside the workspace')
    if (action.kind === 'createFile') {
      const handle = await open(target, 'wx')
      await handle.close()
    } else if (action.kind === 'createDirectory') {
      await mkdir(target)
    } else {
      const metadata = await lstat(target)
      if (metadata.isSymbolicLink()) throw new Error('Cannot modify a symbolic link through workspace management')
      if (action.kind === 'properties') return { kind: 'properties', path: target, type: metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other', size: metadata.size, modifiedAt: metadata.mtime.toISOString() }
      if (action.kind === 'delete') await rm(target, { recursive: metadata.isDirectory() })
      if (action.kind === 'move') {
        const destination = resolve(root, action.destination)
        const destinationParent = await realpath(dirname(destination))
        if (!isPathInside(root, destinationParent) || !isPathInside(root, destination) || destination === root) throw new Error('Destination is outside the workspace')
        try { await lstat(destination) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          signal?.throwIfAborted()
          await rename(target, destination)
          return { kind: 'done' }
        }
        throw new Error('Destination already exists')
      }
    }
    return { kind: 'done' }
  }
  switch (action.kind) {
    case 'branches': {
      const current = (await git(['branch', '--show-current'])).trim()
      const output = await git(['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes'])
      return { kind: 'branches', current, branches: output.trim().split('\n').filter(Boolean).flatMap((line) => {
        const [ref, symbolic] = line.split('\0')
        if (!ref || symbolic) return []
        return [{ name: ref.replace(/^refs\/(heads|remotes)\//, ''), remote: ref.startsWith('refs/remotes/') }]
      }) }
    }
    case 'createBranch':
      await git(['check-ref-format', '--branch', action.branch])
      await git(['switch', '-c', action.branch])
      return { kind: 'done' }
    case 'switchBranch':
      await git(['check-ref-format', '--branch', action.branch])
      await git(action.remote ? ['switch', '--track', action.branch] : ['switch', action.branch])
      return { kind: 'done' }
    case 'fetch':
      await git(['fetch', '--all'])
      return { kind: 'done' }
    case 'history': {
      let head = action.head
      if (!head) {
        const refs = (await git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(async (error: unknown) => {
          // An unborn branch has no commits; other repository errors remain visible.
          await git(['symbolic-ref', 'HEAD'])
          if ((await git(['rev-list', '--all', '--max-count=1'])).trim()) throw error
          return ''
        })).trim()
        if (!refs) return { kind: 'history', commits: [], hasMore: false }
        head = refs
      }
      const output = await git(['log', head, `--skip=${action.offset}`, '-n', '51', '--format=%H%x00%s%x00%an%x00%aI%x00%D%x00'])
      const fields = output.split('\0')
      const commits: Extract<WorkspaceManagementResult, { kind: 'history' }>['commits'] = []
      for (let index = 0; index + 4 < fields.length; index += 5) commits.push({ oid: fields[index]!.trim(), subject: fields[index + 1]!, author: fields[index + 2]!, time: fields[index + 3]!, refs: fields[index + 4]! })
      return { kind: 'history', head, commits: commits.slice(0, 50), hasMore: commits.length > 50 }
    }
    case 'commitFiles': {
      const output = await git(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-m', '--first-parent', '-M', '-z', action.oid])
      const fields = output.split('\0')
      const files: Extract<WorkspaceManagementResult, { kind: 'commitFiles' }>['files'] = []
      for (let index = 0; index + 1 < fields.length;) {
        const status = fields[index++]!
        const first = fields[index++]!
        const renamed = /^[RC]/.test(status)
        files.push({ status, path: renamed ? fields[index++]! : first, ...(renamed ? { previousPath: first } : {}) })
      }
      return { kind: 'commitFiles', files }
    }
    case 'commitDiff': {
      const patch = await git(['show', '--format=', '--first-parent', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', action.oid, '--', action.path])
      return { kind: 'commitDiff', patch: patch.slice(0, 256 * 1024), truncated: patch.length > 256 * 1024 }
    }
    default: throw new Error('Unsupported workspace action')
  }
}
