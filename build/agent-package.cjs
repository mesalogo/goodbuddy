const {
  createHash,
  sign
} = require('node:crypto')
const {
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync
} = require('node:fs')
const { basename, dirname, join, relative, resolve, sep } = require('node:path')
const { tmpdir } = require('node:os')
const { crc32 } = require('node:zlib')
const {
  buildAgentBundle,
  expectedManifestMode: expectedAgentManifestMode,
  preflightProductionSigningKey,
  productionSigningKey,
  publicKeySpkiBase64,
  readRuntimeLock,
  readTrustedKeyRegistry,
  redactSecrets,
  verifyLockedBundle
} = require('./agent-bundle.cjs')
const {
  buildRuntimeBundle,
  canonicalJson,
  readRemoteRuntimeLock,
  verifyBundleDirectory: verifyRuntimeBundle
} = require('./remote-runtime-bundle.cjs')
const {
  centralDirectoryHeaderSignature: zipCentralHeaderSignature,
  endOfCentralDirectorySignature: zipEndSignature,
  localFileHeaderSignature: zipLocalHeaderSignature
} = require('./zip-central-directory.cjs')

const root = join(__dirname, '..')
const packageDescriptorName = 'agent-package.json'
const packageSignatureName = 'agent-package.sig'
const signatureDomain = Buffer.from(
  'GoodBuddy Agent Package Descriptor Signature v1\0',
  'utf8'
)
const zipUtf8Flag = 0x0800
const zipVersion = 20
const zipMadeByUnix = (3 << 8) | zipVersion
const zipDosDate = (1 << 5) | 1
const semanticVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?$/u

function descriptorBytes(descriptor) {
  return Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8')
}

function descriptorContentDigest(descriptor) {
  const { contentDigest: _contentDigest, ...content } = descriptor
  void _contentDigest
  return `sha256:${createHash('sha256')
    .update(canonicalJson(content))
    .digest('hex')}`
}

function listFiles(directory) {
  const rootPath = resolve(directory)
  const output = []
  const visit = (current) => {
    const currentStat = lstatSync(current)
    if (currentStat.isSymbolicLink()) {
      throw new Error(`Agent package source contains a symlink: ${current}`)
    }
    if (currentStat.isFile()) {
      output.push(current)
      return
    }
    if (!currentStat.isDirectory()) {
      throw new Error(
        `Agent package source contains an unsupported entry: ${current}`
      )
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      visit(join(current, entry.name))
    }
  }
  visit(rootPath)
  return output.sort((left, right) =>
    Buffer.from(relative(rootPath, left).split(sep).join('/')).compare(
      Buffer.from(relative(rootPath, right).split(sep).join('/'))
    )
  )
}

function fileDigests(filePath) {
  const hash = createHash('sha256')
  const handle = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let checksum = 0
  try {
    while (true) {
      const bytesRead = readSync(
        handle,
        buffer,
        0,
        buffer.length,
        null
      )
      if (bytesRead === 0) {
        break
      }
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      checksum = crc32(chunk, checksum)
    }
  } finally {
    closeSync(handle)
  }
  return {
    crc32: checksum >>> 0,
    sha256: hash.digest('hex')
  }
}

