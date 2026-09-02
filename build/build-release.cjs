const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  createReadStream,
  createWriteStream,
  existsSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { once } = require('node:events')
const { tmpdir } = require('node:os')
const {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep
} = require('node:path')
const { finished } = require('node:stream/promises')
const {
  extractFile,
  listPackage,
  statFile
} = require('@electron/asar')
const { Zip, ZipDeflate } = require('fflate')
const { sha256File } = require('./file-hash.cjs')
const {
  detectBinaryArchitecture
} = require('./binary-architecture.cjs')
const {
  readZipCentralDirectory
} = require('./zip-central-directory.cjs')

const root = join(__dirname, '..')
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
)
const packageLock = JSON.parse(
  readFileSync(join(root, 'package-lock.json'), 'utf8')
)
const productName = packageJson.build?.productName ?? packageJson.name
const releaseRoot = join(root, 'dist', 'release')
const releaseBuilderConfig = join(
  root,
  'build',
  'electron-builder.release.cjs'
)
const manifestName = 'release-manifest.json'
const portableMarkerName = '.goodbuddy-portable.json'
const harnessHostEntry =
  'out/main/deepseek-harness-host-bootstrap.js'
const harnessBundleManifest = 'out/main/package.json'
const harnessPackageVersions = {
  '@deepseek-ai/dsh-agent':
    packageLock.packages['node_modules/@deepseek-ai/dsh-agent']
      ?.version,
  '@napi-rs/canvas':
    packageLock.packages['node_modules/@napi-rs/canvas']
      ?.version,
  'node-pty':
    packageLock.packages['node_modules/node-pty']?.version
}
const koffiVersion =
  packageLock.packages['node_modules/koffi']?.version
const harnessLicenseFiles = [
  'agent-client-protocol-Apache-2.0.txt',
  'deepseek-cordis-MIT.txt',
  'deepseek-harness-MIT.txt',
  'koffi-MIT.txt',
  'napi-rs-canvas-MIT.txt',
  'node-pty-MIT.txt'
]
const portableRequiredFiles = [
  `${productName}.exe`,
  'resources/app.asar',
  'resources/release-notes.json',
  'resources/icon.ico',
  'resources/tray-icon.png',
  'resources/tool-environment/managed-python-artifacts.json',
  'resources/runtimes/opencode/opencode.exe',
  'resources/runtimes/continue/package.json',
  'resources/runtimes/npm/bin/npm-cli.js',
  'resources/runtimes/npm/bin/npx-cli.js',
  'resources/runtimes/npm/package.json',
  'resources/runtimes/npm/node_modules/graceful-fs/package.json'
]
const maxPortableZipEntries = 50_000
const maxPortableCentralDirectoryBytes = 64 * 1024 * 1024
const ansiEscapeCharacter = String.fromCharCode(27)
const ansiSequenceSuffixPattern = /\[[0-9;]*[A-Za-z]/gu
const supportedArchitectures = new Set(['x64', 'arm64'])
const platformAliases = new Map([
  ['win', 'windows'],
  ['win32', 'windows'],
  ['windows', 'windows'],
  ['darwin', 'macos'],
  ['mac', 'macos'],
  ['macos', 'macos'],
  ['linux', 'linux']
])
const hostPlatforms = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux'
}
const platformDefinitions = {
  windows: {
    builderFlag: '--win',
    defaultFormats: ['nsis', 'portable'],
    supportedFormats: ['nsis', 'portable'],
    unpackedPattern: /^win(?:-.+)?-unpacked$/u,
    executable: [`${productName}.exe`],
    runtimeExecutable: 'opencode.exe'
  },
  macos: {
    builderFlag: '--mac',
    defaultFormats: ['dmg', 'zip'],
    supportedFormats: ['dmg', 'zip'],
    unpackedPattern: /^mac(?:-.+)?$/u,
    executable: [
      `${productName}.app`,
      'Contents',
      'MacOS',
      productName
    ],
    runtimeExecutable: 'opencode'
  },
  linux: {
    builderFlag: '--linux',
    defaultFormats: ['AppImage', 'deb', 'rpm'],
    supportedFormats: ['AppImage', 'deb', 'rpm'],
    unpackedPattern: /^linux(?:-.+)?-unpacked$/u,
    executable: [packageJson.name],
    runtimeExecutable: 'opencode'
  }
}
const formatExtensions = {
  nsis: '.exe',
  portable: '.zip',
  dmg: '.dmg',
  zip: '.zip',
  AppImage: '.AppImage',
  deb: '.deb',
  rpm: '.rpm'
}

function normalizePlatform(value) {
  return platformAliases.get(String(value).toLowerCase())
}

function normalizeFormat(platform, value) {
  const definition = platformDefinitions[platform]
  return definition.supportedFormats.find(
    (candidate) => candidate.toLowerCase() === value.toLowerCase()
  )
}

