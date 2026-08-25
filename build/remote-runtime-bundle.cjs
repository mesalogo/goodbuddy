const {
  createHash,
  createPublicKey,
  sign,
  verify
} = require('node:crypto')
const {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
const {
  preflightRegisteredProductionKey
} = require('./signing-key-preflight.cjs')

const root = join(__dirname, '..')
const supportedArchitectures = Object.freeze(['x64', 'arm64'])
const manifestFileName = 'manifest.json'
const signatureFileName = 'manifest.sig'
const signingPrivateKeyEnvironment =
  'GOODBUDDY_SIGNING_PRIVATE_KEY'
const signingKeyIdEnvironment =
  'GOODBUDDY_SIGNING_KEY_ID'
const signatureDomain = Buffer.from(
  'GoodBuddy Remote Runtime Bundle Manifest Signature v1\0',
  'utf8'
)
const profileDigests = Object.freeze({
  adapter:
    'sha256:ac7696abe504bbea444d8ad80dd8faa96437e6dbb27ed987ce46e1045f3dd365',
  acp:
    'sha256:0e3764ab897258bc0234162357c2eefc3faeb9918080ae81b60e2084ed7996a6'
})
const fixedLimits = Object.freeze({
  maximumPromptRuntimeMilliseconds: 10 * 60 * 1000,
  maximumPromptInputBytes: 16 * 1024 * 1024,
  maximumPromptOutputBytes: 8 * 1024 * 1024
})

function readJson(filePath, description) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `${description} is missing or invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
}

function readRemoteRuntimeLock(projectRoot = root) {
  const lock = readJson(
    join(projectRoot, 'remote-runtime-lock.json'),
    'Remote Runtime lock'
  )
  const runtime = lock?.runtimes?.opencode
  if (
    lock?.formatVersion !== 1 ||
    runtime?.version !== '1.18.9' ||
    runtime.provider !== 'opencode' ||
    runtime.entrypoint !== 'bin/opencode' ||
    runtime.entrypointIdentity !== 'opencode-acp' ||
    JSON.stringify(runtime.argvPrefix) !== JSON.stringify(['acp']) ||
    !Number.isSafeInteger(runtime.protocol?.major) ||
    !Number.isSafeInteger(runtime.protocol?.minor)
  ) {
    throw new Error('Remote Runtime lock contract is invalid')
  }
  for (const architecture of supportedArchitectures) {
    const target = runtime.targets?.[architecture]
    if (
      typeof target?.package !== 'string' ||
      typeof target.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(target.integrity)
    ) {
      throw new Error(
        `Remote Runtime lock target is invalid: ${architecture}`
      )
    }
  }
  return lock
}

function readTrustedKeyRegistry(projectRoot = root) {
  const registry = readJson(
    join(projectRoot, 'resources', 'agent-release-keys.json'),
    'Runtime trusted key registry'
  )
  if (
    registry?.formatVersion !== 1 ||
    !Array.isArray(registry.keys) ||
    !Array.isArray(registry.revocations)
  ) {
    throw new Error('Runtime trusted key registry contract is invalid')
  }
  const keyIds = new Set()
  for (const key of registry.keys) {
    if (
      typeof key?.keyId !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(key.keyId) ||
      keyIds.has(key.keyId) ||
      typeof key.publicKeySpkiBase64 !== 'string' ||
      !['production', 'test'].includes(key.environment)
    ) {
      throw new Error('Runtime trusted key registry entry is invalid')
    }
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`Runtime trusted key is not Ed25519: ${key.keyId}`)
    }
    keyIds.add(key.keyId)
  }
  return registry
}

function targetName(architecture) {
  if (!supportedArchitectures.includes(architecture)) {
    throw new Error(`Unsupported Runtime architecture: ${architecture}`)
  }
  return `linux-${architecture}`
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function sha512FileIntegrity(filePath) {
  const hash = createHash('sha512')
  const descriptor = openSync(filePath, 'r')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const bytesRead = readSync(
        descriptor,
        chunk,
        0,
        chunk.byteLength,
        null
      )
      if (bytesRead === 0) {
        break
      }
      hash.update(chunk.subarray(0, bytesRead))
    }
  } finally {
    closeSync(descriptor)
  }
  return `sha512-${hash.digest('base64')}`
}

function sha256FileSync(filePath) {
  return sha256(readFileSync(filePath))
}

function canonicalJson(value) {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical Runtime value is not finite')
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error('Canonical Runtime value is not plain JSON')
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )
    .join(',')}}`
}

