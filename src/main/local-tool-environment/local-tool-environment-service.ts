import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import spawn from 'cross-spawn'
import type { ApplicationSettingsStore } from '../application-settings-store'
import {
  localToolEnvironmentSettingsSchema,
  type ArtifactDownloadSource,
  type LocalToolDiagnoseTarget,
  type LocalToolEnvironmentProgress,
  type LocalToolEnvironmentSettings,
  type LocalToolEnvironmentSnapshot,
  type LocalToolKind,
  type LocalToolPythonOperation
} from '../../shared/local-tool-environment-contracts'
import {
  createLocalToolEnvironment,
  inspectLocalToolExecutable,
  type LocalToolEnvironment,
  type LocalToolEnvironmentDependencies
} from './local-tool-environment'
import {
  cleanupManagedPythonOperations,
  installManagedPython,
  removeManagedPython
} from './managed-python-install'
import {
  loadPythonArtifactCatalog,
  selectPythonArtifact,
  type PythonArtifactArch,
  type PythonArtifactPlatform
} from './python-artifact-catalog'
import { downloadPythonArtifact } from './python-artifact-download'
import { extractPythonArtifact } from './python-artifact-extract'
import type { LaunchEnvironmentProvider } from './launch-environment-provider'
import {
  terminateProcessTreeAndWait,
  type WaitableProcessTreeChild
} from '../agent/child-process-termination'

const candidateLimit = 40
const pathDirectoryLimit = 64
const discoveredDirectoryLimit = 24
const validationOutputLimit = 8 * 1024
const validationTimeoutMs = 15_000
const validationTerminationWaitMs = 500

export type LocalToolEnvironmentServiceOptions = {
  settingsStore: ApplicationSettingsStore
  binDirectory: string
  managedPythonRoot: string
  pythonArtifactCatalogPath: string
  packagedNpmCliPath: string
  packagedNpxCliPath: string
  selectExecutable: (
    kind: LocalToolKind
  ) => Promise<string | undefined>
  electronExecutablePath?: string
  baseEnvironment?: NodeJS.ProcessEnv
  platform?: PythonArtifactPlatform
  arch?: PythonArtifactArch
}

export type LocalToolEnvironmentServiceDependencies = {
  toolEnvironment?: LocalToolEnvironmentDependencies
  transport?: typeof fetch
}

type ProgressListener = (progress: LocalToolEnvironmentProgress) => void

function pythonExecutable(
  directory: string,
  platform: PythonArtifactPlatform
): string {
  return join(directory, 'python', platform === 'win32' ? 'python.exe' : 'bin/python3')
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path)
    return (await stat(canonical)).isFile() ? canonical : undefined
  } catch {
    return undefined
  }
}

async function childDirectories(
  root: string | undefined,
  suffix: readonly string[] = []
): Promise<string[]> {
  if (!root) return []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, discoveredDirectoryLimit)
      .map((entry) => join(root, entry.name, ...suffix))
  } catch {
    return []
  }
}