function parseArguments(argv, environment = process) {
  const options = {
    platform: hostPlatforms[environment.platform],
    arch: environment.arch,
    formats: [],
    skipBuild: false,
    dryRun: false,
    unsigned: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--platform') {
      options.platform = normalizePlatform(argv[index + 1])
      index += 1
    } else if (argument === '--arch') {
      options.arch = argv[index + 1]
      index += 1
    } else if (argument === '--format') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--format 缺少值')
      }
      options.formats.push(
        ...value.split(',').map((item) => item.trim()).filter(Boolean)
      )
      index += 1
    } else if (argument === '--skip-build') {
      options.skipBuild = true
    } else if (argument === '--dry-run') {
      options.dryRun = true
    } else if (argument === '--unsigned') {
      options.unsigned = true
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数：${argument}`)
    }
  }
  if (options.help) {
    return options
  }
  if (!options.platform) {
    throw new Error('不支持当前系统，请显式指定 --platform')
  }
  if (!supportedArchitectures.has(options.arch)) {
    throw new Error(`不支持的架构：${options.arch}`)
  }
  if (options.unsigned && options.platform !== 'macos') {
    throw new Error('--unsigned 仅支持 macOS 发布包')
  }
  const definition = platformDefinitions[options.platform]
  const requestedFormats =
    options.formats.length > 0
      ? options.formats
      : definition.defaultFormats
  options.formats = [...new Set(requestedFormats.map((format) => {
    const normalized = normalizeFormat(options.platform, format)
    if (!normalized) {
      throw new Error(
        `${options.platform} 不支持打包格式：${format}`
      )
    }
    return normalized
  }))]
  return options
}

function npmInvocation(environment = process.env) {
  if (environment.npm_execpath) {
    return {
      command: process.execPath,
      prefixArgs: [environment.npm_execpath]
    }
  }
  const npmCli = [
    join(
      dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    ),
    join(
      dirname(dirname(process.execPath)),
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    )
  ].find((candidate) => existsSync(candidate))
  if (npmCli) {
    return {
      command: process.execPath,
      prefixArgs: [npmCli]
    }
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefixArgs: []
  }
}

function run(command, args, environment = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true
    })
    let outputTail = ''
    const forward = (chunk, destination) => {
      destination.write(chunk)
      outputTail = `${outputTail}${chunk}`.slice(-12_000)
    }
    child.stdout.on('data', (chunk) => {
      forward(chunk, process.stdout)
    })
    child.stderr.on('data', (chunk) => {
      forward(chunk, process.stderr)
    })
    child.once('error', rejectRun)
    child.once('close', (code) => {
      if (code === 0) {
        resolveRun()
        return
      }
      const error = new Error(
        `命令执行失败（code ${code ?? 1}）：${command} ${args.join(' ')}`
      )
      error.outputTail = outputTail
      rejectRun(error)
    })
  })
}

function runCapture(command, args, environment = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024)
    })
    child.once('error', rejectRun)
    child.once('close', (code) => {
      if (code === 0) {
        resolveRun(stdout)
        return
      }
      const error = new Error(
        `命令执行失败（code ${code ?? 1}）：${command} ${args.join(' ')}`
      )
      error.outputTail = stderr
      rejectRun(error)
    })
  })
}

function buildElectronBuilderArguments(options, outputDirectory) {
  const definition = platformDefinitions[options.platform]
  const builderFormats = [...new Set(
    options.formats.map((format) =>
      options.platform === 'windows' && format === 'portable'
        ? 'dir'
        : format
    )
  )]
  const builderArguments = [
    join(root, 'build', 'run-electron-builder.cjs'),
    '--config',
    releaseBuilderConfig,
    definition.builderFlag,
    ...builderFormats,
    `--${options.arch}`,
    `--config.directories.output=${outputDirectory}`,
    '--publish',
    'never'
  ]
  if (
    options.platform === 'windows' &&
    options.formats.includes('nsis')
  ) {
    builderArguments.push(
      `--config.nsis.artifactName=${productName}-\${version}-windows-\${arch}-setup.\${ext}`
    )
  }
  if (options.platform === 'macos' && options.unsigned) {
    builderArguments.push('--config.mac.notarize=false')
  }
  return builderArguments
}

function electronBuilderEnvironment(
  options,
  environment = process.env
) {
  const builderEnvironment = {
    ...environment,
    CSC_IDENTITY_AUTO_DISCOVERY:
      environment.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false'
  }
  if (options.platform !== 'macos' || !options.unsigned) {
    return builderEnvironment
  }
  for (const name of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME',
    'CSC_INSTALLER_LINK',
    'CSC_INSTALLER_KEY_PASSWORD',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_KEYCHAIN',
    'APPLE_KEYCHAIN_PROFILE'
  ]) {
    delete builderEnvironment[name]
  }
  builderEnvironment.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  return builderEnvironment
}

function binaryArchitecture(filePath) {
  return detectBinaryArchitecture(readChunk(filePath, 4096))
}

function readChunk(filePath, length, position = 0) {
  const descriptor = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(
      descriptor,
      buffer,
      0,
      length,
      position
    )
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(descriptor)
  }
}

function findUnpackedDirectory(directory, platform) {
  const pattern = platformDefinitions[platform].unpackedPattern
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => join(directory, entry.name))
  if (candidates.length !== 1) {
    throw new Error(
      `无法确定 ${platform} unpacked 目录：${candidates.join(', ') || '未生成'}`
    )
  }
  return candidates[0]
}

function resourceDirectory(unpackedDirectory, platform) {
  return platform === 'macos'
    ? join(
        unpackedDirectory,
        `${productName}.app`,
        'Contents',
        'Resources'
      )
    : join(unpackedDirectory, 'resources')
}

function assertFile(filePath, description) {
  if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${description}缺失：${filePath}`)
  }
}

