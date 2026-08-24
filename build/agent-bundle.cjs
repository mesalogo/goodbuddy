const {
  createHash,
  createPublicKey,
  sign,
  verify
} = require('node:crypto')
const {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep
} = require('node:path')
const tar = require('tar')
const {
  detectElfArchitecture
} = require('./binary-architecture.cjs')

const root = join(__dirname, '..')
const domainSeparator = Buffer.from(
  'GoodBuddy Agent Bundle Manifest Signature v1\0',
  'utf8'
)
const supportedArchitectures = Object.freeze(['x64', 'arm64'])
const allowedModes = new Set(['0644', '0755'])
const manifestFileName = 'manifest.json'
const signatureFileName = 'manifest.sig'
const koffiPackageName = 'koffi'
const signingPrivateKeyEnvironment =
  'GOODBUDDY_AGENT_SIGNING_PRIVATE_KEY'
const signingKeyIdEnvironment =
  'GOODBUDDY_AGENT_SIGNING_KEY_ID'
const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+((?:[0-9a-zA-Z-]+)(?:\.[0-9a-zA-Z-]+)*))?$/u

function sha256Bytes(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function sha256FileSync(filePath) {
  return sha256Bytes(readFileSync(filePath))
}

function readJson(filePath, description) {
  let value
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `${description} is missing or invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
  return value
}

function readRuntimeLock(projectRoot = root) {
  const lock = readJson(
    join(projectRoot, 'agent-runtime-lock.json'),
    'Agent runtime lock'
  )
  if (
    lock.formatVersion !== 1 ||
    typeof lock.agentVersion !== 'string' ||
    !semanticVersionPattern.test(lock.agentVersion) ||
    lock.node?.version !== '24.19.0' ||
    lock.koffi?.version !== '3.1.4' ||
    !Number.isSafeInteger(lock.protocol?.major) ||
    !Number.isSafeInteger(lock.protocol?.minor)
  ) {
    throw new Error('Agent runtime lock contract is invalid')
  }
  return lock
}

function readTrustedKeyRegistry(projectRoot = root) {
  const registry = readJson(
    join(projectRoot, 'resources', 'agent-release-keys.json'),
    'Agent trusted key registry'
  )
  if (
    registry.formatVersion !== 1 ||
    !Array.isArray(registry.keys) ||
    !Array.isArray(registry.revocations)
  ) {
    throw new Error('Agent trusted key registry contract is invalid')
  }
  const ids = new Set()
  for (const key of registry.keys) {
    if (
      typeof key.keyId !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(key.keyId) ||
      ids.has(key.keyId) ||
      typeof key.publicKeySpkiBase64 !== 'string' ||
      !['production', 'test'].includes(key.environment)
    ) {
      throw new Error('Agent trusted key entry is invalid')
    }
    ids.add(key.keyId)
    try {
      createPublicKey({
        key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
        format: 'der',
        type: 'spki'
      })
    } catch {
      throw new Error(`Agent trusted public key is invalid: ${key.keyId}`)
    }
  }
  return registry
}

function targetName(arch) {
  if (!supportedArchitectures.includes(arch)) {
    throw new Error(`Unsupported Agent architecture: ${arch}`)
  }
  return `linux-${arch}`
}

function lockedRuntimeInput(lock, arch, archivePath) {
  const target = targetName(arch)
  const input = lock.node?.targets?.[target]
  if (
    !input ||
    typeof input.archive !== 'string' ||
    typeof input.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.sha256) ||
    typeof input.binaryPath !== 'string' ||
    typeof input.licensePath !== 'string'
  ) {
    throw new Error(`Locked Node runtime input is missing for ${target}`)
  }
  if (!archivePath || !existsSync(archivePath)) {
    throw new Error(
      `Verified official Node ${lock.node.version} runtime input is required for ${target}: ${input.archive}`
    )
  }
  if (!statSync(archivePath).isFile()) {
    throw new Error(`Node runtime input is not a file: ${archivePath}`)
  }
  if (basename(archivePath) !== input.archive) {
    throw new Error(
      `Node runtime input filename mismatch: expected ${input.archive}`
    )
  }
  const actualDigest = sha256FileSync(archivePath)
  if (actualDigest !== input.sha256) {
    throw new Error(
      `Node runtime input digest mismatch for ${target}: expected ${input.sha256}, received ${actualDigest}`
    )
  }
  return { ...input, target }
}

function assertElfArchitecture(
  filePath,
  expectedArchitecture,
  description = 'Agent Node runtime'
) {
  const actual = detectElfArchitecture(readFileSync(filePath).subarray(0, 64))
  if (actual !== expectedArchitecture) {
    throw new Error(
      `${description} architecture mismatch: expected ${expectedArchitecture}, received ${actual ?? 'unknown'}`
    )
  }
}

function koffiNativePackageName(arch) {
  return `@koromix/koffi-linux-${arch}`
}

function koffiPayloadPaths(arch) {
  const packageRoot = `lib/node_modules/${koffiPackageName}`
  const nativeRoot =
    `lib/node_modules/${koffiNativePackageName(arch)}`
  return {
    packageRoot,
    nativeRoot,
    required: [
      `${packageRoot}/package.json`,
      `${packageRoot}/index.js`,
      `${packageRoot}/src/koffi/index.js`,
      `${packageRoot}/src/koffi/src/static.js`,
      `${nativeRoot}/package.json`,
      `${nativeRoot}/index.js`,
      `${nativeRoot}/linux_${arch}/koffi.node`,
      `${nativeRoot}/musl_${arch}/koffi.node`
    ],
    native: [
      `${nativeRoot}/linux_${arch}/koffi.node`,
      `${nativeRoot}/musl_${arch}/koffi.node`
    ]
  }
}

function assertSafeManifestPath(filePath) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.length > 240 ||
    filePath.includes('\\') ||
    filePath.includes('\0') ||
    posix.isAbsolute(filePath) ||
    filePath.split('/').some(
      (part) => part.length === 0 || part === '.' || part === '..'
    )
  ) {
    throw new Error(`Unsafe Agent manifest path: ${String(filePath)}`)
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8')
  )
}

function listFiles(directory) {
  const files = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareUtf8(right.name, left.name))
    for (const entry of entries) {
      const absolutePath = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Agent bundle cannot contain a symlink: ${absolutePath}`)
      }
      if (entry.isDirectory()) {
        pending.push(absolutePath)
      } else if (entry.isFile()) {
        files.push(absolutePath)
      } else {
        throw new Error(
          `Agent bundle contains an unsupported file: ${absolutePath}`
        )
      }
    }
  }
  return files.sort(compareUtf8)
}