async function candidateDirectories(
  environment: NodeJS.ProcessEnv,
  platform: PythonArtifactPlatform
): Promise<string[]> {
  const directories: string[] = []
  const seen = new Set<string>()
  const add = (value: string | undefined): void => {
    const path = value?.trim()
    if (!path) return
    const key = platform === 'win32' ? path.toLowerCase() : path
    if (!seen.has(key) && directories.length < pathDirectoryLimit) {
      seen.add(key)
      directories.push(path)
    }
  }
  const addMany = (values: readonly string[]): void => values.forEach(add)
  const executableDirectory = (prefix: string | undefined): string | undefined =>
    prefix
      ? platform === 'win32'
        ? prefix
        : join(prefix, 'bin')
      : undefined

  const inheritedPath =
    environment.PATH ?? environment.Path ?? environment.path ?? ''
  add(executableDirectory(environment.VIRTUAL_ENV))
  add(executableDirectory(environment.CONDA_PREFIX))
  add(executableDirectory(environment.NVM_HOME))
  add(environment.NVM_BIN)
  add(environment.VOLTA_HOME ? join(environment.VOLTA_HOME, 'bin') : undefined)

  const home = environment.USERPROFILE ?? environment.HOME
  const localAppData = environment.LOCALAPPDATA
  const programFiles = environment.ProgramFiles
  const programData = environment.ProgramData

  if (platform === 'win32') {
    add(programFiles ? join(programFiles, 'nodejs') : undefined)
    add(localAppData ? join(localAppData, 'Programs', 'nodejs') : undefined)
    for (const version of ['314', '313', '312', '311', '310']) {
      add(environment.SystemDrive ? join(environment.SystemDrive, `Python${version}`) : undefined)
      add(programFiles ? join(programFiles, `Python${version}`) : undefined)
    }
    addMany(
      await childDirectories(
        localAppData ? join(localAppData, 'Programs', 'Python') : undefined
      )
    )
    for (const root of [
      home ? join(home, '.conda', 'envs') : undefined,
      home ? join(home, 'miniconda3', 'envs') : undefined,
      home ? join(home, 'anaconda3', 'envs') : undefined,
      programData ? join(programData, 'miniconda3', 'envs') : undefined,
      programData ? join(programData, 'anaconda3', 'envs') : undefined,
      ...((environment.CONDA_ENVS_PATH ?? '')
        .split(delimiter)
        .filter(Boolean))
    ]) {
      addMany(await childDirectories(root))
    }
    add(home ? join(home, 'miniconda3') : undefined)
    add(home ? join(home, 'anaconda3') : undefined)
    add(programData ? join(programData, 'miniconda3') : undefined)
    add(programData ? join(programData, 'anaconda3') : undefined)
  } else {
    add('/usr/local/bin')
    add('/usr/bin')
    if (platform === 'darwin') {
      add('/opt/homebrew/bin')
      addMany(
        await childDirectories(
          '/Library/Frameworks/Python.framework/Versions',
          ['bin']
        )
      )
    }
    add(home ? join(home, '.local', 'bin') : undefined)
    for (const root of [
      home ? join(home, '.conda', 'envs') : undefined,
      home ? join(home, 'miniconda3', 'envs') : undefined,
      home ? join(home, 'anaconda3', 'envs') : undefined,
      ...((environment.CONDA_ENVS_PATH ?? '')
        .split(delimiter)
        .filter(Boolean))
    ]) {
      addMany(
        (await childDirectories(root)).map((directory) =>
          join(directory, 'bin')
        )
      )
    }
    add(home ? join(home, 'miniconda3', 'bin') : undefined)
    add(home ? join(home, 'anaconda3', 'bin') : undefined)
    for (const root of [
      environment.PYENV_ROOT
        ? join(environment.PYENV_ROOT, 'versions')
        : home
          ? join(home, '.pyenv', 'versions')
          : undefined,
      home ? join(home, '.nvm', 'versions', 'node') : undefined
    ]) {
      addMany(await childDirectories(root, ['bin']))
    }
  }
  inheritedPath.split(delimiter).forEach(add)
  return directories
}

