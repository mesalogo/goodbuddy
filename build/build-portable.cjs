const { spawnSync } = require('node:child_process')
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { dirname, join, parse, resolve } = require('node:path')
const {
  supportedArchitectures,
  targetName,
  verifyLockedBundle
} = require('./agent-bundle.cjs')

const root = join(__dirname, '..')
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
)
const outputRoot = join(root, 'dist')
const stagingRoot = join(
  outputRoot,
  `.portable-stage-x64-${process.pid}`
)
const unpackedPath = join(stagingRoot, 'win-unpacked')
const portableName = 'GoodBuddy-windows-x64'
const portablePath = process.env.GOODBUDDY_OUT_DIR
  ? resolve(process.env.GOODBUDDY_OUT_DIR)
  : join(outputRoot, portableName)
const markerName = '.goodbuddy-portable.json'
const portableLocales = new Set(['zh-CN.pak', 'en-US.pak'])

function assertOutputUnlocked(directory) {
  if (!existsSync(directory)) {
    return
  }
  const probe = `${directory}.build-lock-check-${process.pid}`
  try {
    renameSync(directory, probe)
    renameSync(probe, directory)
  } catch (error) {
    if (!existsSync(directory) && existsSync(probe)) {
      try {
        renameSync(probe, directory)
      } catch {
        // The original lock error is more useful.
      }
    }
    if (
      error?.code === 'EPERM' ||
      error?.code === 'EBUSY' ||
      error?.code === 'EACCES'
    ) {
      throw new Error(
        `无法更新 ${directory}，请先关闭其中正在运行的 GoodBuddy.exe`,
        { cause: error }
      )
    }
    throw error
  }
}

function ensureElectronRuntime() {
  const electronRoot = join(root, 'node_modules', 'electron')
  const electronDist = join(electronRoot, 'dist')
  const executable = join(electronDist, 'electron.exe')
  const versionFile = join(electronDist, 'version')
  const installedPackagePath = join(electronRoot, 'package.json')
  const lock = JSON.parse(
    readFileSync(join(root, 'package-lock.json'), 'utf8')
  )
  const lockedVersion =
    lock.packages?.['node_modules/electron']?.version
  if (
    !existsSync(installedPackagePath) ||
    !existsSync(executable) ||
    !existsSync(versionFile)
  ) {
    throw new Error('缺少本地 Electron 运行时，请先运行 npm ci')
  }
  const installedVersion = JSON.parse(
    readFileSync(installedPackagePath, 'utf8')
  ).version
  const runtimeVersion = readFileSync(versionFile, 'utf8')
    .trim()
    .replace(/^v/u, '')
  if (
    !lockedVersion ||
    installedVersion !== lockedVersion ||
    runtimeVersion !== lockedVersion
  ) {
    throw new Error(
      `Electron 版本不一致（锁定 ${lockedVersion ?? '缺失'}，依赖 ${installedVersion}，运行时 ${runtimeVersion}），请运行 npm ci`
    )
  }
  return electronDist
}

function copyDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(
      join(source, entry.name),
      join(destination, entry.name),
      { recursive: entry.isDirectory(), force: true }
    )
  }
}