function posixRelative(directory, filePath) {
  return relative(directory, filePath).split(sep).join('/')
}

function modeString(filePath) {
  return (statSync(filePath).mode & 0o777).toString(8).padStart(4, '0')
}

function expectedManifestMode(path) {
  return path === 'node' ||
    path === 'goodbuddy-agent' ||
    path.startsWith('helpers/')
    ? '0755'
    : '0644'
}

function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function createManifest(bundleDirectory, metadata) {
  const files = listFiles(bundleDirectory)
    .filter((filePath) => {
      const name = posixRelative(bundleDirectory, filePath)
      return name !== manifestFileName && name !== signatureFileName
    })
    .map((filePath) => {
      const path = posixRelative(bundleDirectory, filePath)
      assertSafeManifestPath(path)
      const mode = expectedManifestMode(path)
      if (
        process.platform !== 'win32' &&
        modeString(filePath) !== mode
      ) {
        throw new Error(
          `Agent bundle mode must be ${mode}: ${path}`
        )
      }
      return {
        path,
        size: statSync(filePath).size,
        sha256: sha256FileSync(filePath),
        mode
      }
    })
  const licenses = [
    {
      package: 'GoodBuddy Agent',
      version: metadata.agentVersion,
      spdx: '0BSD',
      path: 'licenses/GoodBuddy-0BSD.txt'
    },
    {
      package: 'Node.js',
      version: metadata.nodeVersion,
      spdx: 'MIT',
      path: 'licenses/Node.js-MIT.txt'
    },
    {
      package: 'zod',
      version: metadata.zodVersion,
      spdx: 'MIT',
      path: 'licenses/zod-MIT.txt'
    },
    {
      package: koffiPackageName,
      version: metadata.koffiVersion,
      spdx: 'MIT',
      path: 'licenses/koffi-MIT.txt'
    },
    {
      package: metadata.koffiNativePackage,
      version: metadata.koffiVersion,
      spdx: 'MIT',
      path: 'licenses/koffi-native-MIT.txt'
    }
  ]
  return {
    formatVersion: 1,
    product: 'GoodBuddy',
    agentVersion: metadata.agentVersion,
    platform: 'linux',
    arch: metadata.arch,
    protocol: metadata.protocol,
    signingKeyId: metadata.signingKeyId,
    entrypoint: {
      path: 'goodbuddy-agent',
      runtimePath: 'node',
      scriptPath: 'lib/agent.cjs'
    },
    files,
    licenses
  }
}