async function discoverCandidates(
  environment: NodeJS.ProcessEnv,
  platform: PythonArtifactPlatform,
  savedSettings: LocalToolEnvironmentSettings,
  dependencies: LocalToolEnvironmentDependencies
): Promise<LocalToolEnvironmentSnapshot['candidates']> {
  const directories = await candidateDirectories(environment, platform)
  const names: Readonly<Record<LocalToolKind, readonly string[]>> =
    platform === 'win32'
      ? { node: ['node.exe'], python: ['python.exe', 'python3.exe'] }
      : { node: ['node'], python: ['python3', 'python'] }
  const paths: Array<{ kind: LocalToolKind; executablePath: string }> = []
  for (const kind of ['node', 'python'] as const) {
    const selection = savedSettings[kind]
    if (selection.source === 'custom') {
      paths.push({ kind, executablePath: selection.executablePath })
    }
  }
  const seen = new Set<string>()
  for (const directory of directories) {
    for (const kind of ['node', 'python'] as const) {
      for (const name of names[kind]) {
        if (paths.length >= candidateLimit) {
          break
        }
        const path = await existingFile(join(directory, name))
        const key = path
          ? `${kind}:${platform === 'win32' ? path.toLowerCase() : path}`
          : undefined
        if (path && key && !seen.has(key)) {
          seen.add(key)
          paths.push({ kind, executablePath: path })
        }
      }
    }
  }
  const inspected = await Promise.all(
    paths.slice(0, candidateLimit).map(({ kind, executablePath }) =>
      inspectLocalToolExecutable(
        kind,
        executablePath,
        { baseEnvironment: environment },
        dependencies
      )
    )
  )
  const candidates: LocalToolEnvironmentSnapshot['candidates'] = []
  const canonicalSeen = new Set<string>()
  for (const candidate of inspected) {
    if (!candidate) continue
    const key = `${candidate.kind}:${
      platform === 'win32'
        ? candidate.executablePath.toLowerCase()
        : candidate.executablePath
    }`
    if (!canonicalSeen.has(key)) {
      canonicalSeen.add(key)
      candidates.push(candidate)
    }
  }
  return candidates
}

type ValidationProcess = WaitableProcessTreeChild & {
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
}

function runValidationCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
  platform: PythonArtifactPlatform,
  dependencies: LocalToolEnvironmentDependencies
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    let child: ValidationProcess
    try {
      child = (dependencies.spawnProcess ?? spawn)(command, args, {
        detached: platform !== 'win32',
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      reject(error)
      return
    }

    let output = ''
    let outputBytes = 0
    let settled = false
    let terminating = false
    const finish = (error?: unknown): void => {
      if (settled || terminating) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(output)
    }
    const terminate = (error: unknown): void => {
      if (settled || terminating) return
      terminating = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      void (
        dependencies.terminateProcessTree ?? terminateProcessTreeAndWait
      )(child, {
        platform,
        processGroup: platform !== 'win32',
        signal: 'SIGKILL',
        waitMs: validationTerminationWaitMs
      }).then(
        () => {
          settled = true
          reject(error)
        },
        () => {
          settled = true
          reject(error)
        }
      )
    }
    const onAbort = (): void =>
      terminate(
        signal.reason ??
          new DOMException('Managed Python operation cancelled', 'AbortError')
      )
    const timeout = setTimeout(
      () => terminate(new Error('Managed Python validation timed out')),
      validationTimeoutMs
    )
    signal.addEventListener('abort', onAbort, { once: true })
    const collect = (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += value.byteLength
      if (outputBytes > validationOutputLimit) {
        terminate(new Error('Managed Python validation output exceeded its limit'))
        return
      }
      output += value.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', (error: unknown) => finish(error))
    child.once('close', (code: unknown) => {
      if (!terminating) {
        finish(
          code === 0
            ? undefined
            : new Error(`Managed Python validation exited with code ${String(code)}`)
        )
      }
    })
  })
}