function pruneLocales(directory) {
  const localesPath = join(directory, 'locales')
  if (!statSync(localesPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Portable 目录缺少 Electron locales')
  }
  for (const name of readdirSync(localesPath)) {
    if (!portableLocales.has(name)) {
      rmSync(join(localesPath, name), { force: true })
    }
  }
  for (const required of portableLocales) {
    if (!statSync(join(localesPath, required), {
      throwIfNoEntry: false
    })?.isFile()) {
      throw new Error(`Portable 目录缺少必要语言包：${required}`)
    }
  }
}

function parseRequiredAgentArchitectures(value) {
  if (value === undefined) {
    return []
  }
  const architectures = value
    .split(',')
    .map((architecture) => architecture.trim())
  if (
    architectures.length === 0 ||
    architectures.some(
      (architecture) =>
        !supportedArchitectures.includes(architecture)
    )
  ) {
    throw new Error(
      'GOODBUDDY_PORTABLE_REQUIRE_AGENT_ARCHS 仅支持逗号分隔的 x64 和 arm64'
    )
  }
  return [...new Set(architectures)]
}

function discoverLocalAgentResources(projectRoot = root) {
  return supportedArchitectures.filter((architecture) =>
    statSync(
      join(
        projectRoot,
        '.agent-resources',
        targetName(architecture)
      ),
      { throwIfNoEntry: false }
    )?.isDirectory()
  )
}

function embedPortableAgentResources(directory, options = {}) {
  const projectRoot = options.projectRoot ?? root
  const requiredArchitectures =
    options.requiredArchitectures ??
    parseRequiredAgentArchitectures(
      process.env.GOODBUDDY_PORTABLE_REQUIRE_AGENT_ARCHS
    )
  const verifyBundle =
    options.verifyLockedBundle ?? verifyLockedBundle
  const availableArchitectures =
    discoverLocalAgentResources(projectRoot)
  const missingArchitectures = requiredArchitectures.filter(
    (architecture) =>
      !availableArchitectures.includes(architecture)
  )
  if (missingArchitectures.length > 0) {
    throw new Error(
      `Portable 构建缺少要求的 Agent 资源：${missingArchitectures
        .map(targetName)
        .join(', ')}`
    )
  }

  for (const architecture of availableArchitectures) {
    verifyBundle(
      join(
        projectRoot,
        '.agent-resources',
        targetName(architecture)
      ),
      architecture,
      { projectRoot }
    )
  }
  for (const architecture of availableArchitectures) {
    const target = targetName(architecture)
    const source = join(
      projectRoot,
      '.agent-resources',
      target
    )
    const destination = join(
      directory,
      'resources',
      'agents',
      target
    )
    rmSync(destination, { recursive: true, force: true })
    cpSync(source, destination, {
      recursive: true,
      force: true
    })
  }
  return availableArchitectures
}

function portableRequiredPaths(
  directory,
  agentArchitectures = []
) {
  return [
    join(directory, 'GoodBuddy.exe'),
    join(directory, 'resources', 'app.asar'),
    join(directory, 'resources', 'agent-runtime-lock.json'),
    join(directory, 'resources', 'remote-runtime-lock.json'),
    join(directory, 'resources', 'agent-release-keys.json'),
    join(directory, 'resources', 'icon.ico'),
    join(directory, 'resources', 'tray-icon.png'),
    join(
      directory,
      'resources',
      'runtimes',
      'opencode',
      'opencode.exe'
    ),
    join(
      directory,
      'resources',
      'runtimes',
      'continue',
      'package.json'
    ),
    ...agentArchitectures.flatMap((architecture) => {
      const agentDirectory = join(
        directory,
        'resources',
        'agents',
        targetName(architecture)
      )
      return [
        join(agentDirectory, 'manifest.json'),
        join(agentDirectory, 'manifest.sig'),
        join(agentDirectory, 'goodbuddy-agent'),
        join(agentDirectory, 'node'),
        join(agentDirectory, 'lib', 'agent.cjs')
      ]
    })
  ]
}

function assertPortableOutput(
  directory,
  agentArchitectures = []
) {
  const requiredPaths = portableRequiredPaths(
    directory,
    agentArchitectures
  )
  const missing = requiredPaths.filter(
    (filePath) => !statSync(filePath, { throwIfNoEntry: false })?.isFile()
  )
  if (missing.length > 0) {
    throw new Error(
      `Portable 目录缺少必要文件：${missing.join(', ')}`
    )
  }
}

function assertReplaceableOutput(directory) {
  if (!existsSync(directory)) {
    return
  }
  const entries = readdirSync(directory)
  if (entries.every((entry) => entry === 'data')) {
    return
  }
  try {
    const marker = JSON.parse(
      readFileSync(join(directory, markerName), 'utf8')
    )
    if (
      marker.productName === 'GoodBuddy' &&
      marker.formatVersion === 1
    ) {
      return
    }
  } catch {
    // Fall back to recognizing portable outputs created before markers.
  }
  if (
    portableRequiredPaths(directory).every(
      (filePath) =>
        statSync(filePath, { throwIfNoEntry: false })?.isFile()
    )
  ) {
    return
  }
  throw new Error(
    `拒绝覆盖未识别的目录：${directory}。请选择空目录或已有的 GoodBuddy portable 目录`
  )
}

function writePortableMarker(directory) {
  writeFileSync(
    join(directory, markerName),
    `${JSON.stringify({
      formatVersion: 1,
      productName: 'GoodBuddy',
      version: packageJson.version
    }, null, 2)}\n`,
    'utf8'
  )
}

function replacePortableOutput(
  source,
  destination,
  agentArchitectures = []
) {
  const replacement = `${destination}.replacement-${process.pid}`
  const backup = `${destination}.previous-${process.pid}`
  mkdirSync(dirname(destination), { recursive: true })
  rmSync(replacement, { recursive: true, force: true })
  rmSync(backup, { recursive: true, force: true })
  copyDirectoryContents(source, replacement)
  try {
    writePortableMarker(replacement)
    assertPortableOutput(replacement, agentArchitectures)

    if (!existsSync(destination)) {
      renameSync(replacement, destination)
      return
    }

    assertReplaceableOutput(destination)
    assertOutputUnlocked(destination)
    renameSync(destination, backup)
    try {
      renameSync(replacement, destination)
      const preservedData = join(backup, 'data')
      if (existsSync(preservedData)) {
        const destinationData = join(destination, 'data')
        if (existsSync(destinationData)) {
          throw new Error(
            `新构建意外包含 data 目录，无法保留 ${preservedData}`
          )
        }
        renameSync(preservedData, destinationData)
      }
      assertPortableOutput(destination, agentArchitectures)
    } catch (error) {
      try {
        const movedData = join(destination, 'data')
        const originalData = join(backup, 'data')
        if (existsSync(movedData) && !existsSync(originalData)) {
          renameSync(movedData, originalData)
        }
        if (existsSync(destination)) {
          renameSync(destination, replacement)
        }
        if (existsSync(backup)) {
          renameSync(backup, destination)
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `更新失败且无法恢复原 portable 目录：${destination}`,
          { cause: rollbackError }
        )
      }
      throw error
    }
    rmSync(backup, { recursive: true, force: true })
  } finally {
    rmSync(replacement, { recursive: true, force: true })
  }
}

function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Portable 目录当前必须在 Windows x64 上构建')
  }
  if (
    portablePath === parse(portablePath).root ||
    portablePath === root ||
    portablePath === outputRoot
  ) {
    throw new Error(
      `拒绝使用不安全的输出目录：${portablePath}`
    )
  }
  const requiredAgentArchitectures =
    parseRequiredAgentArchitectures(
      process.env.GOODBUDDY_PORTABLE_REQUIRE_AGENT_ARCHS
    )
  const electronDist = ensureElectronRuntime()
  mkdirSync(outputRoot, { recursive: true })
  rmSync(stagingRoot, { recursive: true, force: true })

  for (const [label, script, args] of [
    [
      'Node 类型检查',
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      ['--noEmit', '-p', 'tsconfig.node.json']
    ],
    [
      'Renderer 类型检查',
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      ['--noEmit', '-p', 'tsconfig.web.json']
    ],
    [
      'Production bundle',
      join(
        root,
        'node_modules',
        'electron-vite',
        'bin',
        'electron-vite.js'
      ),
      ['build']
    ]
  ]) {
    const buildResult = spawnSync(
      process.execPath,
      [script, ...args],
      {
        cwd: root,
        env: process.env,
        shell: false,
        stdio: 'inherit',
        windowsHide: true
      }
    )
    if (buildResult.error) {
      throw buildResult.error
    }
    if (buildResult.status !== 0) {
      throw new Error(
        `${label}失败（code ${buildResult.status ?? 1}）`
      )
    }
  }

  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', 'electron-builder', 'cli.js'),
      '--dir',
      '--x64',
      `--config.directories.output=${stagingRoot}`,
      `--config.electronDist=${electronDist}`
    ],
    {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true
    }
  )

  if (result.error) {
    rmSync(stagingRoot, { recursive: true, force: true })
    throw result.error
  }
  if (result.status !== 0) {
    rmSync(stagingRoot, { recursive: true, force: true })
    throw new Error(
      `Electron Builder 构建失败（code ${result.status ?? 1}）`
    )
  }
  if (!statSync(unpackedPath, {
    throwIfNoEntry: false
  })?.isDirectory()) {
    rmSync(stagingRoot, { recursive: true, force: true })
    throw new Error('Electron Builder 未生成 portable 目录')
  }
  try {
    pruneLocales(unpackedPath)
    const embeddedAgentArchitectures =
      embedPortableAgentResources(unpackedPath, {
        requiredArchitectures: requiredAgentArchitectures
      })
    assertPortableOutput(
      unpackedPath,
      embeddedAgentArchitectures
    )
    replacePortableOutput(
      unpackedPath,
      portablePath,
      embeddedAgentArchitectures
    )
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }

  console.log(`Portable 目录构建完成：${portablePath}`)
  console.log(`启动文件：${join(portablePath, 'GoodBuddy.exe')}`)
}

module.exports = {
  assertPortableOutput,
  discoverLocalAgentResources,
  embedPortableAgentResources,
  parseRequiredAgentArchitectures,
  portableRequiredPaths
}

if (require.main === module) {
  main()
}