function signaturePayload(manifestBytes) {
  return Buffer.concat([domainSeparator, manifestBytes])
}

function signManifestForTest(manifestBytes, privateKey) {
  return sign(null, signaturePayload(manifestBytes), privateKey)
}

function productionSigningKey(environment = process.env) {
  const keyId = environment[signingKeyIdEnvironment]
  const privateKey = environment[signingPrivateKeyEnvironment]
  if (!keyId || !privateKey) {
    throw new Error(
      `${signingKeyIdEnvironment} and ${signingPrivateKeyEnvironment} are required for production Agent signing`
    )
  }
  return { keyId, privateKey }
}

function preflightProductionSigningKey(options = {}) {
  const projectRoot = options.projectRoot ?? root
  const environment = options.environment ?? process.env
  const keyId = options.keyId ?? environment[signingKeyIdEnvironment]
  if (!keyId) {
    throw new Error(
      `${signingKeyIdEnvironment} is not configured; provision the production Agent signing key ID before building a release`
    )
  }
  const registry =
    options.registry ?? readTrustedKeyRegistry(projectRoot)
  const signingRecord = registry.keys.find(
    (key) => key.keyId === keyId
  )
  if (!signingRecord) {
    throw new Error(
      `Production Agent public signing key ID "${keyId}" is absent from resources/agent-release-keys.json; provision the matching public key before building a release`
    )
  }
  if (signingRecord.environment !== 'production') {
    throw new Error(
      `Production Agent signing key ID "${keyId}" is not registered for production`
    )
  }
  if (
    registry.revocations.some(
      (revocation) => revocation.keyId === keyId
    )
  ) {
    throw new Error(
      `Production Agent signing key ID "${keyId}" is revoked`
    )
  }
  return signingRecord
}

function publicKeySpkiBase64(key) {
  const publicKey = key?.type === 'public'
    ? key
    : createPublicKey(key)
  return publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64')
}

function trustedKeyForManifest(
  manifest,
  registry,
  verificationEnvironment = 'production'
) {
  const key = registry.keys.find(
    (candidate) => candidate.keyId === manifest.signingKeyId
  )
  if (!key) {
    throw new Error(
      `Agent manifest uses an unknown signing key: ${manifest.signingKeyId}`
    )
  }
  if (
    verificationEnvironment === 'production' &&
    key.environment !== 'production'
  ) {
    throw new Error(
      `Production Agent verification rejects non-production key: ${key.keyId}`
    )
  }
  const revocation = registry.revocations.find(
    (candidate) => candidate.keyId === key.keyId
  )
  if (revocation) {
    throw new Error(`Agent signing key is revoked: ${key.keyId}`)
  }
  return key
}

function validateManifestShape(manifest, expected) {
  if (
    manifest?.formatVersion !== 1 ||
    manifest.product !== 'GoodBuddy' ||
    typeof manifest.agentVersion !== 'string' ||
    !semanticVersionPattern.test(manifest.agentVersion) ||
    manifest.platform !== 'linux' ||
    !supportedArchitectures.includes(manifest.arch) ||
    !Number.isSafeInteger(manifest.protocol?.major) ||
    !Number.isSafeInteger(manifest.protocol?.minor) ||
    typeof manifest.signingKeyId !== 'string' ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.licenses)
  ) {
    throw new Error('Agent manifest contract is invalid')
  }
  if (
    manifest.entrypoint?.path !== 'goodbuddy-agent' ||
    manifest.entrypoint?.runtimePath !== 'node' ||
    manifest.entrypoint?.scriptPath !== 'lib/agent.cjs'
  ) {
    throw new Error('Agent manifest entrypoint is invalid')
  }
  if (expected) {
    for (const [field, value] of Object.entries(expected)) {
      if (field === 'protocol') {
        if (
          manifest.protocol.major !== value.major ||
          manifest.protocol.minor !== value.minor
        ) {
          throw new Error('Agent manifest protocol does not match the lock')
        }
      } else if (manifest[field] !== value) {
        throw new Error(
          `Agent manifest ${field} does not match the locked value`
        )
      }
    }
  }
}