export async function validateManagedPython(
  executablePath: string,
  stagingDirectory: string,
  version: string,
  arch: PythonArtifactArch,
  signal: AbortSignal,
  platform: PythonArtifactPlatform,
  dependencies: LocalToolEnvironmentDependencies = {}
): Promise<void> {
  const validationVenv = join(stagingDirectory, '.validation-venv')
  try {
    const pipOutput = await runValidationCommand(
      executablePath,
      ['-m', 'pip', '--version'],
      signal,
      platform,
      dependencies
    )
    if (!/\bpip\s+\d/u.test(pipOutput)) {
      throw new Error('Managed Python pip is invalid')
    }
    await runValidationCommand(
      executablePath,
      ['-m', 'venv', '--without-pip', validationVenv],
      signal,
      platform,
      dependencies
    )
    const venvPython =
      platform === 'win32'
        ? join(validationVenv, 'Scripts', 'python.exe')
        : join(validationVenv, 'bin', 'python3')
    const script = [
      'import json, platform, ssl, sysconfig',
      'print(json.dumps({"version": platform.python_version(), "architecture": platform.machine(), "ssl": ssl.OPENSSL_VERSION, "stdlib": sysconfig.get_path("stdlib")}))'
    ].join(';')
    const output = await runValidationCommand(
      venvPython,
      ['-I', '-c', script],
      signal,
      platform,
      dependencies
    )
    const result = JSON.parse(output.trim()) as {
      version?: unknown
      architecture?: unknown
      ssl?: unknown
      stdlib?: unknown
    }
    const expectedMachines =
      arch === 'x64' ? ['x86_64', 'amd64', 'x64'] : ['aarch64', 'arm64']
    if (
      result.version !== version ||
      typeof result.architecture !== 'string' ||
      !expectedMachines.includes(result.architecture.toLocaleLowerCase()) ||
      typeof result.ssl !== 'string' ||
      result.ssl.length === 0 ||
      typeof result.stdlib !== 'string' ||
      result.stdlib.length === 0
    ) {
      throw new Error('Managed Python runtime validation failed')
    }
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason ?? error
    }
    throw error
  } finally {
    await rm(validationVenv, { recursive: true, force: true }).catch(() => undefined)
  }
}

export class LocalToolEnvironmentService {
  private readonly platform: PythonArtifactPlatform
  private readonly arch: PythonArtifactArch
  private candidates: LocalToolEnvironmentSnapshot['candidates'] = []
  private diagnostics: LocalToolEnvironmentSnapshot['diagnostics'] = {}
  private operation?: LocalToolPythonOperation
  private operationController?: AbortController
  private installOperation?: Promise<LocalToolEnvironmentSnapshot>
  private launchEnvironment: Readonly<NodeJS.ProcessEnv> = Object.freeze({})
  private listeners = new Set<ProgressListener>()
  readonly launchEnvironmentProvider: LaunchEnvironmentProvider = () =>
    this.launchEnvironment