function readJsonFile(filePath, description) {
  assertFile(filePath, description)
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `${description}无效：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
}

function normalizeAsarEntry(filePath) {
  return filePath.split('/').join(sep)
}

function asarEntryMetadata(
  asarPath,
  entryNames,
  filePath,
  description,
  statAsarFile = statFile
) {
  const entry = normalizeAsarEntry(filePath)
  if (!entryNames.has(`${sep}${entry}`)) {
    throw new Error(`${description}缺失：${filePath}`)
  }
  return statAsarFile(asarPath, entry)
}

function assertAsarEntry(entryNames, filePath, description) {
  const entry = normalizeAsarEntry(filePath)
  if (!entryNames.has(`${sep}${entry}`)) {
    throw new Error(`${description}缺失：${filePath}`)
  }
}

function assertBinaryArchitecture(filePath, expected, description) {
  assertFile(filePath, description)
  const actual = binaryArchitecture(filePath)
  if (actual !== expected) {
    throw new Error(
      `${description}架构错误：期望 ${expected}，实际 ${actual ?? '未知'}`
    )
  }
}

function targetHarnessPaths(options) {
  const platformName = {
    windows: 'win32',
    macos: 'darwin',
    linux: 'linux'
  }[options.platform]
  const koffiPackage = `@koromix/koffi-${platformName}-${options.arch}`
  const koffiBinary = {
    windows: `win32_${options.arch}/koffi.node`,
    macos: `darwin_${options.arch}/koffi.node`,
    linux: `linux_${options.arch}/koffi.node`
  }[options.platform]
  const canvasTarget = {
    windows: `win32-${options.arch}-msvc`,
    macos: `darwin-${options.arch}`,
    linux: `linux-${options.arch}-gnu`
  }[options.platform]
  return {
    canvasPackage: `@napi-rs/canvas-${canvasTarget}`,
    canvasBinary: `skia.${canvasTarget}.node`,
    koffiPackage,
    koffiBinary,
    nodePtyBinary:
      `prebuilds/${platformName}-${options.arch}/` +
      (options.platform === 'windows'
        ? 'conpty.node'
        : 'pty.node'),
    nodePtyDirectory: `${platformName}-${options.arch}`
  }
}

function targetRuntimePackageNames(options) {
  const target = targetHarnessPaths(options)
  return [target.koffiPackage, target.canvasPackage]
}

function lockedTargetRuntimePackage(
  packageName,
  packageMetadata = packageJson,
  lockMetadata = packageLock
) {
  let expectedVersion =
    packageMetadata.optionalDependencies?.[packageName]
  if (
    typeof expectedVersion !== 'string' &&
    packageName.startsWith('@napi-rs/canvas-')
  ) {
    const canvasPackageName = '@napi-rs/canvas'
    const canvasVersion =
      packageMetadata.dependencies?.[canvasPackageName]
    const canvasLockEntry =
      lockMetadata.packages?.[`node_modules/${canvasPackageName}`]
    if (
      typeof canvasVersion !== 'string' ||
      canvasLockEntry?.version !== canvasVersion ||
      canvasLockEntry.optionalDependencies?.[packageName] !==
        canvasVersion
    ) {
      throw new Error(
        `目标 Runtime 依赖未完整锁定：${packageName}`
      )
    }
    expectedVersion = canvasVersion
  }
  const lockEntry =
    lockMetadata.packages?.[`node_modules/${packageName}`]
  if (
    typeof expectedVersion !== 'string' ||
    lockEntry?.version !== expectedVersion ||
    typeof lockEntry.resolved !== 'string' ||
    typeof lockEntry.integrity !== 'string'
  ) {
    throw new Error(
      `目标 Runtime 依赖未完整锁定：${packageName}`
    )
  }
  return {
    name: packageName,
    version: expectedVersion,
    integrity: lockEntry.integrity
  }
}

function parsePackedPackageMetadata(output, expected) {
  let entries
  try {
    entries = JSON.parse(output)
  } catch (error) {
    throw new Error(
      `目标 Runtime 依赖 npm pack 输出无效：${expected.name}`,
      { cause: error }
    )
  }
  const metadata =
    Array.isArray(entries) && entries.length === 1
      ? entries[0]
      : undefined
  if (
    metadata?.name !== expected.name ||
    metadata.version !== expected.version ||
    metadata.integrity !== expected.integrity ||
    typeof metadata.filename !== 'string' ||
    basename(metadata.filename) !== metadata.filename
  ) {
    throw new Error(
      `目标 Runtime 依赖 npm pack 元数据不匹配：${expected.name}`
    )
  }
  return metadata
}

function verifyArchiveIntegrity(filePath, expectedIntegrity) {
  const match = /^(sha(?:256|384|512))-(\S+)$/u.exec(
    expectedIntegrity
  )
  if (!match) {
    throw new Error(`不支持的依赖完整性格式：${expectedIntegrity}`)
  }
  const actual = createHash(match[1])
    .update(readFileSync(filePath))
    .digest('base64')
  if (actual !== match[2]) {
    throw new Error(`目标 Runtime 依赖完整性校验失败：${filePath}`)
  }
}

function installedPackageMatches(
  packageName,
  expectedVersion,
  runtimeRoot = root
) {
  const manifestPath = join(
    runtimeRoot,
    'node_modules',
    ...packageName.split('/'),
    'package.json'
  )
  if (!existsSync(manifestPath)) {
    return false
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    manifest.name !== packageName ||
    manifest.version !== expectedVersion
  ) {
    throw new Error(
      `目标 Runtime 依赖版本错误：${packageName}`
    )
  }
  return true
}

async function stageTargetRuntimeDependencies(
  options,
  dependencies = {}
) {
  const runtimeRoot = dependencies.root ?? root
  const runtimePackageJson =
    dependencies.packageJson ?? packageJson
  const runtimePackageLock =
    dependencies.packageLock ?? packageLock
  const missing = targetRuntimePackageNames(options)
    .map((packageName) =>
      lockedTargetRuntimePackage(
        packageName,
        runtimePackageJson,
        runtimePackageLock
      )
    )
    .filter(
      (dependency) =>
        !installedPackageMatches(
          dependency.name,
          dependency.version,
          runtimeRoot
        )
    )
  if (missing.length === 0) {
    return () => undefined
  }

  const stagingRoot = mkdtempSync(
    join(tmpdir(), 'goodbuddy-release-dependencies-')
  )
  const stagedDirectories = []
  const cleanup = () => {
    for (const directory of stagedDirectories.reverse()) {
      rmSync(directory, { recursive: true, force: true })
    }
    rmSync(stagingRoot, { recursive: true, force: true })
  }

  try {
    const npm = dependencies.npmInvocation?.() ?? npmInvocation()
    const captureCommand =
      dependencies.runCapture ?? runCapture
    const extractArchive =
      dependencies.extractArchive ??
      ((archivePath, destination) =>
        run('tar', [
          '-xzf',
          archivePath,
          '-C',
          destination,
          '--strip-components',
          '1'
        ]))
    for (const [index, dependency] of missing.entries()) {
      const archiveDirectory = join(
        stagingRoot,
        `package-${index}`
      )
      mkdirSync(archiveDirectory, { recursive: true })
      const output = await captureCommand(npm.command, [
        ...npm.prefixArgs,
        'pack',
        `${dependency.name}@${dependency.version}`,
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        archiveDirectory
      ])
      const metadata = parsePackedPackageMetadata(
        output,
        dependency
      )
      const archivePath = join(
        archiveDirectory,
        metadata.filename
      )
      verifyArchiveIntegrity(archivePath, dependency.integrity)

      const destination = join(
        runtimeRoot,
        'node_modules',
        ...dependency.name.split('/')
      )
      if (existsSync(destination)) {
        throw new Error(
          `拒绝覆盖目标 Runtime 依赖目录：${destination}`
        )
      }
      mkdirSync(destination, { recursive: true })
      stagedDirectories.push(destination)
      await extractArchive(archivePath, destination)
      if (
        !installedPackageMatches(
          dependency.name,
          dependency.version,
          runtimeRoot
        )
      ) {
        throw new Error(
          `目标 Runtime 依赖暂存失败：${dependency.name}`
        )
      }
      console.log(
        `已暂存目标 Runtime 依赖：${dependency.name}@${dependency.version}`
      )
    }
    return cleanup
  } catch (error) {
    cleanup()
    throw error
  }
}

function verifyHarnessPackage(
  resources,
  options,
  dependencies = {}
) {
  const asarPath = join(resources, 'app.asar')
  const unpackedRoot = join(resources, 'app.asar.unpacked')
  const listAsarEntries = dependencies.listPackage ?? listPackage
  const statAsarFile = dependencies.statFile ?? statFile
  const extractAsarFile = dependencies.extractFile ?? extractFile
  const entries = new Set(listAsarEntries(asarPath))
  const target = targetHarnessPaths(options)

  assertAsarEntry(entries, harnessHostEntry, 'DeepSeek Harness Host')
  const readJson = (filePath, description) => {
    const metadata = asarEntryMetadata(
      asarPath,
      entries,
      filePath,
      description,
      statAsarFile
    )
    if ('files' in metadata || 'link' in metadata) {
      throw new Error(`${description}类型错误：${filePath}`)
    }
    return JSON.parse(
      extractAsarFile(asarPath, normalizeAsarEntry(filePath))
    )
  }
  const bundleManifest = readJson(
    harnessBundleManifest,
    'DeepSeek Harness bundle 元数据'
  )
  if (
    bundleManifest.name !== '@deepseek-ai/dsh-llm' ||
    bundleManifest.version !==
      harnessPackageVersions['@deepseek-ai/dsh-agent']
  ) {
    throw new Error('DeepSeek Harness bundle 元数据错误')
  }
  assertFile(
    join(unpackedRoot, ...harnessBundleManifest.split('/')),
    'DeepSeek Harness 可执行 bundle 元数据'
  )
  assertFile(
    join(unpackedRoot, ...harnessHostEntry.split('/')),
    'DeepSeek Harness 可执行 Host'
  )
  const harnessLlmChunk = [...entries]
    .map((entry) => entry.slice(1).split(sep).join('/'))
    .find((entry) =>
      /^out\/main\/chunks\/deepseek-harness-llm-[^/]+\.js$/u.test(
        entry
      )
    )
  if (!harnessLlmChunk) {
    throw new Error('DeepSeek Harness LLM chunk缺失')
  }
  const harnessLlmSource = extractAsarFile(
    asarPath,
    normalizeAsarEntry(harnessLlmChunk)
  ).toString('utf8')
  const requiredChunkNames = new Set([
    ...[
      ...harnessLlmSource.matchAll(
        /import\(["']\.\/([^/"']+\.js)["']\)/gu
      )
    ].map((match) => match[1]),
    ...[...entries]
      .map((entry) => entry.slice(1).split(sep).join('/'))
      .filter((entry) =>
        /^out\/main\/chunks\/[^/]+\.js$/u.test(entry)
      )
      .map((entry) => entry.slice('out/main/chunks/'.length))
  ])
  if (requiredChunkNames.size === 0) {
    throw new Error('DeepSeek Harness LLM lazy chunk closure缺失')
  }
  for (const chunkName of requiredChunkNames) {
    const chunkPath = `out/main/chunks/${chunkName}`
    const metadata = asarEntryMetadata(
      asarPath,
      entries,
      chunkPath,
      'DeepSeek Harness module chunk',
      statAsarFile
    )
    if (!('unpacked' in metadata) || !metadata.unpacked) {
      throw new Error(
        `DeepSeek Harness module chunk未从 ASAR 解包：${chunkPath}`
      )
    }
    assertFile(
      join(unpackedRoot, ...chunkPath.split('/')),
      'DeepSeek Harness 可执行 module chunk'
    )
  }
  for (const [packageName, expectedVersion] of Object.entries(
    harnessPackageVersions
  )) {
    const manifest = readJson(
      `node_modules/${packageName}/package.json`,
      `${packageName} 元数据`
    )
    if (manifest.version !== expectedVersion) {
      throw new Error(
        `${packageName} 版本错误：期望 ${expectedVersion}，实际 ${String(manifest.version)}`
      )
    }
  }
  const npmRoot = join(resources, 'runtimes', 'npm')
  const npmManifest = readJsonFile(
    join(npmRoot, 'package.json'),
    'DSH 插件安装 npm 元数据'
  )
  if (npmManifest.version !== packageJson.dependencies?.npm) {
    throw new Error(
      `DSH 插件安装 npm 版本错误：期望 ${String(packageJson.dependencies?.npm)}，实际 ${String(npmManifest.version)}`
    )
  }
  assertFile(
    join(npmRoot, 'bin', 'npm-cli.js'),
    'DSH 插件安装 npm CLI'
  )
  assertFile(
    join(npmRoot, 'bin', 'npx-cli.js'),
    'DSH 插件安装 npx CLI'
  )
  if (
    !Array.isArray(npmManifest.bundleDependencies) ||
    npmManifest.bundleDependencies.length === 0
  ) {
    throw new Error('DSH 插件安装 npm 依赖清单无效')
  }
  for (const packageName of npmManifest.bundleDependencies) {
    if (
      typeof packageName !== 'string' ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(
        packageName
      )
    ) {
      throw new Error('DSH 插件安装 npm 依赖清单无效')
    }
    assertFile(
      join(
        npmRoot,
        'node_modules',
        ...packageName.split('/'),
        'package.json'
      ),
      `DSH 插件安装 npm 依赖 ${packageName}`
    )
  }
  const targetKoffiManifest = readJson(
    `node_modules/${target.koffiPackage}/package.json`,
    `${target.koffiPackage} 元数据`
  )
  if (targetKoffiManifest.version !== koffiVersion) {
    throw new Error(
      `${target.koffiPackage} 版本错误：期望 ${koffiVersion}，实际 ${String(targetKoffiManifest.version)}`
    )
  }
  const targetCanvasManifest = readJson(
    `node_modules/${target.canvasPackage}/package.json`,
    `${target.canvasPackage} 元数据`
  )
  if (
    targetCanvasManifest.version !==
    harnessPackageVersions['@napi-rs/canvas']
  ) {
    throw new Error(
      `${target.canvasPackage} 版本错误：期望 ${harnessPackageVersions['@napi-rs/canvas']}，实际 ${String(targetCanvasManifest.version)}`
    )
  }

  const ptyBinary = join(
    unpackedRoot,
    'node_modules',
    'node-pty',
    ...target.nodePtyBinary.split('/')
  )
  const koffiBinary = join(
    unpackedRoot,
    'node_modules',
    ...target.koffiPackage.split('/'),
    ...target.koffiBinary.split('/')
  )
  const canvasBinary = join(
    unpackedRoot,
    'node_modules',
    ...target.canvasPackage.split('/'),
    target.canvasBinary
  )
  assertBinaryArchitecture(
    ptyBinary,
    options.arch,
    'DeepSeek Harness node-pty'
  )
  const nodePtyMetadata = asarEntryMetadata(
    asarPath,
    entries,
    `node_modules/node-pty/${target.nodePtyBinary}`,
    'DeepSeek Harness node-pty 元数据',
    statAsarFile
  )
  const koffiMetadata = asarEntryMetadata(
    asarPath,
    entries,
    `node_modules/${target.koffiPackage}/${target.koffiBinary}`,
    'DeepSeek Harness Koffi 元数据',
    statAsarFile
  )
  const canvasMetadata = asarEntryMetadata(
    asarPath,
    entries,
    `node_modules/${target.canvasPackage}/${target.canvasBinary}`,
    'DeepSeek Harness Canvas 元数据',
    statAsarFile
  )
  for (const [metadata, description] of [
    [nodePtyMetadata, 'DeepSeek Harness node-pty'],
    [koffiMetadata, 'DeepSeek Harness Koffi'],
    [canvasMetadata, 'DeepSeek Harness Canvas']
  ]) {
    if (!('unpacked' in metadata) || !metadata.unpacked) {
      throw new Error(`${description}未从 ASAR 解包`)
    }
  }
  assertBinaryArchitecture(
    koffiBinary,
    options.arch,
    'DeepSeek Harness Koffi'
  )
  assertBinaryArchitecture(
    canvasBinary,
    options.arch,
    'DeepSeek Harness Canvas'
  )

  if (options.platform === 'macos') {
    const helper = join(
      unpackedRoot,
      'node_modules',
      'node-pty',
      'prebuilds',
      target.nodePtyDirectory,
      'spawn-helper'
    )
    assertFile(helper, 'DeepSeek Harness node-pty spawn-helper')
    if ((statSync(helper).mode & 0o111) === 0) {
      throw new Error(
        `DeepSeek Harness node-pty spawn-helper 不可执行：${helper}`
      )
    }
  }

  for (const license of harnessLicenseFiles) {
    assertFile(
      join(resources, 'licenses', license),
      'DeepSeek Harness 许可证'
    )
  }
}

function verifyUnpackedOutput(directory, options) {
  const definition = platformDefinitions[options.platform]
  const unpackedDirectory = findUnpackedDirectory(
    directory,
    options.platform
  )
  const applicationExecutable = join(
    unpackedDirectory,
    ...definition.executable
  )
  const resources = resourceDirectory(
    unpackedDirectory,
    options.platform
  )
  const runtimeExecutable = join(
    resources,
    'runtimes',
    'opencode',
    definition.runtimeExecutable
  )
  assertFile(applicationExecutable, '应用主程序')
  assertFile(join(resources, 'app.asar'), '应用 ASAR')
  assertFile(join(resources, 'release-notes.json'), '版本更新说明')
  assertFile(
    join(
      resources,
      'tool-environment',
      'managed-python-artifacts.json'
    ),
    '托管 Python 产物目录'
  )
  assertFile(
    join(resources, 'agent-release-keys.json'),
    'Agent 受信任签名密钥'
  )
  assertFile(
    join(resources, 'agent-runtime-lock.json'),
    'Agent Runtime 锁定清单'
  )
  assertFile(
    join(resources, 'remote-runtime-lock.json'),
    'Remote Runtime 锁定清单'
  )
  assertFile(runtimeExecutable, 'OpenCode Runtime')
  assertFile(
    join(resources, 'runtimes', 'continue', 'dist', 'index.js'),
    'Continue Runtime'
  )
  assertFile(
    join(
      resources,
      'runtimes',
      'npm',
      'bin',
      'npm-cli.js'
    ),
    'DSH 插件安装 npm Runtime'
  )
  assertFile(
    join(
      resources,
      'runtimes',
      'npm',
      'bin',
      'npx-cli.js'
    ),
    'DSH 插件安装 npx Runtime'
  )
  verifyHarnessPackage(resources, options)
  for (const [filePath, label] of [
    [applicationExecutable, '应用主程序'],
    [runtimeExecutable, 'OpenCode Runtime']
  ]) {
    const actualArchitecture = binaryArchitecture(filePath)
    if (actualArchitecture !== options.arch) {
      throw new Error(
        `${label}架构错误：期望 ${options.arch}，实际 ${actualArchitecture ?? '未知'}`
      )
    }
  }
  return unpackedDirectory
}

function toArchivePath(rootDirectory, filePath) {
  return relative(rootDirectory, filePath).split(sep).join('/')
}

function listPortableFiles(rootDirectory) {
  const files = []
  const pending = [rootDirectory]
  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => right.name.localeCompare(left.name))
    for (const entry of entries) {
      const filePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Portable 目录不能包含符号链接：${filePath}`)
      }
      if (entry.isDirectory()) {
        pending.push(filePath)
      } else if (entry.isFile()) {
        files.push(filePath)
        if (files.length > maxPortableZipEntries) {
          throw new Error(
            `Portable ZIP 文件数量超过限制：${files.length}`
          )
        }
      } else {
        throw new Error(`Portable 目录包含不支持的文件类型：${filePath}`)
      }
    }
  }
  return files.sort((left, right) =>
    toArchivePath(rootDirectory, left).localeCompare(
      toArchivePath(rootDirectory, right)
    )
  )
}