function verifyManifestSignature(
  manifestBytes,
  signatureBytes,
  registry,
  options = {}
) {
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new Error('Agent manifest JSON is invalid')
  }
  validateManifestShape(manifest, options.expected)
  if (!canonicalManifestBytes(manifest).equals(manifestBytes)) {
    throw new Error('Agent manifest is not in canonical deterministic form')
  }
  const key = trustedKeyForManifest(
    manifest,
    registry,
    options.verificationEnvironment
  )
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  if (
    signatureBytes.length !== 64 ||
    !verify(
      null,
      signaturePayload(manifestBytes),
      publicKey,
      signatureBytes
    )
  ) {
    throw new Error('Agent manifest signature verification failed')
  }
  return manifest
}

function verifyBundleDirectory(bundleDirectory, options = {}) {
  const manifestPath = join(bundleDirectory, manifestFileName)
  const signaturePath = join(bundleDirectory, signatureFileName)
  const manifestBytes = readFileSync(manifestPath)
  const signatureText = readFileSync(signaturePath, 'utf8')
  if (!/^[A-Za-z0-9+/]{86}==\n$/u.test(signatureText)) {
    throw new Error('Agent detached signature encoding is invalid')
  }
  const registry =
    options.registry ?? readTrustedKeyRegistry(options.projectRoot)
  const manifest = verifyManifestSignature(
    manifestBytes,
    Buffer.from(signatureText.trim(), 'base64'),
    registry,
    options
  )
  const declaredPaths = new Set()
  for (const file of manifest.files) {
    assertSafeManifestPath(file.path)
    if (
      declaredPaths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !allowedModes.has(file.mode)
    ) {
      throw new Error(`Agent manifest file entry is invalid: ${file.path}`)
    }
    if (file.mode !== expectedManifestMode(file.path)) {
      throw new Error(`Agent payload mode mismatch: ${file.path}`)
    }
    declaredPaths.add(file.path)
    const filePath = join(bundleDirectory, ...file.path.split('/'))
    const entryStat = lstatSync(filePath)
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new Error(`Agent payload is not a regular file: ${file.path}`)
    }
    if (entryStat.size !== file.size) {
      throw new Error(`Agent payload size mismatch: ${file.path}`)
    }
    if (sha256FileSync(filePath) !== file.sha256) {
      throw new Error(`Agent payload hash mismatch: ${file.path}`)
    }
    if (
      options.enforceFilesystemMode !== false &&
      process.platform !== 'win32' &&
      modeString(filePath) !== file.mode
    ) {
      throw new Error(`Agent payload mode mismatch: ${file.path}`)
    }
  }
  const actualPaths = new Set(
    listFiles(bundleDirectory).map((filePath) =>
      posixRelative(bundleDirectory, filePath)
    )
  )
  const expectedPaths = new Set([
    ...declaredPaths,
    manifestFileName,
    signatureFileName
  ])
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((filePath) => !expectedPaths.has(filePath))
  ) {
    throw new Error('Agent bundle contains undeclared or missing files')
  }
  const licensedPaths = new Set()
  for (const license of manifest.licenses) {
    assertSafeManifestPath(license.path)
    if (
      typeof license.package !== 'string' ||
      typeof license.version !== 'string' ||
      typeof license.spdx !== 'string' ||
      licensedPaths.has(license.path) ||
      !declaredPaths.has(license.path)
    ) {
      throw new Error('Agent manifest license entry is invalid')
    }
    licensedPaths.add(license.path)
  }
  for (const required of [
    manifest.entrypoint.path,
    manifest.entrypoint.runtimePath,
    manifest.entrypoint.scriptPath
  ]) {
    if (!declaredPaths.has(required)) {
      throw new Error(`Agent entrypoint payload is missing: ${required}`)
    }
  }
  const koffiPaths = koffiPayloadPaths(manifest.arch)
  for (const required of koffiPaths.required) {
    if (!declaredPaths.has(required)) {
      throw new Error(`Agent Koffi payload is missing: ${required}`)
    }
  }
  const koffiLicense = manifest.licenses.find(
    (license) => license.package === koffiPackageName
  )
  const nativePackage = koffiNativePackageName(manifest.arch)
  const nativeLicense = manifest.licenses.find(
    (license) => license.package === nativePackage
  )
  if (
    koffiLicense?.spdx !== 'MIT' ||
    koffiLicense.path !== 'licenses/koffi-MIT.txt' ||
    nativeLicense?.spdx !== 'MIT' ||
    nativeLicense.path !== 'licenses/koffi-native-MIT.txt' ||
    nativeLicense.version !== koffiLicense.version
  ) {
    throw new Error('Agent Koffi license declaration is invalid')
  }
  assertElfArchitecture(
    join(bundleDirectory, manifest.entrypoint.runtimePath),
    manifest.arch
  )
  for (const nativePath of koffiPaths.native) {
    assertElfArchitecture(
      join(bundleDirectory, ...nativePath.split('/')),
      manifest.arch,
      'Agent Koffi native binding'
    )
  }
  return {
    manifest,
    manifestSha256: sha256Bytes(manifestBytes)
  }
}

