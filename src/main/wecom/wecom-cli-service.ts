import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, normalize, relative, resolve, sep } from 'node:path'
import {
  WECOM_CLI_VERSION,
  defaultWecomToolSettings,
  wecomCategorySkill,
  wecomCommandCategory,
  wecomScriptCategories,
  wecomScriptPythonPackages,
  wecomScriptPythonVersion,
  wecomSharedSkill,
  wecomToolCategories,
  wecomToolSettingsSchema,
  type WecomAuthorization,
  type WecomCliState,
  type WecomDocument,
  type WecomManualCredentials,
  type WecomQrAuthorization,
  type WecomSnapshot,
  type WecomToolCategory,
  type WecomToolSettings,
  type WecomToolSettingsUpdate
} from '../../shared/wecom-contracts'
import { buildCredentialFilteredUserEnvironment } from '../agent/process-environment'
import { isMissingFileError, writeJsonFileAtomically } from '../settings-file-utils'

const MAX_OUTPUT_BYTES = 256 * 1024
const COMMAND_TIMEOUT_MS = 120_000
const QR_TIMEOUT_MS = 5 * 60_000
const MAX_GUIDE_CHARACTERS = 24_000

/** Python variables that must not leak into the isolated script environment. */
function scriptEnvironment(): NodeJS.ProcessEnv {
  const environment = buildCredentialFilteredUserEnvironment()
  for (const name of Object.keys(environment)) {
    if (/^(PYTHONHOME|PYTHONPATH|PYTHONSTARTUP|PYTHONUSERBASE|VIRTUAL_ENV|CONDA_PREFIX|PIP_REQUIRE_VIRTUALENV)$/iu.test(name)) delete environment[name]
  }
  environment.PYTHONUTF8 = '1'
  environment.PYTHONIOENCODING = 'utf-8'
  return environment
}

export type WecomCliResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
}

export type WecomChannelCredentials = { botId: string; secret: string }

export type WecomCliServiceOptions = {
  rootDirectory: string
  skillsDirectory: string
  /**
   * Offline bundle shipped with GoodBuddy (resources/runtimes/wecom): bin/wecom-cli,
   * wheels/*.whl and ready.json written by build/wecom-resources.cjs.
   */
  bundleDirectory: string
  resolveChannelCredentials?: () => Promise<WecomChannelCredentials | undefined>
  platform?: NodeJS.Platform
  /** Resolves the local tool environment Python (managed or custom) for skill scripts. */
  resolvePython?: () => Promise<string | undefined>
  /** Test seam for spawning the CLI. */
  spawnProcess?: typeof spawn
}

type RunOptions = {
  signal?: AbortSignal
  cwd?: string
  timeoutMs?: number
}

/** Owns the bundled wecom-cli, its isolated credentials and tool preferences. Works offline. */
export class WecomCliService {
  private readonly listeners = new Set<(snapshot: WecomSnapshot) => void>()
  private cli: WecomCliState = { state: 'missing' }
  private authorization: WecomAuthorization = { state: 'unknown' }
  private qr: WecomQrAuthorization = { state: 'idle' }
  private qrProcess?: ChildProcess
  private settings?: WecomToolSettings
  private serial: Promise<unknown> = Promise.resolve()
  private revision = 0

  constructor(private readonly options: WecomCliServiceOptions) {}

  private get configDirectory(): string { return join(this.options.rootDirectory, 'config') }
  private get settingsPath(): string { return join(this.options.rootDirectory, 'settings.json') }
  get downloadsDirectory(): string { return join(this.options.rootDirectory, 'downloads') }
  private get pythonDirectory(): string { return join(this.options.rootDirectory, 'python') }

  private get binaryPath(): string {
    const name = (this.options.platform ?? process.platform) === 'win32' ? 'wecom-cli.exe' : 'wecom-cli'
    return join(this.options.bundleDirectory, 'bin', name)
  }
  private get wheelsDirectory(): string { return join(this.options.bundleDirectory, 'wheels') }