async function addFileToZip(
  zip,
  rootDirectory,
  filePath,
  waitForDrain
) {
  const input = new ZipDeflate(
    toArchivePath(rootDirectory, filePath),
    { level: 6 }
  )
  zip.add(input)
  const stream = createReadStream(filePath)
  try {
    for await (const chunk of stream) {
      input.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        false
      )
      await waitForDrain()
    }
    input.push(new Uint8Array(), true)
    await waitForDrain()
  } catch (error) {
    stream.destroy()
    throw error
  }
}

function openExclusiveWriteStream(filePath) {
  const descriptor = openSync(filePath, 'wx')
  try {
    return createWriteStream(filePath, {
      fd: descriptor,
      autoClose: true
    })
  } catch (error) {
    closeSync(descriptor)
    rmSync(filePath, { force: true })
    throw error
  }
}

async function createPortableZip(
  unpackedDirectory,
  zipPath,
  dependencies = {}
) {
  const markerPath = join(unpackedDirectory, portableMarkerName)
  writeFileSync(
    markerPath,
    `${JSON.stringify({
      formatVersion: 1,
      productName,
      version: packageJson.version
    }, null, 2)}\n`,
    'utf8'
  )
  const portableFiles = listPortableFiles(unpackedDirectory)
  const output = (
    dependencies.openOutput ?? openExclusiveWriteStream
  )(zipPath)
  let zipError
  let pendingDrain
  let zipFinal = false
  const outputCompletion = finished(output).then(
    () => undefined,
    (error) => {
      zipError ??= error
    }
  )
  const waitForDrain = async () => {
    if (pendingDrain) {
      await pendingDrain
    }
    if (zipError) {
      throw zipError
    }
  }
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      zipError ??= error
      output.destroy(error)
      return
    }
    try {
      if (!output.write(chunk) && !pendingDrain) {
        const drain = once(output, 'drain').then(
          () => undefined,
          (writeError) => {
            zipError ??= writeError
          }
        )
        const currentDrain = Promise.race([
          drain,
          outputCompletion
        ]).finally(() => {
          if (pendingDrain === currentDrain) {
            pendingDrain = undefined
          }
        })
        pendingDrain = currentDrain
      }
      if (final) {
        zipFinal = true
      }
    } catch (writeError) {
      zipError ??= writeError
      output.destroy(writeError)
    }
  })
  try {
    for (const filePath of portableFiles) {
      await addFileToZip(
        zip,
        unpackedDirectory,
        filePath,
        waitForDrain
      )
      if (zipError) {
        throw zipError
      }
    }
    zip.end()
    await waitForDrain()
    if (zipError) {
      throw zipError
    }
    if (!zipFinal) {
      throw new Error('Portable ZIP 未正常结束')
    }
    output.end()
    await outputCompletion
    if (zipError) {
      throw zipError
    }
  } catch (error) {
    zip.terminate()
    output.destroy()
    await outputCompletion
    if (!dependencies.openOutput) {
      rmSync(zipPath, { force: true })
    }
    throw error
  }
}