function digestCanonicalOperation({ method, scope, payload }) {
  return `sha256:${sha256(
    Buffer.from(canonicalJson({ method, payload, scope }), 'utf8')
  )}`
}

function digestRuntimeBundleIdentity(manifest) {
  const { bundleDigest: _bundleDigest, ...identity } = manifest
  void _bundleDigest
  return digestCanonicalOperation({
    method: 'runtime/bundleIdentity',
    scope: {
      kind: 'installation',
      installationId: manifest.runtimeId
    },
    payload: identity
  })
}

function digestRuntimeBundleManifest(manifest) {
  return digestCanonicalOperation({
    method: 'runtime/bundleManifest',
    scope: {
      kind: 'installation',
      installationId: manifest.runtimeId
    },
    payload: manifest
  })
}

function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function signaturePayload(manifestBytes) {
  return Buffer.concat([signatureDomain, manifestBytes])
}

function publicKeySpkiBase64(key) {
  return createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .toString('base64')
}

function productionSigningIdentity(environment = process.env) {
  const keyId = environment[signingKeyIdEnvironment]
  const privateKey = environment[signingPrivateKeyEnvironment]
  if (!keyId || !privateKey) {
    throw new Error(
      `${signingKeyIdEnvironment} and ${signingPrivateKeyEnvironment} are required to sign the bundled Runtime`
    )
  }
  return { keyId, privateKey }
}

function trustedKeyForSigning(
  signingIdentity,
  registry,
  verificationEnvironment
) {
  const record = registry.keys.find(
    (key) => key.keyId === signingIdentity.keyId
  )
  if (!record) {
    throw new Error(
      `Runtime signing key is not registered: ${signingIdentity.keyId}`
    )
  }
  if (
    verificationEnvironment === 'production' &&
    record.environment !== 'production'
  ) {
    throw new Error(
      `Runtime signing key is not registered for production: ${record.keyId}`
    )
  }
  if (
    registry.revocations.some(
      (revocation) => revocation.keyId === record.keyId
    )
  ) {
    throw new Error('Runtime signing key is outside its trusted interval')
  }
  if (
    publicKeySpkiBase64(signingIdentity.privateKey) !==
    record.publicKeySpkiBase64
  ) {
    throw new Error(
      'Runtime signing private key does not match the trusted registry'
    )
  }
  return record
}

function preflightProductionSigningKey(options = {}) {
  const projectRoot = options.projectRoot ?? root
  const environment = options.environment ?? process.env
  const keyId =
    options.keyId ?? environment[signingKeyIdEnvironment]
  const registry =
    options.registry ?? readTrustedKeyRegistry(projectRoot)
  return preflightRegisteredProductionKey({
    component: 'GoodBuddy',
    keyId,
    registry,
    missingKeyIdMessage:
      `${signingKeyIdEnvironment} is not configured; provision the production GoodBuddy signing key ID before building a release`
  })
}

