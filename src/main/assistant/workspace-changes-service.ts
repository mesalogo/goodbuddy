import spawn from 'cross-spawn'
import type { WorkspaceChanges } from '../../shared/assistant-contracts'

const MAX_OUTPUT_BYTES = 512 * 1024
const COMMAND_TIMEOUT_MS = 10_000

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

export async function getWorkspaceChanges(
  rootPath: string
): Promise<WorkspaceChanges> {
  if (!rootPath.trim()) {
    return {
      rootPath,
      available: false,
      status: '',
      patch: '',
      truncated: false,
      error: '项目尚未配置工作区目录'
    }
  }
  try {
    const [status, patch] = await Promise.all([
      runGit(rootPath, ['status', '--short', '--untracked-files=normal']),
      runGit(rootPath, ['diff', '--no-ext-diff', '--no-color', 'HEAD'])
    ])
    if (status.code !== 0 || patch.code !== 0) {
      const detail = status.stderr || patch.stderr
      return {
        rootPath,
        available: false,
        status: '',
        patch: '',
        truncated: status.truncated || patch.truncated,
        error: detail.trim().slice(0, 2_000) || '无法读取 Git 工作区'
      }
    }
    return {
      rootPath,
      available: true,
      status: status.stdout,
      patch: patch.stdout,
      truncated: status.truncated || patch.truncated
    }
  } catch (error) {
    return {
      rootPath,
      available: false,
      status: '',
      patch: '',
      truncated: false,
      error:
        error instanceof Error ? error.message : '无法读取 Git 工作区'
    }
  }
}