function readZipEntryNames(filePath) {
  const handle = openSync(filePath, 'r')
  try {
    let parsed
    try {
      parsed = readZipCentralDirectory(
        handle,
        fstatSync(handle).size,
        {
          label: 'Portable ZIP',
          minimumEntries: portableRequiredFiles.length + 1,
          maximumEntries: maxPortableZipEntries,
          maximumCentralDirectoryBytes:
            maxPortableCentralDirectoryBytes
        }
      )
    } catch (error) {
      throw new Error('Portable ZIP 中央目录无效', {
        cause: error
      })
    }
    return parsed.entries.map((entry) => {
      const name = entry.name.replaceAll('\\', '/')
      if (
        !name ||
        name.startsWith('/') ||
        /^[a-z]:\//iu.test(name) ||
        name.includes('\0') ||
        name.split('/').some((part) => part === '..')
      ) {
        throw new Error(`Portable ZIP 包含不安全路径：${name}`)
      }
      return name
    })
  } finally {
    closeSync(handle)
  }
}

function verifyPortableZip(filePath) {
  const entries = readZipEntryNames(filePath)
  const names = new Set(entries)
  if (names.size !== entries.length) {
    throw new Error('Portable ZIP 包含重复文件')
  }
  for (const required of [
    portableMarkerName,
    ...portableRequiredFiles
  ]) {
    if (!names.has(required)) {
      throw new Error(`Portable ZIP 缺少必要文件：${required}`)
    }
  }
}

