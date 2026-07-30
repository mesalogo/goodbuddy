import spawn from 'cross-spawn'
import type {
  AgentEvent,
  AgentRequest,
  AgentRuntimeStatus
} from '../../shared/contracts'
import type { AgentRuntime } from './runtime'

type ContinueRuntimeOptions = {
  command: string
  defaultWorkspace: string
}

function extractContinueText(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) {
    return ''
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of ['content', 'message', 'response', 'text']) {
        const value = record[key]
        if (typeof value === 'string') {
          return value
        }
      }
    }
  } catch {
    return trimmed
  }

  return trimmed
}

export class ContinueAgentRuntime implements AgentRuntime {
  readonly requiresToolApproval = true
  private readonly children = new Set<ReturnType<typeof spawn>>()

  constructor(private readonly options: ContinueRuntimeOptions) {}

  private terminate(child: ReturnType<typeof spawn>): void {
    if (child.exitCode !== null || child.killed) {
      return
    }
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', [
        '/PID',
        String(child.pid),
        '/T',
        '/F'
      ])
      killer.unref()
    } else {
      child.kill('SIGTERM')
    }
  }

  private checkAvailability(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.options.command, ['--version'], {
        cwd: this.options.defaultWorkspace,
        env: {
          ...process.env,
          FORCE_NO_TTY: '1'
        },
        stdio: 'ignore',
        windowsHide: true
      })
      const timeout = setTimeout(() => {
        child.kill()
        resolve(false)
      }, 2_000)
      child.once('error', () => {
        clearTimeout(timeout)
        resolve(false)
      })
      child.once('exit', (code) => {
        clearTimeout(timeout)
        resolve(code === 0)
      })
    })
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    const available = await this.checkAvailability()
    return {
      id: 'continue',
      label: 'Continue CLI',
      available,
      detail: available
        ? '通过 Continue CLI headless 模式执行'
        : 'Continue CLI 不可用'
    }
  }

  async *run(
    request: AgentRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, void, void> {
    signal.throwIfAborted()
    yield {
      requestId: request.requestId,
      type: 'status',
      message: 'Continue 正在执行任务'
    }

    const result = await new Promise<string>((resolve, reject) => {
      signal.throwIfAborted()
      const child = spawn(
        this.options.command,
        ['-p', '--format', 'json', '--silent'],
        {
          cwd: this.options.defaultWorkspace,
          env: {
            ...process.env,
            CONTINUE_CLI_DISABLE_COMMIT_SIGNATURE: '1',
            FORCE_NO_TTY: '1'
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        }
      )
      this.children.add(child)
      const { stdin, stdout: childStdout, stderr: childStderr } = child
      if (!stdin || !childStdout || !childStderr) {
        this.terminate(child)
        reject(new Error('Continue CLI 管道初始化失败'))
        return
      }
      let stdout = ''
      let stderr = ''
      let outputExceeded = false
      const abort = (): void => {
        this.terminate(child)
        reject(signal.reason)
      }

      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      childStdout.setEncoding('utf8')
      childStderr.setEncoding('utf8')
      childStdout.on('data', (chunk: string) => {
        stdout += chunk
        if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
          outputExceeded = true
          this.terminate(child)
        }
      })
      childStderr.on('data', (chunk: string) => {
        stderr += chunk
        if (Buffer.byteLength(stderr) > 64 * 1024) {
          outputExceeded = true
          this.terminate(child)
        }
      })
      child.once('error', (error) => {
        this.children.delete(child)
        signal.removeEventListener('abort', abort)
        reject(error)
      })
      child.once('close', (code) => {
        this.children.delete(child)
        signal.removeEventListener('abort', abort)
        if (outputExceeded) {
          reject(new Error('Continue CLI 输出超过安全限制'))
        } else if (code === 0) {
          resolve(stdout)
        } else {
          reject(
            new Error(
              stderr.trim().slice(0, 1_000) ||
                `Continue CLI 已退出（code ${code ?? 'unknown'}）`
            )
          )
        }
      })
      stdin.end(request.prompt)
    })

    const text = extractContinueText(result)
    if (!text) {
      throw new Error('Continue CLI 未返回内容')
    }

    yield {
      requestId: request.requestId,
      type: 'text',
      delta: text
    }
    yield {
      requestId: request.requestId,
      type: 'done'
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once('close', () => resolve())
            this.terminate(child)
            setTimeout(resolve, 2_000)
          })
      )
    )
    this.children.clear()
  }
}