function copyTree(source, destination) {
  for (const filePath of listFiles(source)) {
    const name = relative(source, filePath).split(sep).join('/')
    const target = join(destination, ...name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(filePath, target)
  }
}

function packageFileMode(path) {
  if (path.startsWith('agent/')) {
    return expectedAgentManifestMode(path.slice('agent/'.length))
  }
  return /\/bin\/opencode$/u.test(path) ? '0755' : '0644'
}

function stagePackagePayload(options) {
  const staging = options.staging
  copyTree(options.agentBundle, join(staging, 'agent'))
  copyTree(
    options.runtimeBundle,
    join(
      staging,
      'runtime',
      'opencode',
      basename(options.runtimeBundle)
    )
  )
  for (const [value, destination] of [
    [
      options.registry,
      'agent-release-keys.json'
    ],
    [
      options.agentLock,
      'agent-runtime-lock.json'
    ],
    [
      options.runtimeLock,
      'remote-runtime-lock.json'
    ]
  ]) {
    writeFileSync(
      join(staging, destination),
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8'
    )
  }
}

function payloadFiles(staging) {
  const crc32ByPath = new Map()
  const files = listFiles(staging)
    .map((filePath) => {
      const path = relative(staging, filePath).split(sep).join('/')
      const size = statSync(filePath).size
      const digests = fileDigests(filePath)
      crc32ByPath.set(path, digests.crc32)
      return {
        path,
        size,
        sha256: digests.sha256,
        mode: packageFileMode(path)
      }
    })
    .filter(
      (file) =>
        file.path !== packageDescriptorName &&
        file.path !== packageSignatureName
    )
  return { crc32ByPath, files }
}

function createPackageArchive(
  staging,
  output,
  knownCrc32 = new Map()
) {
  mkdirSync(dirname(output), { recursive: true })
  const entries = listFiles(staging).map((filePath) => {
    const name = relative(staging, filePath).split(sep).join('/')
    const nameBytes = Buffer.from(name, 'utf8')
    const size = statSync(filePath).size
    if (
      nameBytes.length === 0 ||
      nameBytes.length > 0xffff ||
      size > 0xffffffff
    ) {
      throw new Error(`Agent package ZIP entry is too large: ${name}`)
    }
    return {
      filePath,
      name,
      nameBytes,
      size,
      crc32:
        knownCrc32.get(name) ?? fileDigests(filePath).crc32,
      mode: packageFileMode(name),
      offset: 0
    }
  })
  if (entries.length === 0 || entries.length > 0xffff) {
    throw new Error('Agent package ZIP entry count is invalid')
  }
  const outputHandle = openSync(output, 'w')
  let outputOffset = 0
  const archiveHash = createHash('sha256')
  const writeBytes = (data) => {
    let offset = 0
    while (offset < data.byteLength) {
      const written = writeSync(
        outputHandle,
        data,
        offset,
        data.byteLength - offset
      )
      if (written <= 0) {
        throw new Error('Agent package archive write made no progress')
      }
      offset += written
    }
    archiveHash.update(data)
    outputOffset += data.byteLength
  }
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (const entry of entries) {
      entry.offset = outputOffset
      const header = Buffer.alloc(30)
      header.writeUInt32LE(zipLocalHeaderSignature, 0)
      header.writeUInt16LE(zipVersion, 4)
      header.writeUInt16LE(zipUtf8Flag, 6)
      header.writeUInt16LE(0, 8)
      header.writeUInt16LE(0, 10)
      header.writeUInt16LE(zipDosDate, 12)
      header.writeUInt32LE(entry.crc32, 14)
      header.writeUInt32LE(entry.size, 18)
      header.writeUInt32LE(entry.size, 22)
      header.writeUInt16LE(entry.nameBytes.length, 26)
      header.writeUInt16LE(0, 28)
      writeBytes(header)
      writeBytes(entry.nameBytes)

      const inputHandle = openSync(entry.filePath, 'r')
      try {
        let position = 0
        while (position < entry.size) {
          const bytesRead = readSync(
            inputHandle,
            buffer,
            0,
            Math.min(buffer.length, entry.size - position),
            null
          )
          if (bytesRead <= 0) {
            throw new Error(
              `Agent package source read made no progress: ${entry.name}`
            )
          }
          position += bytesRead
          writeBytes(buffer.subarray(0, bytesRead))
        }
      } finally {
        closeSync(inputHandle)
      }
    }

    const centralOffset = outputOffset
    for (const entry of entries) {
      const record = Buffer.alloc(46)
      record.writeUInt32LE(zipCentralHeaderSignature, 0)
      record.writeUInt16LE(zipMadeByUnix, 4)
      record.writeUInt16LE(zipVersion, 6)
      record.writeUInt16LE(zipUtf8Flag, 8)
      record.writeUInt16LE(0, 10)
      record.writeUInt16LE(0, 12)
      record.writeUInt16LE(zipDosDate, 14)
      record.writeUInt32LE(entry.crc32, 16)
      record.writeUInt32LE(entry.size, 20)
      record.writeUInt32LE(entry.size, 24)
      record.writeUInt16LE(entry.nameBytes.length, 28)
      record.writeUInt16LE(0, 30)
      record.writeUInt16LE(0, 32)
      record.writeUInt16LE(0, 34)
      record.writeUInt16LE(0, 36)
      const unixMode =
        0o100000 | Number.parseInt(entry.mode, 8)
      record.writeUInt32LE((unixMode << 16) >>> 0, 38)
      record.writeUInt32LE(entry.offset, 42)
      writeBytes(record)
      writeBytes(entry.nameBytes)
    }

    const centralSize = outputOffset - centralOffset
    const end = Buffer.alloc(22)
    end.writeUInt32LE(zipEndSignature, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralOffset, 16)
    end.writeUInt16LE(0, 20)
    writeBytes(end)
    fsyncSync(outputHandle)
  } finally {
    closeSync(outputHandle)
  }
  return {
    size: outputOffset,
    sha256: archiveHash.digest('hex')
  }
}