function verifyArtifacts(directory, options) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  for (const format of options.formats) {
    const extension = formatExtensions[format]
    const candidates = files.filter((name) => name.endsWith(extension))
    const matches =
      options.platform === 'windows'
        ? candidates.filter((name) =>
            format === 'nsis'
              ? /-setup\.exe$/iu.test(name)
              : /-portable\.zip$/iu.test(name)
          )
        : candidates
    if (matches.length !== 1) {
      throw new Error(
        `${format} 产物数量错误：${matches.join(', ') || '未生成'}`
      )
    }
    verifyArtifactSignature(
      join(directory, matches[0]),
      format,
      options.arch
    )
    if (format === 'portable') {
      verifyPortableZip(join(directory, matches[0]))
    }
  }
}

function verifyArtifactSignature(filePath, format, arch) {
  if (format === 'nsis') {
    if (readChunk(filePath, 2).toString('ascii') !== 'MZ') {
      throw new Error(`${format} 产物不是有效的 Windows PE 文件`)
    }
    return
  }
  if (format === 'portable' || format === 'zip') {
    const signature = readChunk(filePath, 4).toString('hex')
    if (
      !['504b0304', '504b0506', '504b0708'].includes(signature)
    ) {
      throw new Error('zip 产物不是有效的 ZIP 文件')
    }
    return
  }
  if (format === 'dmg') {
    const size = statSync(filePath).size
    if (
      size < 512 ||
      readChunk(filePath, 4, size - 512).toString('ascii') !==
        'koly'
    ) {
      throw new Error('dmg 产物缺少 UDIF 尾部')
    }
    return
  }
  if (format === 'AppImage') {
    if (
      detectBinaryArchitecture(readChunk(filePath, 4096)) !== arch
    ) {
      throw new Error(`AppImage 产物架构不是 ${arch}`)
    }
    return
  }
  if (
    format === 'deb' &&
    readChunk(filePath, 8).toString('ascii') !== '!<arch>\n'
  ) {
    throw new Error('deb 产物不是有效的 ar 归档')
  }
  if (
    format === 'rpm' &&
    readChunk(filePath, 4).toString('hex') !== 'edabeedb'
  ) {
    throw new Error('rpm 产物缺少 RPM lead magic')
  }
}

