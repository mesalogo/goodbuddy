const { spawn } = require('node:child_process')
const {
  existsSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { basename, dirname, join, parse, resolve } = require('node:path')
const { sha256File } = require('./file-hash.cjs')

const root = join(__dirname, '..')
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
)
const productName = packageJson.build?.productName ?? packageJson.name
const releaseRoot = join(root, 'dist', 'release')
const manifestName = 'release-manifest.json'
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
    defaultFormats: ['AppImage', 'deb'],
    supportedFormats: ['AppImage', 'deb'],
    unpackedPattern: /^linux(?:-.+)?-unpacked$/u,
    executable: [packageJson.name],
    runtimeExecutable: 'opencode'
  }
}
const formatExtensions = {
  nsis: '.exe',
  portable: '.exe',
  dmg: '.dmg',
  zip: '.zip',
  AppImage: '.AppImage',
  deb: '.deb'
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

function buildElectronBuilderArguments(options, outputDirectory) {
  const definition = platformDefinitions[options.platform]
  const builderArguments = [
    join(root, 'node_modules', 'electron-builder', 'cli.js'),
    definition.builderFlag,
    ...options.formats,
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
  if (
    options.platform === 'windows' &&
    options.formats.includes('portable')
  ) {
    builderArguments.push(
      `--config.portable.artifactName=${productName}-\${version}-windows-\${arch}-portable.\${ext}`
    )
  }
  return builderArguments
}

function detectBinaryArchitecture(buffer) {
  if (
    buffer.length >= 64 &&
    buffer[0] === 0x4d &&
    buffer[1] === 0x5a
  ) {
    const peOffset = buffer.readUInt32LE(0x3c)
    if (
      peOffset + 6 <= buffer.length &&
      buffer.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0'
    ) {
      const machine = buffer.readUInt16LE(peOffset + 4)
      if (machine === 0x8664) {
        return 'x64'
      }
      if (machine === 0xaa64) {
        return 'arm64'
      }
    }
  }
  if (
    buffer.length >= 20 &&
    buffer[0] === 0x7f &&
    buffer.toString('ascii', 1, 4) === 'ELF'
  ) {
    const machine =
      buffer[5] === 2
        ? buffer.readUInt16BE(18)
        : buffer.readUInt16LE(18)
    if (machine === 62) {
      return 'x64'
    }
    if (machine === 183) {
      return 'arm64'
    }
  }
  if (buffer.length >= 8) {
    const littleMagic = buffer.readUInt32LE(0)
    const bigMagic = buffer.readUInt32BE(0)
    const cpuType =
      littleMagic === 0xfeedfacf
        ? buffer.readUInt32LE(4)
        : bigMagic === 0xfeedfacf
          ? buffer.readUInt32BE(4)
          : undefined
    if (cpuType === 0x01000007) {
      return 'x64'
    }
    if (cpuType === 0x0100000c) {
      return 'arm64'
    }
  }
  return undefined
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
  assertFile(runtimeExecutable, 'OpenCode Runtime')
  assertFile(
    join(resources, 'runtimes', 'continue', 'dist', 'index.js'),
    'Continue Runtime'
  )
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
              : /-portable\.exe$/iu.test(name)
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
  }
}

function verifyArtifactSignature(filePath, format, arch) {
  if (format === 'nsis' || format === 'portable') {
    if (readChunk(filePath, 2).toString('ascii') !== 'MZ') {
      throw new Error(`${format} 产物不是有效的 Windows PE 文件`)
    }
    return
  }
  if (format === 'zip') {
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

默认格式：
  windows: nsis, portable
  macos:   dmg, zip
  linux:   AppImage, deb`)
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

  rmSync(stagingDirectory, { recursive: true, force: true })
  try {
    if (!options.skipBuild) {
      const npm = npmInvocation()
      await run(
        npm.command,
        [...npm.prefixArgs, 'run', 'build']
      )
    }
    await run(
      process.execPath,
      builderArguments,
      {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY:
          process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false'
      }
    )
    const unpackedDirectory = verifyUnpackedOutput(
      stagingDirectory,
      options
    )
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
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

module.exports = {
  assertReplaceableOutput,
  buildElectronBuilderArguments,
  detectBinaryArchitecture,
  normalizePlatform,
  parseArguments,
  platformDefinitions,
  replaceOutput,
  verifyArtifacts,
  verifyArtifactSignature,
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