function assembleAgentPackage(options) {
  const projectRoot = options.projectRoot ?? root
  const architecture = options.architecture
  if (
    !['x64', 'arm64'].includes(architecture) ||
    !semanticVersionPattern.test(options.minimumDesktopVersion ?? '') ||
    typeof options.output !== 'string'
  ) {
    throw new Error('Agent package identity is invalid')
  }
  const registry =
    options.registry ?? readTrustedKeyRegistry(projectRoot)
  const agentLock =
    options.agentLock ?? readRuntimeLock(projectRoot)
  const runtimeLock =
    options.runtimeLock ?? readRemoteRuntimeLock(projectRoot)
  const signingIdentity =
    options.testSigningIdentity ??
    options.signingIdentity ??
    productionSigningKey(options.environment ?? process.env)
  const signingRecord = options.testSigningIdentity
    ? registry.keys.find(
        (key) => key.keyId === signingIdentity.keyId
      )
    : preflightProductionSigningKey({
        projectRoot,
        registry,
        keyId: signingIdentity.keyId
      })
  if (!signingRecord) {
    throw new Error('Agent package signing key is not registered')
  }
  if (
    publicKeySpkiBase64(signingIdentity.privateKey) !==
    signingRecord.publicKeySpkiBase64
  ) {
    throw new Error(
      'Agent package signing private key does not match the trusted registry'
    )
  }
  const agent = verifyLockedBundle(
    options.agentBundle,
    architecture,
    {
      projectRoot,
      registry,
      lock: agentLock,
      verificationEnvironment: options.testSigningIdentity
        ? 'test'
        : 'production'
    }
  )
  const runtime = verifyRuntimeBundle(options.runtimeBundle, {
    projectRoot,
    architecture,
    registry,
    lock: runtimeLock,
    verificationEnvironment: options.testSigningIdentity
      ? 'test'
      : 'production'
  })
  const expectedArchiveName =
    `goodbuddy-agent-${agent.manifest.agentVersion}` +
    `-linux-${architecture}.gbagent`
  if (basename(options.output) !== expectedArchiveName) {
    throw new Error(
      `Agent package output must be named ${expectedArchiveName}`
    )
  }
  const staging = mkdtempSync(
    join(tmpdir(), `goodbuddy-agent-package-linux-${architecture}-`)
  )
  try {
    stagePackagePayload({
      staging,
      registry,
      agentLock,
      runtimeLock,
      agentBundle: resolve(options.agentBundle),
      runtimeBundle: runtime.bundleDirectory
    })
    const payload = payloadFiles(staging)
    const initial = {
      format: 'goodbuddy-agent-package',
      formatVersion: 1,
      product: 'GoodBuddy',
      component: 'agent',
      version: agent.manifest.agentVersion,
      minimumDesktopVersion: options.minimumDesktopVersion,
      platform: 'linux',
      architecture,
      signingKeyId: signingIdentity.keyId,
      agentProtocol: agent.manifest.protocol,
      remoteRuntime: {
        runtimeId: runtime.manifest.runtimeId,
        provider: runtime.manifest.provider,
        version: runtime.manifest.runtimeVersion,
        bundleDigest: runtime.manifest.bundleDigest,
        protocol: runtime.manifest.protocol
      },
      contentDigest: `sha256:${'0'.repeat(64)}`,
      files: payload.files
    }
    const descriptor = {
      ...initial,
      contentDigest: descriptorContentDigest(initial)
    }
    const bytes = descriptorBytes(descriptor)
    const signature = sign(
      null,
      Buffer.concat([signatureDomain, bytes]),
      signingIdentity.privateKey
    )
    writeFileSync(join(staging, packageDescriptorName), bytes)
    writeFileSync(
      join(staging, packageSignatureName),
      `${signature.toString('base64')}\n`,
      'utf8'
    )
    const archive = createPackageArchive(
      staging,
      options.output,
      payload.crc32ByPath
    )
    return {
      descriptor,
      archive: basename(options.output),
      size: archive.size,
      sha256: archive.sha256
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function buildAgentPackage(options) {
  const projectRoot = options.projectRoot ?? root
  const registry =
    options.registry ?? readTrustedKeyRegistry(projectRoot)
  const signingIdentity =
    options.testSigningIdentity ??
    options.signingIdentity ??
    productionSigningKey(options.environment ?? process.env)
  const agentRoot = mkdtempSync(
    join(tmpdir(), `goodbuddy-agent-build-${options.architecture}-`)
  )
  const runtimeRoot = mkdtempSync(
    join(tmpdir(), `goodbuddy-runtime-build-${options.architecture}-`)
  )
  try {
    const agentBundle = buildAgentBundle({
      projectRoot,
      arch: options.architecture,
      runtimeArchive: options.nodeArchive,
      outputDirectory: join(agentRoot, 'agent'),
      registry,
      ...(options.agentLock ? { lock: options.agentLock } : {}),
      ...(options.testSigningIdentity
        ? { testSigningIdentity: options.testSigningIdentity }
        : { signingIdentity })
    })
    const runtime = buildRuntimeBundle({
      projectRoot,
      architecture: options.architecture,
      runtimeArchive: options.runtimeArchive,
      outputRoot: runtimeRoot,
      registry,
      ...(options.runtimeLock ? { lock: options.runtimeLock } : {}),
      ...(options.testSigningIdentity
        ? { testSigningIdentity: options.testSigningIdentity }
        : { signingIdentity })
    })
    return assembleAgentPackage({
      ...options,
      projectRoot,
      registry,
      ...(options.testSigningIdentity
        ? {}
        : { signingIdentity }),
      agentBundle,
      runtimeBundle: runtime.bundleDirectory
    })
  } finally {
    rmSync(agentRoot, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
}

function parseArguments(argv) {
  const command = argv[0]
  if (!['build', 'assemble'].includes(command)) {
    throw new Error(
      'Usage: agent-package.cjs <build|assemble> --arch <x64|arm64> --minimum-desktop-version <version> --output <archive>'
    )
  }
  const options = {}
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      ![
        '--arch',
        '--minimum-desktop-version',
        '--node-archive',
        '--runtime-archive',
        '--agent-bundle',
        '--runtime-bundle',
        '--output'
      ].includes(flag) ||
      !value
    ) {
      throw new Error('Invalid Agent package argument')
    }
    options[
      flag.slice(2).replace(/-([a-z])/gu, (_match, valuePart) =>
        valuePart.toUpperCase()
      )
    ] = value
  }
  if (
    !['x64', 'arm64'].includes(options.arch) ||
    !semanticVersionPattern.test(
      options.minimumDesktopVersion ?? ''
    ) ||
    !options.output
  ) {
    throw new Error('Agent package arguments are incomplete')
  }
  const common = {
    architecture: options.arch,
    minimumDesktopVersion: options.minimumDesktopVersion,
    output: resolve(options.output)
  }
  if (command === 'build') {
    if (!options.nodeArchive || !options.runtimeArchive) {
      throw new Error('Agent package build inputs are incomplete')
    }
    return {
      command,
      ...common,
      nodeArchive: resolve(options.nodeArchive),
      runtimeArchive: resolve(options.runtimeArchive)
    }
  }
  if (!options.agentBundle || !options.runtimeBundle) {
    throw new Error('Agent package assembly inputs are incomplete')
  }
  return {
    command,
    ...common,
    agentBundle: resolve(options.agentBundle),
    runtimeBundle: resolve(options.runtimeBundle)
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const result =
    options.command === 'build'
      ? buildAgentPackage(options)
      : assembleAgentPackage(options)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

module.exports = {
  assembleAgentPackage,
  buildAgentPackage,
  canonicalJson,
  descriptorBytes,
  descriptorContentDigest,
  parseArguments,
  signatureDomain
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `${redactSecrets(
        error instanceof Error ? error.message : String(error)
      )}\n`
    )
    process.exitCode = 1
  }
}