async function writeManifest(directory, options) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name !== manifestName
    )
    .sort((left, right) => left.name.localeCompare(right.name))
  const files = []
  for (const entry of entries) {
    const filePath = join(directory, entry.name)
    files.push({
      name: entry.name,
      size: statSync(filePath).size,
      sha256: await sha256File(filePath)
    })
  }
  const manifest = {
    formatVersion: 1,
    productName,
    version: packageJson.version,
    platform: options.platform,
    arch: options.arch,
    formats: options.formats,
    files
  }
  writeFileSync(
    join(directory, manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  return manifest
}

function assertReplaceableOutput(directory, options) {
  if (!existsSync(directory)) {
    return
  }
  if (readdirSync(directory).length === 0) {
    return
  }
  try {
    const manifest = JSON.parse(
      readFileSync(join(directory, manifestName), 'utf8')
    )
    if (
      manifest.productName === productName &&
      manifest.formatVersion === 1 &&
      manifest.platform === options.platform &&
      manifest.arch === options.arch
    ) {
      return
    }
  } catch {
    // The explicit error below describes the safe recovery path.
  }
  throw new Error(
    `拒绝覆盖未识别的发布目录：${directory}`
  )
}

function replaceOutput(stagingDirectory, destination, options) {
  const backup = `${destination}.previous-${process.pid}`
  assertReplaceableOutput(destination, options)
  rmSync(backup, { recursive: true, force: true })
  if (existsSync(destination)) {
    renameSync(destination, backup)
  }
  try {
    renameSync(stagingDirectory, destination)
  } catch (error) {
    if (!existsSync(destination) && existsSync(backup)) {
      renameSync(backup, destination)
    }
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
}

function safeReleasePath(filePath) {
  const resolved = resolve(filePath)
  if (
    resolved === parse(resolved).root ||
    resolved === root ||
    resolved === dirname(releaseRoot)
  ) {
    throw new Error(`拒绝使用不安全的发布目录：${resolved}`)
  }
  return resolved
}

function summarizeCommandOutput(value) {
  const lines = String(value)
    .replaceAll(ansiEscapeCharacter, '')
    .replace(ansiSequenceSuffixPattern, '')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.includes('duplicate dependency references')
    )
    .map((line) => line.slice(0, 800))
  const important = lines.filter((line) =>
    /error|failed|fatal|cannot|unable|enoent|codesign|hdiutil|exit code/iu.test(
      line
    )
  )
  return [
    ...new Set([
      ...lines.slice(0, 8),
      ...important,
      ...lines.slice(-14)
    ])
  ].join('\n').slice(-3_000)
}

function printHelp() {
  console.log(`${productName} 跨平台发布构建

用法：
  npm run release:package -- --platform <windows|macos|linux> --arch <x64|arm64>

参数：
  --format <列表>  覆盖默认格式，逗号分隔
  --skip-build     复用已有 out 生产构建
  --dry-run        仅显示目标与 electron-builder 参数
  --unsigned       仅用于 macOS，明确禁用代码签名与公证

默认格式：
  windows: nsis, portable (ZIP)
  macos:   dmg, zip
  linux:   AppImage, deb, rpm`)
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    printHelp()
    return
  }
  const targetName = `${options.platform}-${options.arch}`
  const destination = safeReleasePath(join(releaseRoot, targetName))
  const stagingDirectory = safeReleasePath(
    join(releaseRoot, `.stage-${targetName}-${process.pid}`)
  )
  const builderArguments = buildElectronBuilderArguments(
    options,
    stagingDirectory
  )
  if (options.dryRun) {
    console.log(JSON.stringify({
      target: targetName,
      formats: options.formats,
      output: destination,
      command: process.execPath,
      arguments: builderArguments
    }, null, 2))
    return
  }
  const hostPlatform = hostPlatforms[process.platform]
  if (options.platform !== hostPlatform) {
    throw new Error(
      `${options.platform} 包必须在对应系统构建，当前系统为 ${hostPlatform ?? process.platform}`
    )
  }
  if (options.unsigned) {
    console.warn(
      '警告：正在生成未签名、未公证的 macOS 包，Gatekeeper 可能阻止用户首次打开。'
    )
  }

  rmSync(stagingDirectory, { recursive: true, force: true })
  let cleanupTargetDependencies = () => undefined
  try {
    if (!options.skipBuild) {
      const npm = npmInvocation()
      await run(
        npm.command,
        [...npm.prefixArgs, 'run', 'build']
      )
    }
    cleanupTargetDependencies =
      await stageTargetRuntimeDependencies(options)
    await run(
      process.execPath,
      builderArguments,
      electronBuilderEnvironment(options)
    )
    const unpackedDirectory = verifyUnpackedOutput(
      stagingDirectory,
      options
    )
    if (
      options.platform === 'windows' &&
      options.formats.includes('portable')
    ) {
      await createPortableZip(
        unpackedDirectory,
        join(
          stagingDirectory,
          `${productName}-${packageJson.version}-windows-${options.arch}-portable.zip`
        )
      )
    }
    verifyArtifacts(stagingDirectory, options)
    rmSync(unpackedDirectory, { recursive: true, force: true })
    const manifest = await writeManifest(stagingDirectory, options)
    replaceOutput(stagingDirectory, destination, options)
    console.log(`发布包构建完成：${destination}`)
    for (const file of manifest.files) {
      console.log(
        `${basename(file.name)}  ${file.size} bytes  sha256:${file.sha256}`
      )
    }
  } finally {
    cleanupTargetDependencies()
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

module.exports = {
  assertReplaceableOutput,
  buildElectronBuilderArguments,
  createPortableZip,
  detectBinaryArchitecture,
  electronBuilderEnvironment,
  normalizePlatform,
  parseArguments,
  parsePackedPackageMetadata,
  platformDefinitions,
  lockedTargetRuntimePackage,
  replaceOutput,
  stageTargetRuntimeDependencies,
  targetRuntimePackageNames,
  targetHarnessPaths,
  verifyHarnessPackage,
  verifyArchiveIntegrity,
  verifyUnpackedOutput,
  verifyArtifacts,
  verifyArtifactSignature,
  verifyPortableZip,
  writeManifest
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    if (process.env.GITHUB_ACTIONS === 'true') {
      const details = `${error.message}\n${summarizeCommandOutput(error.outputTail ?? '')}`
        .replace(
          /((?:authorization|_authToken|api[_-]?key|password)\s*[:=]\s*)\S+/giu,
          '$1[redacted]'
        )
        .replaceAll('%', '%25')
        .replaceAll('\r', '%0D')
        .replaceAll('\n', '%0A')
      console.error(
        `::error title=Release packaging failed::${details}`
      )
    }
    process.exitCode = 1
  })
}