function assertSafeManifestPath(filePath) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.length > 240 ||
    filePath.includes('\\') ||
    filePath.includes('\0') ||
    posix.isAbsolute(filePath) ||
    filePath
      .split('/')
      .some(
        (part) => part.length === 0 || part === '.' || part === '..'
      )
  ) {
    throw new Error(`Unsafe Runtime manifest path: ${String(filePath)}`)
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
    const entries = readdirSync(current, {
      withFileTypes: true
    }).sort((left, right) => compareUtf8(right.name, left.name))
    for (const entry of entries) {
      const absolutePath = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Runtime bundle cannot contain a symlink: ${absolutePath}`
        )
      }
      if (entry.isDirectory()) {
        pending.push(absolutePath)
      } else if (entry.isFile()) {
        files.push(absolutePath)
      } else {
        throw new Error(
          `Runtime bundle contains an unsupported file: ${absolutePath}`
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
  return (statSync(filePath).mode & 0o777)
    .toString(8)
    .padStart(4, '0')
}

function assertElfArchitecture(filePath, expectedArchitecture) {
  const actual = detectElfArchitecture(
    readFileSync(filePath).subarray(0, 64)
  )
  if (actual !== expectedArchitecture) {
    throw new Error(
      `Runtime architecture mismatch: expected ${expectedArchitecture}, received ${actual ?? 'unknown'}`
    )
  }
}

function validateManifestShape(manifest) {
  if (
    manifest?.formatVersion !== 2 ||
    manifest.product !== 'GoodBuddy' ||
    manifest.runtimeId !== 'opencode' ||
    manifest.runtimeVersion !== '1.18.9' ||
    manifest.provider !== 'opencode' ||
    manifest.platform !== 'linux' ||
    !supportedArchitectures.includes(manifest.architecture) ||
    typeof manifest.signingKeyId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.bundleDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.adapterDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(
      manifest.acpCapabilitiesDigest
    ) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.licenses) ||
    !Array.isArray(manifest.allowedEnvironmentNames)
  ) {
    throw new Error('Runtime manifest contract is invalid')
  }
  if (
    !Number.isSafeInteger(
      manifest.limits?.maximumPromptRuntimeMilliseconds
    ) ||
    manifest.limits.maximumPromptRuntimeMilliseconds < 1 ||
    !Number.isSafeInteger(manifest.limits.maximumPromptInputBytes) ||
    manifest.limits.maximumPromptInputBytes < 1 ||
    !Number.isSafeInteger(manifest.limits.maximumPromptOutputBytes) ||
    manifest.limits.maximumPromptOutputBytes < 0 ||
    Object.keys(manifest.limits).length !== 3 ||
    'quotas' in manifest
  ) {
    throw new Error('Runtime manifest limits contract is invalid')
  }
  if (
    manifest.entrypoint?.identity !== 'opencode-acp' ||
    manifest.entrypoint.path !== 'bin/opencode' ||
    !/^[a-f0-9]{64}$/u.test(manifest.entrypoint.sha256) ||
    JSON.stringify(manifest.entrypoint.argvPrefix) !==
      JSON.stringify(['acp'])
  ) {
    throw new Error('Runtime manifest entrypoint is invalid')
  }
}

function trustedKeyForManifest(
  manifest,
  registry,
  verificationEnvironment
) {
  const key = registry.keys.find(
    (candidate) => candidate.keyId === manifest.signingKeyId
  )
  if (!key) {
    throw new Error(
      `Runtime manifest uses an unknown signing key: ${manifest.signingKeyId}`
    )
  }
  if (
    verificationEnvironment === 'production' &&
    key.environment !== 'production'
  ) {
    throw new Error(
      `Production Runtime verification rejects non-production key: ${key.keyId}`
    )
  }
  if (
    registry.revocations.some(
      (revocation) => revocation.keyId === key.keyId
    )
  ) {
    throw new Error('Runtime signing key is outside its trusted interval')
  }
  return key
}

function assertManifestMatchesLock(manifest, lock, architecture) {
  const expected = lock.runtimes.opencode
  const target = expected.targets[architecture]
  if (
    manifest.runtimeId !== 'opencode' ||
    manifest.runtimeVersion !== expected.version ||
    manifest.provider !== expected.provider ||
    manifest.architecture !== architecture ||
    manifest.sourcePackage?.name !== target.package ||
    manifest.sourcePackage.integrity !== target.integrity ||
    manifest.entrypoint.path !== expected.entrypoint ||
    manifest.entrypoint.identity !== expected.entrypointIdentity ||
    JSON.stringify(manifest.entrypoint.argvPrefix) !==
      JSON.stringify(expected.argvPrefix) ||
    JSON.stringify(manifest.allowedEnvironmentNames) !==
      JSON.stringify(expected.allowedEnvironmentNames) ||
    manifest.protocol?.major !== expected.protocol.major ||
    manifest.protocol?.minor !== expected.protocol.minor ||
    manifest.adapterDigest !== profileDigests.adapter ||
    manifest.acpCapabilitiesDigest !== profileDigests.acp
  ) {
    throw new Error(
      'Runtime manifest does not match the locked OpenCode profile'
    )
  }
}

function verifyBundleDirectory(bundleDirectoryInput, options = {}) {
  const bundleDirectory = resolve(bundleDirectoryInput)
  const projectRoot = options.projectRoot ?? root
  const lock = options.lock ?? readRemoteRuntimeLock(projectRoot)
  const registry =
    options.registry ?? readTrustedKeyRegistry(projectRoot)
  const architecture = options.architecture
  targetName(architecture)
  const manifestBytes = readFileSync(
    join(bundleDirectory, manifestFileName)
  )
  const signatureText = readFileSync(
    join(bundleDirectory, signatureFileName),
    'utf8'
  )
  if (!/^[A-Za-z0-9+/]{86}==\n$/u.test(signatureText)) {
    throw new Error('Runtime detached signature encoding is invalid')
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  validateManifestShape(manifest)
  if (!canonicalManifestBytes(manifest).equals(manifestBytes)) {
    throw new Error(
      'Runtime manifest is not in canonical deterministic form'
    )
  }
  assertManifestMatchesLock(manifest, lock, architecture)
  const environment =
    options.verificationEnvironment ?? 'production'
  const key = trustedKeyForManifest(
    manifest,
    registry,
    environment
  )
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  const signatureBytes = Buffer.from(signatureText.trim(), 'base64')
  if (
    signatureBytes.length !== 64 ||
    !verify(
      null,
      signaturePayload(manifestBytes),
      publicKey,
      signatureBytes
    )
  ) {
    throw new Error('Runtime manifest signature verification failed')
  }
  if (digestRuntimeBundleIdentity(manifest) !== manifest.bundleDigest) {
    throw new Error('Runtime bundle identity digest does not match')
  }
  if (
    options.requireDigestDirectory !== false &&
    basename(bundleDirectory) !==
      manifest.bundleDigest.slice('sha256:'.length)
  ) {
    throw new Error(
      'Runtime bundle digest does not match its managed directory'
    )
  }

  const declared = new Set()
  for (const file of manifest.files) {
    assertSafeManifestPath(file.path)
    if (
      declared.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      !['0644', '0755'].includes(file.mode)
    ) {
      throw new Error(`Runtime manifest file entry is invalid: ${file.path}`)
    }
    declared.add(file.path)
    const filePath = join(bundleDirectory, ...file.path.split('/'))
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Runtime payload is not a regular file: ${file.path}`)
    }
    if (stat.size !== file.size) {
      throw new Error(`Runtime payload size mismatch: ${file.path}`)
    }
    if (sha256FileSync(filePath) !== file.sha256) {
      throw new Error(`Runtime payload hash mismatch: ${file.path}`)
    }
    if (
      options.enforceFilesystemMode !== false &&
      process.platform !== 'win32' &&
      modeString(filePath) !== file.mode
    ) {
      throw new Error(`Runtime payload mode mismatch: ${file.path}`)
    }
  }
  const actual = new Set(
    listFiles(bundleDirectory).map((filePath) =>
      posixRelative(bundleDirectory, filePath)
    )
  )
  const expected = new Set([
    ...declared,
    manifestFileName,
    signatureFileName
  ])
  if (
    actual.size !== expected.size ||
    [...actual].some((filePath) => !expected.has(filePath))
  ) {
    throw new Error(
      'Runtime bundle contains undeclared or missing files'
    )
  }
  for (const license of manifest.licenses) {
    assertSafeManifestPath(license.path)
    if (!declared.has(license.path)) {
      throw new Error('Runtime manifest license is not declared')
    }
  }
  if (
    !declared.has(manifest.entrypoint.path) ||
    manifest.entrypoint.sha256 !==
      manifest.files.find(
        (file) => file.path === manifest.entrypoint.path
      )?.sha256
  ) {
    throw new Error('Runtime entrypoint payload is missing')
  }
  assertElfArchitecture(
    join(bundleDirectory, ...manifest.entrypoint.path.split('/')),
    architecture
  )
  return {
    bundleDirectory,
    manifest,
    manifestDigest: digestRuntimeBundleManifest(manifest)
  }
}

