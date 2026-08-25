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
const { Zip, ZipPassThrough } = require('fflate')
const {
  buildAgentBundle,
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

const root = join(__dirname, '..')
const packageDescriptorName = 'agent-package.json'
const packageSignatureName = 'agent-package.sig'
const signatureDomain = Buffer.from(
  'GoodBuddy Agent Package Descriptor Signature v1\0',
  'utf8'
)
const archiveEpoch = new Date('1980-01-01T00:00:00.000Z')
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

function sha256File(filePath) {
  const hash = createHash('sha256')
  const handle = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
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
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(handle)
  }
  return hash.digest('hex')
}

function copyTree(source, destination) {
  for (const filePath of listFiles(source)) {
    const name = relative(source, filePath).split(sep).join('/')
    const target = join(destination, ...name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(filePath, target)
  }
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
  return listFiles(staging)
    .map((filePath) => {
      const path = relative(staging, filePath).split(sep).join('/')
      const size = statSync(filePath).size
      return {
        path,
        size,
        sha256: sha256File(filePath),
        mode:
          path === 'agent/goodbuddy-agent' ||
          path === 'agent/node' ||
          /\/bin\/opencode$/u.test(path)
            ? '0755'
            : '0644'
      }
    })
    .filter(
      (file) =>
        file.path !== packageDescriptorName &&
        file.path !== packageSignatureName
    )
}

function createPackageArchive(staging, output) {
  mkdirSync(dirname(output), { recursive: true })
  const outputHandle = openSync(output, 'w')
  let archiveError
  let completed = false
  const archive = new Zip((error, data, final) => {
    if (error) {
      archiveError ??= error
      return
    }
    let offset = 0
    while (offset < data.byteLength) {
      const written = writeSync(
        outputHandle,
        data,
        offset,
        data.byteLength - offset
      )
      if (written <= 0) {
        archiveError ??= new Error(
          'Agent package archive write made no progress'
        )
        return
      }
      offset += written
    }
    completed ||= final
  })
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (const filePath of listFiles(staging)) {
      const name = relative(staging, filePath).split(sep).join('/')
      const input = new ZipPassThrough(name)
      input.mtime = archiveEpoch
      archive.add(input)
      const inputHandle = openSync(filePath, 'r')
      const fileSize = statSync(filePath).size
      try {
        let position = 0
        if (fileSize === 0) {
          input.push(new Uint8Array(), true)
        }
        while (position < fileSize) {
          const bytesRead = readSync(
            inputHandle,
            buffer,
            0,
            buffer.length,
            null
          )
          if (bytesRead <= 0) {
            throw new Error(
              `Agent package source read made no progress: ${name}`
            )
          }
          position += bytesRead
          input.push(
            Uint8Array.from(buffer.subarray(0, bytesRead)),
            position === fileSize
          )
        }
      } finally {
        closeSync(inputHandle)
      }
      if (archiveError) {
        throw archiveError
      }
    }
    archive.end()
    if (archiveError) {
      throw archiveError
    }
    if (!completed) {
      throw new Error('Agent package archive did not finish')
    }
    fsyncSync(outputHandle)
  } catch (error) {
    archive.terminate()
    throw error
  } finally {
    closeSync(outputHandle)
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
      files: payloadFiles(staging)
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
    createPackageArchive(staging, options.output)
    return {
      descriptor,
      archive: basename(options.output),
      size: statSync(options.output).size,
      sha256: sha256File(options.output)
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