  onChanged(listener: (snapshot: WecomSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async emit(): Promise<WecomSnapshot> {
    this.revision += 1
    const snapshot = await this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }

  /** Serializes state-changing operations so authorization and settings writes never interleave. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation)
    this.serial = next.catch(() => undefined)
    return next
  }

  async getSettings(): Promise<WecomToolSettings> {
    if (this.settings) return this.settings
    try {
      const parsed = wecomToolSettingsSchema.safeParse(JSON.parse(await readFile(this.settingsPath, 'utf8')))
      const defaults = defaultWecomToolSettings()
      // Categories added by later releases start from their defaults.
      this.settings = parsed.success
        ? { ...parsed.data, categories: { ...defaults.categories, ...parsed.data.categories } }
        : defaults
    } catch (error) {
      if (!isMissingFileError(error) && !(error instanceof SyntaxError)) throw error
      this.settings = defaultWecomToolSettings()
    }
    return this.settings
  }

  async getSnapshot(): Promise<WecomSnapshot> {
    const settings = await this.getSettings()
    if (this.cli.state === 'missing' && await this.isInstalled()) {
      this.cli = { state: 'ready', version: WECOM_CLI_VERSION }
    }
    if (this.cli.state === 'ready' && this.authorization.state === 'unknown') {
      await this.refreshAuthorization().catch(() => undefined)
    }
    return {
      revision: this.revision,
      platformSupported: this.cli.state === 'ready',
      cli: this.cli,
      authorization: this.authorization,
      qr: this.qr,
      settings
    }
  }

  /** Categories the model may use right now; empty when the application is off or unauthorized. */
  async getEnabledCategories(): Promise<WecomToolCategory[]> {
    const snapshot = await this.getSnapshot()
    if (!snapshot.settings.enabled || snapshot.authorization.state !== 'authorized') return []
    return wecomToolCategories.filter(category => snapshot.settings.categories[category])
  }

  updateSettings(input: WecomToolSettingsUpdate): Promise<WecomSnapshot> {
    return this.exclusive(async () => {
      const current = await this.getSettings()
      const next = wecomToolSettingsSchema.parse({
        enabled: input.enabled ?? current.enabled,
        categories: { ...current.categories, ...Object.fromEntries(
          Object.entries(input.categories ?? {}).filter(([, value]) => value !== undefined)
        ) },
        allowInMessageSessions: input.allowInMessageSessions ?? current.allowInMessageSessions
      })
      await writeJsonFileAtomically(this.settingsPath, next)
      this.settings = next
      return this.emit()
    })
  }

  private async isInstalled(): Promise<boolean> {
    return Boolean((await stat(this.binaryPath).catch(() => undefined))?.isFile())
  }

  /** Returns the bundled binary; GoodBuddy never downloads it at runtime. */
  async ensureInstalled(): Promise<string> {
    if (await this.isInstalled()) {
      if (this.cli.state !== 'ready') this.cli = { state: 'ready', version: WECOM_CLI_VERSION }
      return this.binaryPath
    }
    throw new Error('当前安装包不包含企业微信 CLI（不支持此操作系统或处理器架构，或安装包不完整）')
  }

  private processEnvironment(): NodeJS.ProcessEnv {
    const environment = buildCredentialFilteredUserEnvironment()
    // Never inherit a user-level token or config directory: GoodBuddy owns its credentials.
    for (const name of Object.keys(environment)) {
      if (name.toUpperCase().startsWith('WECOM_CLI_')) delete environment[name]
    }
    environment.WECOM_CLI_CONFIG_DIR = this.configDirectory
    return environment
  }

  /** Runs the CLI with bounded output. Arguments are never interpreted by a shell. */
  async run(args: readonly string[], options: RunOptions = {}): Promise<WecomCliResult> {
    const binary = await this.ensureInstalled()
    await mkdir(this.configDirectory, { recursive: true })
    const cwd = options.cwd ?? this.downloadsDirectory
    await mkdir(cwd, { recursive: true })
    return this.spawnBounded(binary, args, cwd, this.processEnvironment(), options)
  }

  private spawnBounded(
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options: RunOptions
  ): Promise<WecomCliResult> {
    options.signal?.throwIfAborted()
    return new Promise((resolvePromise, reject) => {
      const child = (this.options.spawnProcess ?? spawn)(command, [...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let size = 0
      let truncated = false
      const collect = (target: Buffer[]) => (chunk: Buffer): void => {
        if (size >= MAX_OUTPUT_BYTES) { truncated = true; return }
        const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - size)
        if (slice.length < chunk.length) truncated = true
        size += slice.length
        target.push(slice)
      }
      child.stdout?.on('data', collect(stdout))
      child.stderr?.on('data', collect(stderr))
      const kill = (): void => { child.kill() }
      const timer = setTimeout(kill, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
      options.signal?.addEventListener('abort', kill, { once: true })
      child.once('error', (error) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', kill)
        reject(error)
      })
      child.once('close', (exitCode) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', kill)
        if (options.signal?.aborted) {
          reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('企业微信命令已取消'))
          return
        }
        resolvePromise({
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          truncated
        })
      })
    })
  }

  private async refreshAuthorization(): Promise<WecomAuthorization> {
    const result = await this.run(['auth', 'show'], { timeoutMs: 15_000 })
    const text = result.stdout
    this.authorization = /Status:\s*authorized/u.test(text)
      ? { state: 'authorized', ...(/Bot ID:\s*(\S+)/u.exec(text)?.[1] ? { botId: /Bot ID:\s*(\S+)/u.exec(text)![1] } : {}) }
      : { state: 'unauthorized' }
    return this.authorization
  }

  /** Reads the CLI's error message from its structured JSON output. */
  private static failure(result: WecomCliResult, fallback: string): Error {
    for (const candidate of [result.stdout, result.stderr]) {
      try {
        const parsed = JSON.parse(candidate) as { error?: { message?: unknown }; errmsg?: unknown }
        const message = parsed.error?.message ?? parsed.errmsg
        if (typeof message === 'string' && message) return new Error(message.slice(0, 500))
      } catch {
        // Not JSON; fall through.
      }
    }
    return new Error(fallback)
  }

  authorizeManually(credentials: WecomManualCredentials): Promise<WecomSnapshot> {
    return this.exclusive(async () => {
      this.cancelQr()
      // Hidden non-interactive flags of `auth init`; they require a non-terminal stderr, which pipes provide.
      const result = await this.run(['auth', 'init', '--bot-id', credentials.botId, '--secret', credentials.secret], { timeoutMs: 60_000 })
      if (result.exitCode !== 0) {
        await this.refreshAuthorization().catch(() => undefined)
        void this.emit()
        throw WecomCliService.failure(result, '企业微信机器人凭据验证失败')
      }
      await this.refreshAuthorization()
      return this.emit()
    })
  }

  async authorizeWithChannelBot(): Promise<WecomSnapshot> {
    const credentials = await this.options.resolveChannelCredentials?.()
    if (!credentials) throw new Error('企业微信消息通道尚未保存机器人 ID 和 Secret')
    return this.authorizeManually(credentials)
  }

  startQrAuthorization(): Promise<WecomSnapshot> {
    return this.exclusive(async () => {
      this.cancelQr()
      this.qr = { state: 'starting' }
      void this.emit()
      try {
        const binary = await this.ensureInstalled()
        await mkdir(this.configDirectory, { recursive: true })
        await mkdir(this.downloadsDirectory, { recursive: true })
        const child = (this.options.spawnProcess ?? spawn)(binary, ['auth', 'init', '--noninteractive', '--no-browser'], {
          cwd: this.downloadsDirectory,
          env: this.processEnvironment(),
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        this.qrProcess = child
        let output = ''
        const expiresAt = new Date(Date.now() + QR_TIMEOUT_MS).toISOString()
        const timer = setTimeout(() => child.kill(), QR_TIMEOUT_MS)
        child.stdout?.on('data', (chunk: Buffer) => {
          if (output.length > MAX_OUTPUT_BYTES) return
          output += chunk.toString('utf8')
          const url = /https:\/\/work\.weixin\.qq\.com\/\S+/u.exec(output)?.[0]
          if (url && this.qrProcess === child && this.qr.state !== 'waiting') {
            this.qr = { state: 'waiting', url, expiresAt }
            void this.emit()
          }
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          if (output.length <= MAX_OUTPUT_BYTES) output += chunk.toString('utf8')
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          if (this.qrProcess !== child) return
          this.qrProcess = undefined
          this.qr = { state: 'failed', message: error.message }
          void this.emit()
        })
        child.once('close', (exitCode) => {
          clearTimeout(timer)
          if (this.qrProcess !== child) return
          this.qrProcess = undefined
          void (async () => {
            if (exitCode === 0) {
              this.qr = { state: 'idle' }
              await this.refreshAuthorization().catch(() => undefined)
            } else {
              const failure = WecomCliService.failure({ exitCode, stdout: output.slice(output.indexOf('{')), stderr: '', truncated: false },
                '扫码未完成或二维码已过期，请重新扫码')
              this.qr = { state: 'failed', message: failure.message }
            }
            await this.emit()
          })()
        })
      } catch (error) {
        this.qr = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
      return this.emit()
    })
  }

  private cancelQr(): void {
    const child = this.qrProcess
    this.qrProcess = undefined
    child?.kill()
    this.qr = { state: 'idle' }
  }

  async cancelQrAuthorization(): Promise<WecomSnapshot> {
    this.cancelQr()
    return this.emit()
  }

  /** Deletes the isolated credentials. User-level wecom-cli configuration is untouched. */
  disconnect(): Promise<WecomSnapshot> {
    return this.exclusive(async () => {
      this.cancelQr()
      await rm(this.configDirectory, { recursive: true, force: true })
      this.authorization = { state: 'unauthorized' }
      return this.emit()
    })
  }

  /** Searches documents the authorized person may access; used by the workbar panel. */
  async searchDocuments(query: string, signal?: AbortSignal): Promise<WecomDocument[]> {
    const result = await this.run(['doc', 'search', '--json', JSON.stringify({
      keywords: [query], search_scope: 'title_content', sort_by: 'best_match', limit: 30
    })], { signal, timeoutMs: 30_000 })
    if (result.exitCode !== 0) throw WecomCliService.failure(result, '企业微信文档搜索失败')
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw new Error('企业微信文档搜索返回了无法识别的结果')
    }
    const payload = parsed as { docs?: unknown; errcode?: unknown; errmsg?: unknown }
    if (typeof payload.errcode === 'number' && payload.errcode !== 0) {
      throw new Error(typeof payload.errmsg === 'string' ? payload.errmsg.slice(0, 500) : '企业微信文档搜索失败')
    }
    const docs = Array.isArray(payload.docs) ? payload.docs : []
    return docs.flatMap((item): WecomDocument[] => {
      if (!item || typeof item !== 'object') return []
      const doc = item as Record<string, unknown>
      if (typeof doc.docid !== 'string' || typeof doc.doc_name !== 'string') return []
      return [{
        id: doc.docid,
        name: doc.doc_name.slice(0, 300),
        type: typeof doc.doc_type === 'string' ? doc.doc_type : 'doc',
        ...(typeof doc.url === 'string' && doc.url.startsWith('https://') ? { url: doc.url } : {}),
        ...(typeof doc.modify_time === 'string' ? { modifiedAt: doc.modify_time } : {})
      }]
    })
  }

  /**
   * Runs one model-requested command after checking it against the enabled
   * categories. Authorization and cache commands are never available to models.
   */
  async runModelCommand(
    args: readonly string[],
    categories: readonly WecomToolCategory[],
    options: RunOptions = {}
  ): Promise<WecomCliResult & { category: string }> {
    const first = args[0]
    if (!first || first.startsWith('-')) throw new Error('请以服务名开头，例如 ["doc", "search", "--json", "{...}"]，不要包含 wecom-cli')
    if (first === 'wecom-cli') throw new Error('参数不要包含 wecom-cli 本身，直接从服务名开始')
    if (['auth', 'cache', 'schema', 'help'].includes(first)) throw new Error(`GoodBuddy 不允许模型执行 ${first} 命令`)
    const category = wecomCommandCategory(args, new Set(categories))
    if (!category) throw new Error(`命令 ${args.slice(0, 3).join(' ')} 不属于已开启的企业微信工具类别；请让用户在 应用 › 企业微信 › 应用设置 中开启对应类别`)
    const result = await this.run(args, options)
    return { ...result, category }
  }

  private pythonInstallation?: Promise<string>

  /** Creates a GoodBuddy-owned venv with the packages the official scripts import. */
  private ensurePythonEnvironment(signal?: AbortSignal): Promise<string> {
    const windows = (this.options.platform ?? process.platform) === 'win32'
    const venvPython = join(this.pythonDirectory, 'venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python')
    const marker = join(this.pythonDirectory, 'requirements.json')
    const expected = JSON.stringify(wecomScriptPythonPackages)
    this.pythonInstallation ??= (async () => {
      const installed = await readFile(marker, 'utf8').catch(() => '')
      if (installed === expected && (await stat(venvPython).catch(() => undefined))?.isFile()) return venvPython
      const python = await this.options.resolvePython?.()
      if (!python) throw new Error('企业微信文档和 PPT 脚本需要 Python 3：请在 设置 › 运行环境 › 本机工具环境 中安装托管 Python，或指定已有的 Python')
      const version = await this.spawnBounded(python, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
        this.options.rootDirectory, scriptEnvironment(), { signal, timeoutMs: 15_000 }).catch(() => undefined)
      if (version?.stdout.trim() !== wecomScriptPythonVersion) {
        throw new Error(`企业微信文档和 PPT 脚本需要 Python ${wecomScriptPythonVersion}（内置依赖按该版本打包），当前为 ${version?.stdout.trim() || '未知'}：请在本机工具环境中使用托管 Python`)
      }
      await rm(this.pythonDirectory, { recursive: true, force: true })
      await mkdir(this.pythonDirectory, { recursive: true })
      const env = scriptEnvironment()
      const venv = await this.spawnBounded(python, ['-m', 'venv', join(this.pythonDirectory, 'venv')], this.pythonDirectory, env, { signal, timeoutMs: 120_000 })
      if (venv.exitCode !== 0) throw new Error(`创建 Python 虚拟环境失败：${(venv.stderr || venv.stdout).slice(-500)}`)
      // Offline: only the wheels bundled with GoodBuddy, never a package index.
      const pip = await this.spawnBounded(venvPython, [
        '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-index',
        '--find-links', this.wheelsDirectory, '--only-binary=:all:', ...wecomScriptPythonPackages
      ], this.pythonDirectory, env, { signal, timeoutMs: 600_000 })
      if (pip.exitCode !== 0) throw new Error(`安装 Python 依赖失败：${(pip.stderr || pip.stdout).slice(-800)}`)
      await writeFile(marker, expected, 'utf8')
      return venvPython
    })().finally(() => { this.pythonInstallation = undefined })
    return this.pythonInstallation
  }

  /**
   * Runs a Python script bundled with an enabled skill in the downloads folder.
   * Input files are confined to that folder; wecom-cli on PATH uses the
   * GoodBuddy credentials.
   */
  async runSkillScript(
    input: { skill: string; script: string; args: readonly string[]; files: readonly { path: string; content: string }[] },
    categories: readonly WecomToolCategory[],
    options: RunOptions = {}
  ): Promise<WecomCliResult & { workDirectory: string }> {
    const allowed = new Set(categories.flatMap(category => wecomScriptCategories[category] ? [wecomScriptCategories[category]] : []))
    if (!allowed.has(input.skill)) throw new Error(`${input.skill} 的脚本所属类别未开启`)
    const scriptsRoot = resolve(this.options.skillsDirectory, input.skill, 'scripts')
    const scriptPath = resolve(scriptsRoot, input.script)
    if (relative(scriptsRoot, scriptPath).includes('..') || !(await stat(scriptPath).catch(() => undefined))?.isFile()) {
      throw new Error(`未找到脚本 ${input.skill}/scripts/${input.script}`)
    }
    const work = this.downloadsDirectory
    await mkdir(work, { recursive: true })
    for (const file of input.files) {
      const target = resolve(work, file.path)
      const relation = relative(work, target)
      if (!relation || relation.startsWith('..') || resolve(work, relation) !== target) throw new Error(`文件路径必须位于工作目录内：${file.path}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content, 'utf8')
    }
    const binary = await this.ensureInstalled()
    const python = await this.ensurePythonEnvironment(options.signal)
    const env = { ...this.processEnvironment(), ...scriptEnvironment() }
    // Scripts call `wecom-cli`; put the pinned binary first on PATH.
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
    env[pathKey] = [dirname(binary), env[pathKey]].filter(Boolean).join(delimiter)
    const result = await this.spawnBounded(python, [scriptPath, ...input.args], work, env, { signal: options.signal, timeoutMs: options.timeoutMs ?? 300_000 })
    return { ...result, workDirectory: work }
  }

  /** Returns official Skill guidance for the given skill, limited to enabled categories. */
  async readGuide(
    skill: string,
    categories: readonly WecomToolCategory[],
    file = 'SKILL.md',
    offset = 0
  ): Promise<{ skill: string; file: string; content: string; offset: number; nextOffset?: number; files?: string[] }> {
    const allowed = new Set([wecomSharedSkill, ...categories.map(category => wecomCategorySkill[category])])
    if (!allowed.has(skill)) throw new Error(`${skill} 未开启或不存在；可用：${[...allowed].join(', ')}`)
    const skillRoot = resolve(this.options.skillsDirectory, skill)
    const target = resolve(skillRoot, normalize(file))
    const relation = relative(skillRoot, target)
    if (!relation || relation.startsWith('..') || relation.includes(`..${sep}`) || !target.endsWith('.md')) {
      throw new Error('只能读取该技能目录内的 .md 文件')
    }
    const text = await readFile(target, 'utf8').catch((error: unknown) => {
      if (isMissingFileError(error)) throw new Error(`未找到 ${skill}/${file}`)
      throw error
    })
    const start = Math.max(0, Math.min(offset, text.length))
    const end = Math.min(text.length, start + MAX_GUIDE_CHARACTERS)
    const files = file === 'SKILL.md' && start === 0 ? await this.listGuideFiles(skillRoot) : undefined
    return {
      skill,
      file: relation.split(sep).join('/'),
      content: text.slice(start, end),
      offset: start,
      ...(end < text.length ? { nextOffset: end } : {}),
      ...(files?.length ? { files } : {})
    }
  }

  private async listGuideFiles(root: string): Promise<string[]> {
    const result: string[] = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.name.endsWith('.md') && entry.name !== 'SKILL.md') result.push(relative(root, path).split(sep).join('/'))
        if (result.length >= 200) return
      }
    }
    await walk(root)
    return result.sort()
  }

  dispose(): void {
    this.cancelQr()
  }
}