function lockedArchive(lock, architecture, archivePath) {
  const input = resolveLockedRuntimeInput(lock, architecture)
  if (!archivePath || !existsSync(archivePath)) {
    throw new Error(
      `Locked OpenCode archive is required: ${input.archive}`
    )
  }
  if (!statSync(archivePath).isFile()) {
    throw new Error(`Runtime archive is not a file: ${archivePath}`)
  }
  if (basename(archivePath) !== input.archive) {
    throw new Error(
      `Runtime archive filename mismatch: expected ${input.archive}`
    )
  }
  const actualIntegrity = sha512FileIntegrity(archivePath)
  if (actualIntegrity !== input.integrity) {
    throw new Error(
      `Runtime archive integrity mismatch for ${targetName(architecture)}`
    )
  }
  return lock.runtimes.opencode.targets[architecture]
}

function resolveLockedRuntimeInput(lock, architecture) {
  targetName(architecture)
  const runtime = lock.runtimes.opencode
  const target = runtime.targets[architecture]
  return {
    packageName: target.package,
    version: runtime.version,
    integrity: target.integrity,
    archive: `${target.package}-${runtime.version}.tgz`
  }
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
      return {
        path,
        size: statSync(filePath).size,
        sha256: sha256FileSync(filePath),
        mode: path === 'bin/opencode' ? '0755' : '0644'
      }
    })
  const entrypoint = files.find(
    (file) => file.path === 'bin/opencode'
  )
  if (!entrypoint) {
    throw new Error('Runtime entrypoint is missing')
  }
  const initial = {
    formatVersion: 2,
    product: 'GoodBuddy',
    runtimeId: 'opencode',
    runtimeVersion: metadata.runtime.version,
    provider: metadata.runtime.provider,
    platform: 'linux',
    architecture: metadata.architecture,
    signingKeyId: metadata.signingKeyId,
    bundleDigest: `sha256:${'0'.repeat(64)}`,
    adapterDigest: profileDigests.adapter,
    sourcePackage: metadata.sourcePackage,
    entrypoint: {
      identity: metadata.runtime.entrypointIdentity,
      path: metadata.runtime.entrypoint,
      sha256: entrypoint.sha256,
      argvPrefix: metadata.runtime.argvPrefix
    },
    files,
    licenses: [
      {
        package: 'opencode-ai',
        version: metadata.runtime.version,
        spdx: 'MIT',
        path: 'licenses/opencode-MIT.txt'
      }
    ],
    allowedEnvironmentNames:
      metadata.runtime.allowedEnvironmentNames,
    protocol: metadata.runtime.protocol,
    acpCapabilitiesDigest: profileDigests.acp,
    limits: fixedLimits
  }
  return {
    ...initial,
    bundleDigest: digestRuntimeBundleIdentity(initial)
  }
}