  constructor(
    private readonly options: LocalToolEnvironmentServiceOptions,
    private readonly dependencies: LocalToolEnvironmentServiceDependencies = {}
  ) {
    this.platform = options.platform ?? (process.platform as PythonArtifactPlatform)
    this.arch = options.arch ?? (process.arch as PythonArtifactArch)
    if (!['win32', 'darwin', 'linux'].includes(this.platform)) {
      throw new Error(`Managed Python is unsupported on ${this.platform}`)
    }
    if (!['x64', 'arm64'].includes(this.arch)) {
      throw new Error(`Managed Python is unsupported on ${this.arch}`)
    }
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private managedDirectory(version: string): string {
    return join(this.options.managedPythonRoot, `python-${version}`)
  }

  private async installedPython(version: string): Promise<string | undefined> {
    return existingFile(pythonExecutable(this.managedDirectory(version), this.platform))
  }

  private async settings(): Promise<LocalToolEnvironmentSettings> {
    return (await this.options.settingsStore.get()).localToolEnvironment
  }

  private async rebuildLaunchEnvironment(
    signal?: AbortSignal
  ): Promise<LocalToolEnvironment> {
    const settings = await this.settings()
    const catalog = await loadPythonArtifactCatalog(
      this.options.pythonArtifactCatalogPath
    )
    const generationDirectory = join(
      this.options.binDirectory,
      `generation-${randomUUID()}`
    )
    try {
      const environment = await createLocalToolEnvironment(
        {
          binDirectory: generationDirectory,
          nodeSelection: settings.node,
          pythonSelection: settings.python,
          packagedNpmCliPath: this.options.packagedNpmCliPath,
          packagedNpxCliPath: this.options.packagedNpxCliPath,
          managedPythonExecutablePath: await this.installedPython(
            catalog.pythonVersion
          ),
          baseEnvironment: this.options.baseEnvironment,
          ...(signal ? { signal } : {})
        },
        {
          ...this.dependencies.toolEnvironment,
          ...(this.options.electronExecutablePath
            ? { electronExecutablePath: this.options.electronExecutablePath }
            : {})
        }
      )
      this.launchEnvironment = Object.freeze({ ...environment.environment })
      return environment
    } catch (error) {
      await rm(generationDirectory, {
        recursive: true,
        force: true
      }).catch(() => undefined)
      throw error
    }
  }

  async initialize(): Promise<void> {
    await rm(this.options.binDirectory, {
      recursive: true,
      force: true
    })
    await this.rebuildLaunchEnvironment()
  }

  async getSnapshot(): Promise<LocalToolEnvironmentSnapshot> {
    const catalog = await loadPythonArtifactCatalog(
      this.options.pythonArtifactCatalogPath
    )
    const executablePath = await this.installedPython(catalog.pythonVersion)
    return {
      settings: await this.settings(),
      candidates: [...this.candidates],
      diagnostics: { ...this.diagnostics },
      managedPython: {
        version: catalog.pythonVersion,
        installed: executablePath !== undefined,
        ...(executablePath ? { executablePath } : {}),
        ...(this.operation ? { operation: { ...this.operation } } : {})
      }
    }
  }

  private async emit(): Promise<void> {
    const progress = { snapshot: await this.getSnapshot() }
    for (const listener of this.listeners) listener(progress)
  }

  async updateSettings(input: unknown): Promise<LocalToolEnvironmentSnapshot> {
    let settings = localToolEnvironmentSettingsSchema.parse(input)
    const current = await this.settings()
    for (const kind of ['node', 'python'] as const) {
      const proposed = settings[kind]
      const persisted = current[kind]
      if (
        proposed.source === 'custom' &&
        (persisted.source !== 'custom' ||
          persisted.executablePath !== proposed.executablePath)
      ) {
        const candidate = await inspectLocalToolExecutable(
          kind,
          proposed.executablePath,
          {
            baseEnvironment: this.options.baseEnvironment ?? process.env
          },
          this.dependencies.toolEnvironment
        )
        if (!candidate) {
          throw new Error(`Selected ${kind} executable is invalid`)
        }
        settings = {
          ...settings,
          [kind]: {
            source: 'custom',
            executablePath: candidate.executablePath
          }
        }
      }
    }
    await this.options.settingsStore.update({
      localToolEnvironment: settings
    })
    this.diagnostics = {}
    try {
      await this.rebuildLaunchEnvironment()
    } catch (error) {
      await this.options.settingsStore.update({
        localToolEnvironment: current
      })
      await this.rebuildLaunchEnvironment().catch(() => undefined)
      throw error
    }
    return this.getSnapshot()
  }

  async refreshCandidates(): Promise<LocalToolEnvironmentSnapshot> {
    this.candidates = await discoverCandidates(
      this.options.baseEnvironment ?? process.env,
      this.platform,
      await this.settings(),
      this.dependencies.toolEnvironment ?? {}
    )
    return this.getSnapshot()
  }

  async selectExecutable(kind: LocalToolKind): Promise<LocalToolEnvironmentSnapshot> {
    const executablePath = await this.options.selectExecutable(kind)
    if (!executablePath) return this.getSnapshot()
    const current = await this.settings()
    return this.updateSettings({
      ...current,
      [kind]: { source: 'custom', executablePath }
    })
  }

  async diagnose(target: LocalToolDiagnoseTarget): Promise<LocalToolEnvironmentSnapshot> {
    const environment = await this.rebuildLaunchEnvironment(
      this.operationController?.signal
    )
    const resolved = Object.fromEntries(
      Object.entries(environment.diagnostics.tools).map(([name, diagnostic]) => [
        name,
        {
          available: diagnostic.available,
          source: diagnostic.source,
          ...(diagnostic.version ? { version: diagnostic.version } : {}),
          ...(diagnostic.executablePath
            ? { executablePath: diagnostic.executablePath }
            : {}),
          detail: diagnostic.detail
        }
      ])
    )
    const names =
      target === 'node'
        ? ['node', 'npm', 'npx']
        : target === 'python'
          ? ['python', 'python3', 'pip']
          : ['node', 'npm', 'npx', 'python', 'python3', 'pip']
    this.diagnostics = {
      ...this.diagnostics,
      ...Object.fromEntries(names.map((name) => [name, resolved[name]]))
    }
    return this.getSnapshot()
  }

  private async setOperation(operation: LocalToolPythonOperation): Promise<void> {
    this.operation = operation
    await this.emit()
  }

  installPython(): Promise<LocalToolEnvironmentSnapshot> {
    if (this.operationController) throw new Error('A Managed Python operation is already running')
    const operation = this.runPythonInstall()
    this.installOperation = operation
    void operation.finally(() => {
      if (this.installOperation === operation) {
        this.installOperation = undefined
      }
    }).catch(() => undefined)
    return operation
  }

  private async runPythonInstall(): Promise<LocalToolEnvironmentSnapshot> {
    const controller = new AbortController()
    this.operationController = controller
    let archivePath: string | undefined
    try {
      const settings = await this.settings()
      const source: ArtifactDownloadSource = settings.artifactDownloadSource
      const catalog = await loadPythonArtifactCatalog(this.options.pythonArtifactCatalogPath)
      const artifact = selectPythonArtifact({
        catalog,
        platform: this.platform,
        arch: this.arch,
        source
      })
      await mkdir(this.options.managedPythonRoot, { recursive: true })
      await cleanupManagedPythonOperations(this.options.managedPythonRoot)
      archivePath = join(
        this.options.managedPythonRoot,
        `.managed-python-download-${randomUUID()}`
      )
      await this.setOperation({
        source,
        phase: 'downloading',
        receivedBytes: 0,
        totalBytes: artifact.size
      })
      await downloadPythonArtifact({
        artifact,
        destinationPath: archivePath,
        transport: this.dependencies.transport,
        signal: controller.signal,
        onProgress: (receivedBytes, totalBytes) => {
          this.operation = {
            source,
            phase: 'downloading',
            receivedBytes,
            totalBytes
          }
          void this.emit().catch(() => undefined)
        }
      })
      const downloadedArchive = archivePath
      const destination = await installManagedPython({
        rootDirectory: this.options.managedPythonRoot,
        version: catalog.pythonVersion,
        signal: controller.signal,
        stage: async (stagingDirectory) => {
          await this.setOperation({ source, phase: 'extracting' })
          await extractPythonArtifact({
            artifact,
            archivePath: downloadedArchive,
            destinationDirectory: join(stagingDirectory, 'python'),
            signal: controller.signal
          })
        },
        validate: async (stagingDirectory) => {
          await this.setOperation({ source, phase: 'validating' })
          await validateManagedPython(
            pythonExecutable(stagingDirectory, this.platform),
            stagingDirectory,
            catalog.pythonVersion,
            this.arch,
            controller.signal,
            this.platform,
            this.dependencies.toolEnvironment
          )
          await this.setOperation({ source, phase: 'publishing' })
        }
      })
      if (!(await existingFile(pythonExecutable(destination, this.platform)))) {
        throw new Error('Managed Python publish did not produce an executable')
      }
    } finally {
      if (archivePath) await rm(archivePath, { force: true }).catch(() => undefined)
      this.operation = undefined
      this.operationController = undefined
      await this.emit()
    }
    return this.diagnose('python')
  }

  cancelPython(): boolean {
    if (!this.operationController) return false
    this.operationController.abort(
      new DOMException('Managed Python operation cancelled', 'AbortError')
    )
    return true
  }

  async removePython(): Promise<LocalToolEnvironmentSnapshot> {
    if (this.operationController) throw new Error('A Managed Python operation is running')
    const catalog = await loadPythonArtifactCatalog(this.options.pythonArtifactCatalogPath)
    await removeManagedPython({
      rootDirectory: this.options.managedPythonRoot,
      version: catalog.pythonVersion
    })
    this.diagnostics = {}
    await this.rebuildLaunchEnvironment()
    await this.emit()
    return this.getSnapshot()
  }

  async dispose(): Promise<void> {
    this.cancelPython()
    await this.installOperation?.catch(() => undefined)
    await rm(this.options.binDirectory, {
      recursive: true,
      force: true
    })
  }
}