function assertReplaceableBundle(directory) {
  if (!existsSync(directory) || readdirSync(directory).length === 0) {
    return
  }
  try {
    const manifest = readJson(
      join(directory, manifestFileName),
      'Existing Agent manifest'
    )
    if (
      manifest.formatVersion === 1 &&
      manifest.product === 'GoodBuddy' &&
      manifest.platform === 'linux'
    ) {
      return
    }
  } catch {
    // Use the explicit refusal below.
  }
  throw new Error(`Refusing to replace unrecognized Agent directory: ${directory}`)
}

function replaceBundle(staging, destination) {
  assertReplaceableBundle(destination)
  const backup = `${destination}.previous-${process.pid}`
  rmSync(backup, { recursive: true, force: true })
  if (existsSync(destination)) {
    renameSync(destination, backup)
  }
  try {
    renameSync(staging, destination)
  } catch (error) {
    if (!existsSync(destination) && existsSync(backup)) {
      renameSync(backup, destination)
    }
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
}

function copyLicense(source, destination) {
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`Required Agent bundle license is missing: ${source}`)
  }
  copyFileSync(source, destination)
  chmodSync(destination, 0o644)
}

function copyRegularFile(source, destination) {
  if (
    !existsSync(source) ||
    !lstatSync(source).isFile() ||
    lstatSync(source).isSymbolicLink()
  ) {
    throw new Error(`Required Agent dependency file is missing: ${source}`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  chmodSync(destination, 0o644)
}

function copyKoffiRuntime(projectRoot, staging, arch, lockedVersion) {
  const sourceRoot = join(projectRoot, 'node_modules', koffiPackageName)
  const packageMetadata = readJson(
    join(sourceRoot, 'package.json'),
    'Koffi package metadata'
  )
  const nativePackage = koffiNativePackageName(arch)
  const nativeSourceRoot = join(
    projectRoot,
    'node_modules',
    ...nativePackage.split('/')
  )
  const nativeMetadata = readJson(
    join(nativeSourceRoot, 'package.json'),
    'Koffi native package metadata'
  )
  if (
    packageMetadata.name !== koffiPackageName ||
    packageMetadata.version !== lockedVersion ||
    nativeMetadata.name !== nativePackage ||
    nativeMetadata.version !== lockedVersion ||
    !Array.isArray(nativeMetadata.os) ||
    !nativeMetadata.os.includes('linux') ||
    !Array.isArray(nativeMetadata.cpu) ||
    !nativeMetadata.cpu.includes(arch)
  ) {
    throw new Error(
      `Koffi dependencies do not match the locked ${nativePackage}@${lockedVersion}`
    )
  }

  const paths = koffiPayloadPaths(arch)
  const files = [
    ['package.json', `${paths.packageRoot}/package.json`],
    ['index.js', `${paths.packageRoot}/index.js`],
    [
      'src/koffi/index.js',
      `${paths.packageRoot}/src/koffi/index.js`
    ],
    [
      'src/koffi/src/static.js',
      `${paths.packageRoot}/src/koffi/src/static.js`
    ]
  ]
  for (const [source, destination] of files) {
    copyRegularFile(
      join(sourceRoot, ...source.split('/')),
      join(staging, ...destination.split('/'))
    )
  }
  for (const source of [
    'package.json',
    'index.js',
    `linux_${arch}/koffi.node`,
    `musl_${arch}/koffi.node`
  ]) {
    const destination = `${paths.nativeRoot}/${source}`
    copyRegularFile(
      join(nativeSourceRoot, ...source.split('/')),
      join(staging, ...destination.split('/'))
    )
  }
  for (const nativePath of paths.native) {
    assertElfArchitecture(
      join(staging, ...nativePath.split('/')),
      arch,
      'Agent Koffi native binding'
    )
  }
  return {
    version: lockedVersion,
    nativePackage
  }
}

function buildAgentBundle(options) {
  const projectRoot = options.projectRoot ?? root
  const arch = options.arch
  const lock = options.lock ?? readRuntimeLock(projectRoot)
  const runtimeInput = lockedRuntimeInput(
    lock,
    arch,
    options.runtimeArchive
  )
  const registry =
    options.registry ?? readTrustedKeyRegistry(projectRoot)
  const signingEnvironment = options.environment ?? process.env
  const signingIdentity =
    options.testSigningIdentity ?? productionSigningKey(signingEnvironment)
  const signingRecord = options.testSigningIdentity
    ? registry.keys.find(
        (key) => key.keyId === signingIdentity.keyId
      )
    : preflightProductionSigningKey({
        projectRoot,
        registry,
        lock,
        environment: signingEnvironment,
        keyId: signingIdentity.keyId
      })
  if (!signingRecord) {
    throw new Error(
      `Agent test signing key is not registered: ${signingIdentity.keyId}`
    )
  }
  if (
    publicKeySpkiBase64(signingIdentity.privateKey) !==
    signingRecord.publicKeySpkiBase64
  ) {
    throw new Error('Agent signing private key does not match the trusted key')
  }
  if (
    !options.testSigningIdentity &&
    signingEnvironment === process.env
  ) {
    delete process.env[signingPrivateKeyEnvironment]
    delete process.env[signingKeyIdEnvironment]
  }

  const destination =
    options.outputDirectory ??
    join(projectRoot, '.agent-resources', targetName(arch))
  mkdirSync(dirname(destination), { recursive: true })
  const staging = mkdtempSync(
    join(dirname(destination), `.stage-${targetName(arch)}-`)
  )
  const runtimeStaging = mkdtempSync(
    join(tmpdir(), `goodbuddy-node-${targetName(arch)}-`)
  )
  try {
    tar.x({
      file: options.runtimeArchive,
      cwd: runtimeStaging,
      sync: true,
      strict: true,
      filter(path) {
        return (
          path === runtimeInput.binaryPath ||
          path === runtimeInput.licensePath
        )
      }
    })
    const runtimeBinary = join(
      runtimeStaging,
      ...runtimeInput.binaryPath.split('/')
    )
    const runtimeLicense = join(
      runtimeStaging,
      ...runtimeInput.licensePath.split('/')
    )
    assertElfArchitecture(runtimeBinary, arch)
    copyFileSync(runtimeBinary, join(staging, 'node'))
    chmodSync(join(staging, 'node'), 0o755)

    mkdirSync(join(staging, 'lib'), { recursive: true })
    const esbuild = require('esbuild')
    esbuild.buildSync({
      stdin: {
        contents: [
          "import { runAgentCli } from './src/agent-daemon/cli.ts'",
          'void runAgentCli(process.argv.slice(2)).then(',
          '  (code) => { process.exitCode = code },',
          '  () => {',
          "    process.stderr.write('Agent startup failed\\n')",
          '    process.exitCode = 2',
          '  }',
          ')',
          ''
        ].join('\n'),
        loader: 'ts',
        resolveDir: projectRoot,
        sourcefile: 'goodbuddy-agent-cjs-entry.ts'
      },
      outfile: join(staging, 'lib', 'agent.cjs'),
      bundle: true,
      platform: 'node',
      target: ['node24.19'],
      format: 'cjs',
      packages: 'bundle',
      external: [koffiPackageName],
      sourcemap: false,
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'silent'
    })
    chmodSync(join(staging, 'lib', 'agent.cjs'), 0o644)
    const koffi = copyKoffiRuntime(
      projectRoot,
      staging,
      arch,
      lock.koffi.version
    )
    const launcher = [
      '#!/bin/sh',
      'set -eu',
      'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'exec "$SCRIPT_DIR/node" "$SCRIPT_DIR/lib/agent.cjs" "$@"',
      ''
    ].join('\n')
    writeFileSync(join(staging, 'goodbuddy-agent'), launcher, 'utf8')
    chmodSync(join(staging, 'goodbuddy-agent'), 0o755)

    mkdirSync(join(staging, 'licenses'), { recursive: true })
    copyLicense(
      join(projectRoot, 'LICENSE'),
      join(staging, 'licenses', 'GoodBuddy-0BSD.txt')
    )
    copyLicense(
      runtimeLicense,
      join(staging, 'licenses', 'Node.js-MIT.txt')
    )
    copyLicense(
      join(projectRoot, 'node_modules', 'zod', 'LICENSE'),
      join(staging, 'licenses', 'zod-MIT.txt')
    )
    copyLicense(
      join(projectRoot, 'node_modules', 'koffi', 'LICENSE.txt'),
      join(staging, 'licenses', 'koffi-MIT.txt')
    )
    copyLicense(
      join(projectRoot, 'node_modules', 'koffi', 'LICENSE.txt'),
      join(staging, 'licenses', 'koffi-native-MIT.txt')
    )
    const zodPackage = readJson(
      join(projectRoot, 'node_modules', 'zod', 'package.json'),
      'zod package metadata'
    )
    const manifest = createManifest(staging, {
      agentVersion: lock.agentVersion,
      nodeVersion: lock.node.version,
      zodVersion: zodPackage.version,
      koffiVersion: koffi.version,
      koffiNativePackage: koffi.nativePackage,
      arch,
      protocol: lock.protocol,
      signingKeyId: signingIdentity.keyId
    })
    const manifestBytes = canonicalManifestBytes(manifest)
    const signatureBytes = sign(
      null,
      signaturePayload(manifestBytes),
      signingIdentity.privateKey
    )
    writeFileSync(join(staging, manifestFileName), manifestBytes)
    writeFileSync(
      join(staging, signatureFileName),
      `${signatureBytes.toString('base64')}\n`,
      'utf8'
    )
    chmodSync(join(staging, manifestFileName), 0o644)
    chmodSync(join(staging, signatureFileName), 0o644)
    verifyBundleDirectory(staging, {
      registry,
      verificationEnvironment: options.testSigningIdentity
        ? 'test'
        : 'production',
      expected: {
        agentVersion: lock.agentVersion,
        arch,
        protocol: lock.protocol
      }
    })
    replaceBundle(staging, destination)
    return destination
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(runtimeStaging, { recursive: true, force: true })
  }
}

function createAgentArchive(bundleDirectory, archivePath) {
  const entries = listFiles(bundleDirectory)
    .map((filePath) => posixRelative(bundleDirectory, filePath))
    .sort(compareUtf8)
  mkdirSync(dirname(archivePath), { recursive: true })
  rmSync(archivePath, { force: true })
  tar.c({
    cwd: bundleDirectory,
    file: archivePath,
    sync: true,
    portable: true,
    noPax: true,
    mtime: new Date(0)
  }, entries)
}

function importAgentArchive(archivePath, options = {}) {
  if (!existsSync(archivePath)) {
    throw new Error(`Agent artifact archive is missing: ${archivePath}`)
  }
  const projectRoot = options.projectRoot ?? root
  const arch = options.arch
  const destination =
    options.outputDirectory ??
    join(projectRoot, '.agent-resources', targetName(arch))
  mkdirSync(dirname(destination), { recursive: true })
  const staging = mkdtempSync(
    join(dirname(destination), `.import-${targetName(arch)}-`)
  )
  try {
    tar.x({
      cwd: staging,
      file: archivePath,
      sync: true,
      strict: true,
      preservePaths: false
    })
    verifyLockedBundle(staging, arch, {
      projectRoot,
      registry: options.registry
    })
    replaceBundle(staging, destination)
    return destination
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function verifyLockedBundle(bundleDirectory, arch, options = {}) {
  const projectRoot = options.projectRoot ?? root
  const lock = options.lock ?? readRuntimeLock(projectRoot)
  return verifyBundleDirectory(bundleDirectory, {
    registry:
      options.registry ?? readTrustedKeyRegistry(projectRoot),
    verificationEnvironment: options.verificationEnvironment ?? 'production',
    expected: {
      agentVersion: lock.agentVersion,
      arch,
      protocol: lock.protocol
    }
  })
}

function verifyAgentBundleMatrix(resourcesRoot, options = {}) {
  const projectRoot = options.projectRoot ?? root
  const registryPath =
    options.registryPath ??
    join(projectRoot, 'resources', 'agent-release-keys.json')
  const lockPath =
    options.lockPath ??
    join(projectRoot, 'agent-runtime-lock.json')
  const registry = readJson(registryPath, 'Agent trusted key registry')
  const lock = readJson(lockPath, 'Agent runtime lock')
  for (const arch of supportedArchitectures) {
    verifyLockedBundle(
      join(resourcesRoot, targetName(arch)),
      arch,
      {
        projectRoot,
        registry,
        lock,
        verificationEnvironment: 'production'
      }
    )
  }
}

function redactSecrets(value, environment = process.env) {
  let redacted = String(value)
  for (const secret of [
    environment[signingPrivateKeyEnvironment],
    environment[signingKeyIdEnvironment]
  ]) {
    if (secret && secret.length >= 4) {
      redacted = redacted.split(secret).join('[redacted]')
    }
  }
  return redacted
    .replace(
      /-----BEGIN (?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END (?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/gu,
      '[redacted private key]'
    )
    .replace(
      /((?:private[_-]?key|signing[_-]?key|authorization|password|token)\s*[:=]\s*)\S+/giu,
      '$1[redacted]'
    )
}

function parseArguments(argv) {
  const command = argv[0]
  const options = {}
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (['--arch', '--runtime-archive', '--archive', '--output'].includes(argument)) {
      const value = argv[index + 1]
      if (!value) {
        throw new Error(`${argument} requires a value`)
      }
      options[argument.slice(2).replaceAll('-', '')] = value
      index += 1
    } else {
      throw new Error(`Unknown Agent bundle argument: ${argument}`)
    }
  }
  if (!['build', 'import', 'verify', 'preflight'].includes(command)) {
    throw new Error('Usage: agent-bundle.cjs <build|import|verify|preflight> --arch <x64|arm64>')
  }
  if (command === 'preflight') {
    if (Object.keys(options).length > 0) {
      throw new Error('Agent signing preflight does not accept arguments')
    }
    return { command }
  }
  targetName(options.arch)
  return { command, ...options }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.command === 'preflight') {
    const signingRecord = preflightProductionSigningKey()
    console.log(
      `Production Agent signing registry preflight passed: ${signingRecord.keyId}`
    )
    return
  }
  if (options.command === 'build') {
    const outputDirectory = buildAgentBundle({
      arch: options.arch,
      runtimeArchive: resolve(options.runtimearchive ?? ''),
      outputDirectory: options.output
        ? resolve(options.output)
        : undefined
    })
    const archivePath = options.archive
      ? resolve(options.archive)
      : join(
          root,
          'dist',
          'agent-bundles',
          `goodbuddy-agent-${targetName(options.arch)}.tar`
        )
    createAgentArchive(outputDirectory, archivePath)
    console.log(`Agent bundle built and verified: ${targetName(options.arch)}`)
    return
  }
  if (options.command === 'import') {
    importAgentArchive(resolve(options.archive ?? ''), {
      arch: options.arch,
      outputDirectory: options.output
        ? resolve(options.output)
        : undefined
    })
    console.log(`Agent bundle imported and verified: ${targetName(options.arch)}`)
    return
  }
  verifyLockedBundle(
    options.output
      ? resolve(options.output)
      : join(root, '.agent-resources', targetName(options.arch)),
    options.arch
  )
  console.log(`Agent bundle verified: ${targetName(options.arch)}`)
}

module.exports = {
  assertElfArchitecture,
  assertSafeManifestPath,
  buildAgentBundle,
  canonicalManifestBytes,
  createAgentArchive,
  createManifest,
  detectElfArchitecture,
  importAgentArchive,
  lockedRuntimeInput,
  preflightProductionSigningKey,
  productionSigningKey,
  publicKeySpkiBase64,
  readRuntimeLock,
  readTrustedKeyRegistry,
  redactSecrets,
  signManifestForTest,
  signaturePayload,
  supportedArchitectures,
  targetName,
  verifyAgentBundleMatrix,
  verifyBundleDirectory,
  verifyLockedBundle,
  verifyManifestSignature
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(
      redactSecrets(error instanceof Error ? error.message : String(error))
    )
    process.exitCode = 1
  }
}