function defaultOutputRoot(projectRoot = root) {
  return join(projectRoot, '.remote-runtime-resources')
}

function bundleDirectory(outputRoot, architecture, digest) {
  return join(
    outputRoot,
    targetName(architecture),
    'opencode',
    digest.slice('sha256:'.length)
  )
}

function buildRuntimeBundle(options) {
  const projectRoot = options.projectRoot ?? root
  const architecture = options.architecture
  const lock = options.lock ?? readRemoteRuntimeLock(projectRoot)
  const runtime = lock.runtimes.opencode
  const sourcePackage = lockedArchive(
    lock,
    architecture,
    options.runtimeArchive
  )
  const registry =
    options.registry ?? readTrustedKeyRegistry(projectRoot)
  const signingIdentity =
    options.testSigningIdentity ??
    options.signingIdentity ??
    productionSigningIdentity(options.environment ?? process.env)
  const verificationEnvironment =
    options.testSigningIdentity ? 'test' : 'production'
  trustedKeyForSigning(
    signingIdentity,
    registry,
    verificationEnvironment
  )
  const outputRoot =
    options.outputRoot ?? defaultOutputRoot(projectRoot)
  mkdirSync(outputRoot, { recursive: true })
  const staging = mkdtempSync(
    join(outputRoot, `.stage-${targetName(architecture)}-`)
  )
  const extracted = mkdtempSync(
    join(tmpdir(), `goodbuddy-opencode-${targetName(architecture)}-`)
  )
  try {
    tar.x({
      file: options.runtimeArchive,
      cwd: extracted,
      sync: true,
      strict: true,
      filter(path) {
        return (
          path === 'package/package.json' ||
          path === 'package/bin/opencode'
        )
      }
    })
    const sourceMetadata = readJson(
      join(extracted, 'package', 'package.json'),
      'OpenCode source package metadata'
    )
    if (
      sourceMetadata.name !== sourcePackage.package &&
      sourceMetadata.name !== sourcePackage.name
    ) {
      // The lock target itself carries the canonical package name.
      if (
        sourceMetadata.name !==
        runtime.targets[architecture].package
      ) {
        throw new Error('OpenCode source package name does not match the lock')
      }
    }
    if (sourceMetadata.version !== runtime.version) {
      throw new Error(
        'OpenCode source package version does not match the lock'
      )
    }
    mkdirSync(join(staging, 'bin'), { mode: 0o700 })
    copyFileSync(
      join(extracted, 'package', 'bin', 'opencode'),
      join(staging, 'bin', 'opencode')
    )
    chmodSync(join(staging, 'bin', 'opencode'), 0o755)
    assertElfArchitecture(
      join(staging, 'bin', 'opencode'),
      architecture
    )
    mkdirSync(join(staging, 'licenses'), { mode: 0o700 })
    copyFileSync(
      join(projectRoot, 'node_modules', 'opencode-ai', 'LICENSE'),
      join(staging, 'licenses', 'opencode-MIT.txt')
    )
    chmodSync(
      join(staging, 'licenses', 'opencode-MIT.txt'),
      0o644
    )
    const manifest = createManifest(staging, {
      architecture,
      runtime,
      sourcePackage: {
        name: runtime.targets[architecture].package,
        integrity: runtime.targets[architecture].integrity
      },
      signingKeyId: signingIdentity.keyId
    })
    const manifestBytes = canonicalManifestBytes(manifest)
    const signatureBytes = sign(
      null,
      signaturePayload(manifestBytes),
      signingIdentity.privateKey
    )
    writeFileSync(
      join(staging, manifestFileName),
      manifestBytes,
      { mode: 0o644 }
    )
    writeFileSync(
      join(staging, signatureFileName),
      `${signatureBytes.toString('base64')}\n`,
      { mode: 0o644 }
    )
    chmodSync(join(staging, manifestFileName), 0o644)
    chmodSync(join(staging, signatureFileName), 0o644)
    const destination = bundleDirectory(
      outputRoot,
      architecture,
      manifest.bundleDigest
    )
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    if (existsSync(destination)) {
      const existing = verifyBundleDirectory(destination, {
        projectRoot,
        architecture,
        lock,
        registry,
        verificationEnvironment,
        enforceFilesystemMode: options.enforceFilesystemMode
      })
      if (
        canonicalJson(existing.manifest) !== canonicalJson(manifest)
      ) {
        throw new Error(
          'Existing Runtime digest directory has different content'
        )
      }
      return existing
    }
    chmodSync(staging, 0o700)
    renameSync(staging, destination)
    return verifyBundleDirectory(destination, {
      projectRoot,
      architecture,
      lock,
      registry,
      verificationEnvironment,
      enforceFilesystemMode: options.enforceFilesystemMode
    })
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(extracted, { recursive: true, force: true })
  }
}

function createRuntimeArchive(bundleDirectoryInput, archivePath) {
  const directory = resolve(bundleDirectoryInput)
  const entries = listFiles(directory)
    .map((filePath) => posixRelative(directory, filePath))
    .sort(compareUtf8)
  mkdirSync(dirname(archivePath), { recursive: true })
  rmSync(archivePath, { force: true })
  tar.c(
    {
      cwd: directory,
      file: archivePath,
      sync: true,
      portable: true,
      noPax: true,
      mtime: new Date(0)
    },
    entries
  )
}

function importRuntimeArchive(archivePath, options) {
  if (!existsSync(archivePath)) {
    throw new Error(`Runtime artifact archive is missing: ${archivePath}`)
  }
  const projectRoot = options.projectRoot ?? root
  const architecture = options.architecture
  const outputRoot =
    options.outputRoot ?? defaultOutputRoot(projectRoot)
  mkdirSync(outputRoot, { recursive: true })
  const staging = mkdtempSync(
    join(outputRoot, `.import-${targetName(architecture)}-`)
  )
  try {
    tar.x({
      cwd: staging,
      file: archivePath,
      sync: true,
      strict: true,
      preservePaths: false
    })
    const verified = verifyBundleDirectory(staging, {
      ...options,
      projectRoot,
      architecture,
      requireDigestDirectory: false
    })
    const destination = bundleDirectory(
      outputRoot,
      architecture,
      verified.manifest.bundleDigest
    )
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    if (existsSync(destination)) {
      return verifyBundleDirectory(destination, {
        ...options,
        projectRoot,
        architecture
      })
    }
    chmodSync(staging, 0o700)
    renameSync(staging, destination)
    return verifyBundleDirectory(destination, {
      ...options,
      projectRoot,
      architecture
    })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function findOnlyBundle(outputRoot, architecture) {
  const runtimeRoot = join(
    outputRoot,
    targetName(architecture),
    'opencode'
  )
  const entries = existsSync(runtimeRoot)
    ? readdirSync(runtimeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(runtimeRoot, entry.name))
    : []
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one built Runtime bundle for ${targetName(architecture)}`
    )
  }
  return entries[0]
}

function redactSecrets(value, environment = process.env) {
  let output = String(value)
  for (const secret of [
    environment[signingPrivateKeyEnvironment],
    environment[signingKeyIdEnvironment]
  ]) {
    if (secret && secret.length >= 4) {
      output = output.split(secret).join('[redacted]')
    }
  }
  return output.replace(
    /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/gu,
    '[redacted private key]'
  )
}

function parseArguments(argv) {
  const command = argv[0]
  const options = {}
  const allowed = new Set([
    '--arch',
    '--runtime-archive',
    '--archive',
    '--output-root',
    '--bundle'
  ])
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(flag) || !value) {
      throw new Error('Invalid Remote Runtime bundle argument')
    }
    options[
      flag.slice(2).replace(/-([a-z])/gu, (_match, value) =>
        value.toUpperCase()
      )
    ] = value
  }
  if (!['build', 'import', 'verify', 'preflight'].includes(command)) {
    throw new Error(
      'Usage: remote-runtime-bundle.cjs <build|import|verify|preflight> --arch <x64|arm64>'
    )
  }
  if (command === 'preflight') {
    return { command }
  }
  targetName(options.arch)
  return { command, ...options }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.command === 'preflight') {
    const record = preflightProductionSigningKey()
    console.log(
      `Production GoodBuddy signing preflight passed for bundled Runtime: ${record.keyId}`
    )
    return
  }
  const outputRoot = options.outputRoot
    ? resolve(options.outputRoot)
    : defaultOutputRoot()
  if (options.command === 'build') {
    const verified = buildRuntimeBundle({
      architecture: options.arch,
      runtimeArchive: resolve(options.runtimeArchive ?? ''),
      outputRoot
    })
    const archivePath = options.archive
      ? resolve(options.archive)
      : join(
          root,
          'dist',
          'remote-runtime-bundles',
          `goodbuddy-opencode-${targetName(options.arch)}.tar`
        )
    createRuntimeArchive(verified.bundleDirectory, archivePath)
    console.log(
      `Remote Runtime bundle built and verified: ${targetName(options.arch)}`
    )
    return
  }
  if (options.command === 'import') {
    importRuntimeArchive(resolve(options.archive ?? ''), {
      architecture: options.arch,
      outputRoot
    })
    console.log(
      `Remote Runtime bundle imported and verified: ${targetName(options.arch)}`
    )
    return
  }
  verifyBundleDirectory(
    options.bundle
      ? resolve(options.bundle)
      : findOnlyBundle(outputRoot, options.arch),
    { architecture: options.arch }
  )
  console.log(
    `Remote Runtime bundle verified: ${targetName(options.arch)}`
  )
}

module.exports = {
  buildRuntimeBundle,
  bundleDirectory,
  canonicalJson,
  canonicalManifestBytes,
  createManifest,
  createRuntimeArchive,
  defaultOutputRoot,
  digestRuntimeBundleIdentity,
  digestRuntimeBundleManifest,
  fixedLimits,
  importRuntimeArchive,
  preflightProductionSigningKey,
  profileDigests,
  publicKeySpkiBase64,
  readRemoteRuntimeLock,
  readTrustedKeyRegistry,
  redactSecrets,
  resolveLockedRuntimeInput,
  signaturePayload,
  supportedArchitectures,
  targetName,
  verifyBundleDirectory
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(
      redactSecrets(
        error instanceof Error ? error.message : String(error)
      )
    )
    process.exitCode = 1
  }
}
