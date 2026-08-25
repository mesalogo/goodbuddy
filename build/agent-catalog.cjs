const {
  createHash,
  createPublicKey,
  sign,
  verify
} = require('node:crypto')
const {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { basename, resolve } = require('node:path')
const {
  Unzip,
  UnzipInflate,
  UnzipPassThrough
} = require('fflate')
const {
  productionSigningKey,
  publicKeySpkiBase64,
  readTrustedKeyRegistry,
  redactSecrets
} = require('./agent-bundle.cjs')
const {
  canonicalJson,
  descriptorContentDigest,
  signatureDomain: packageSignatureDomain
} = require('./agent-package.cjs')

const root = resolve(__dirname, '..')
const catalogName = 'agent-catalog.json'
const catalogSignatureName = 'agent-catalog.sig'
const catalogSignatureDomain = Buffer.from(
  'GoodBuddy Agent Package Catalog Signature v1\0',
  'utf8'
)
const semanticVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const maximumPackageBytes = 512 * 1024 * 1024
const maximumCatalogEntries = 200
const windowsReservedNamePattern =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function trustedProductionKey(registry, keyId) {
  const key = registry.keys.find(
    (candidate) =>
      candidate.keyId === keyId &&
      candidate.environment === 'production'
  )
  if (
    !key ||
    registry.revocations.some(
      (revocation) => revocation.keyId === keyId
    )
  ) {
    throw new Error(`Agent signing key is not trusted: ${keyId}`)
  }
  return key
}

function verifyDetachedSignature(
  bytes,
  signatureText,
  key,
  domain,
  label
) {
  const signature = Buffer.from(
    signatureText.toString('utf8').trim(),
    'base64'
  )
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  if (
    signature.length !== 64 ||
    !verify(
      null,
      Buffer.concat([domain, bytes]),
      publicKey,
      signature
    )
  ) {
    throw new Error(`${label} signature verification failed`)
  }
}

function parseCanonicalJson(bytes, label) {
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  )
  if (!canonicalBytes(value).equals(bytes)) {
    throw new Error(`${label} is not canonical`)
  }
  return value
}

function assertProtocol(value, label) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Number.isSafeInteger(value.major) ||
    value.major < 1 ||
    !Number.isSafeInteger(value.minor) ||
    value.minor < 0
  ) {
    throw new Error(`${label} is invalid`)
  }
}

function assertPackageDescriptor(descriptor) {
  if (
    typeof descriptor !== 'object' ||
    descriptor === null ||
    descriptor.format !== 'goodbuddy-agent-package' ||
    descriptor.formatVersion !== 1 ||
    descriptor.product !== 'GoodBuddy' ||
    descriptor.component !== 'agent' ||
    !semanticVersionPattern.test(descriptor.version ?? '') ||
    !semanticVersionPattern.test(
      descriptor.minimumDesktopVersion ?? ''
    ) ||
    descriptor.platform !== 'linux' ||
    !['x64', 'arm64'].includes(descriptor.architecture) ||
    typeof descriptor.signingKeyId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(
      descriptor.contentDigest ?? ''
    ) ||
    !Array.isArray(descriptor.files) ||
    descriptor.files.length === 0 ||
    descriptor.files.length > 50_000 ||
    typeof descriptor.remoteRuntime !== 'object' ||
    descriptor.remoteRuntime === null ||
    descriptor.remoteRuntime.runtimeId !== 'opencode' ||
    descriptor.remoteRuntime.provider !== 'opencode' ||
    !semanticVersionPattern.test(
      descriptor.remoteRuntime.version ?? ''
    ) ||
    !/^sha256:[a-f0-9]{64}$/u.test(
      descriptor.remoteRuntime.bundleDigest ?? ''
    )
  ) {
    throw new Error('Agent package descriptor is invalid')
  }
  assertProtocol(descriptor.agentProtocol, 'Agent protocol')
  assertProtocol(
    descriptor.remoteRuntime.protocol,
    'Remote Runtime protocol'
  )
  const paths = new Set()
  for (const file of descriptor.files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      !safePackagePath(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !sha256Pattern.test(file.sha256 ?? '') ||
      !['0644', '0755'].includes(file.mode) ||
      paths.has(file.path)
    ) {
      throw new Error('Agent package file inventory is invalid')
    }
    paths.add(file.path)
  }
  if (
    descriptor.contentDigest !==
    descriptorContentDigest(descriptor)
  ) {
    throw new Error('Agent package content identity is invalid')
  }
}

function readPackageMetadata(archivePath, registry) {
  const archive = resolve(archivePath)
  const status = statSync(archive)
  if (
    !status.isFile() ||
    status.size <= 0 ||
    status.size > maximumPackageBytes
  ) {
    throw new Error('Agent package archive is not a bounded file')
  }
  const streamed = streamPackageMetadata(archive)
  const descriptorBytes = streamed.descriptor
  const signatureBytes = streamed.signature
  if (!descriptorBytes || !signatureBytes) {
    throw new Error('Agent package metadata is missing')
  }
  const descriptor = parseCanonicalJson(
    Buffer.from(descriptorBytes),
    'Agent package descriptor'
  )
  assertPackageDescriptor(descriptor)
  verifyPackageFileInventory(descriptor, streamed.files)
  const key = trustedProductionKey(
    registry,
    descriptor.signingKeyId
  )
  verifyDetachedSignature(
    Buffer.from(descriptorBytes),
    Buffer.from(signatureBytes),
    key,
    packageSignatureDomain,
    'Agent package'
  )
  const expectedArchive =
    `goodbuddy-agent-${descriptor.version}` +
    `-linux-${descriptor.architecture}.gbagent`
  if (basename(archive) !== expectedArchive) {
    throw new Error(
      `Agent package archive must be named ${expectedArchive}`
    )
  }
  return {
    archive: expectedArchive,
    descriptor,
    size: status.size,
    sha256: streamed.sha256
  }
}

function safePackagePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.endsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.endsWith('.') &&
        !part.endsWith(' ') &&
        !part.includes(':') &&
        [...part].every(
          (character) => character.charCodeAt(0) > 0x1f
        ) &&
        !windowsReservedNamePattern.test(part)
    )
  )
}

function verifyPackageFileInventory(descriptor, actualFiles) {
  const expected = new Set([
    ...descriptor.files.map((file) => file.path),
    'agent-package.json',
    'agent-package.sig'
  ])
  if (
    actualFiles.size !== expected.size ||
    [...actualFiles.keys()].some((path) => !expected.has(path))
  ) {
    throw new Error(
      'Agent package contains undeclared or missing files'
    )
  }
  for (const file of descriptor.files) {
    const actual = actualFiles.get(file.path)
    if (
      !actual ||
      actual.size !== file.size ||
      actual.sha256 !== file.sha256
    ) {
      throw new Error(
        `Agent package payload verification failed: ${file.path}`
      )
    }
  }
}

function streamPackageMetadata(archivePath) {
  const handle = openSync(archivePath, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const values = new Map()
  const files = new Map()
  const seen = new Set()
  let fatalError
  let entries = 0
  let expandedBytes = 0
  const unzip = new Unzip((file) => {
    entries += 1
    if (entries > 50_002) {
      fatalError ??= new Error(
        'Agent package contains too many entries'
      )
      file.terminate()
      return
    }
    if (!safePackagePath(file.name) || seen.has(file.name)) {
      fatalError ??= new Error(
        'Agent package contains an unsafe or duplicate path'
      )
      file.terminate()
      return
    }
    seen.add(file.name)
    const wanted =
      file.name === 'agent-package.json' ||
      file.name === 'agent-package.sig'
    if (wanted && values.has(file.name)) {
      fatalError ??= new Error(
        'Agent package contains duplicate metadata'
      )
      file.terminate()
      return
    }
    const chunks = []
    let size = 0
    const fileHash = createHash('sha256')
    file.ondata = (error, data, final) => {
      if (error) {
        fatalError ??= error
        return
      }
      size += data.byteLength
      expandedBytes += data.byteLength
      if (
        size > 384 * 1024 * 1024 ||
        expandedBytes > 1024 * 1024 * 1024
      ) {
        fatalError ??= new Error(
          'Agent package expanded payload exceeds its limit'
        )
        file.terminate()
        return
      }
      fileHash.update(data)
      if (wanted) {
        if (size > 1024 * 1024) {
          fatalError ??= new Error(
            'Agent package metadata exceeds its limit'
          )
          file.terminate()
          return
        }
        chunks.push(Buffer.from(data))
      }
      if (final) {
        files.set(file.name, {
          size,
          sha256: fileHash.digest('hex')
        })
        if (wanted) {
          values.set(file.name, Buffer.concat(chunks, size))
        }
      }
    }
    try {
      file.start()
    } catch (error) {
      fatalError ??= error
      file.terminate()
    }
  })
  unzip.register(UnzipPassThrough)
  unzip.register(UnzipInflate)
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
        unzip.push(new Uint8Array(), true)
        break
      }
      const chunk = Uint8Array.from(
        buffer.subarray(0, bytesRead)
      )
      hash.update(chunk)
      unzip.push(chunk, false)
      if (fatalError) {
        throw fatalError
      }
    }
  } finally {
    closeSync(handle)
  }
  if (fatalError) {
    throw fatalError
  }
  return {
    descriptor: values.get('agent-package.json'),
    signature: values.get('agent-package.sig'),
    files,
    sha256: hash.digest('hex')
  }
}

function catalogEntry(metadata) {
  const descriptor = metadata.descriptor
  const {
    contentDigest: _contentDigest,
    files: _files,
    signingKeyId: _signingKeyId,
    ...identity
  } = descriptor
  void _contentDigest
  void _files
  void _signingKeyId
  return {
    ...identity,
    archive: metadata.archive,
    size: metadata.size,
    sha256: metadata.sha256,
    downloads: {
      github: {
        url:
          'https://github.com/mesalogo/goodbuddy/releases/download/' +
          `agent-v${descriptor.version}/${metadata.archive}`
      },
      mirror: {
        url:
          'https://goodbuddy.oss-cn-beijing.aliyuncs.com/' +
          `agent-releases/v${descriptor.version}/${metadata.archive}`
      }
    }
  }
}

function assertCatalog(catalog) {
  if (
    typeof catalog !== 'object' ||
    catalog === null ||
    catalog.formatVersion !== 1 ||
    catalog.product !== 'GoodBuddy' ||
    catalog.component !== 'agent' ||
    typeof catalog.signingKeyId !== 'string' ||
    typeof catalog.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(catalog.generatedAt)) ||
    new Date(catalog.generatedAt).toISOString() !==
      catalog.generatedAt ||
    !Array.isArray(catalog.entries) ||
    catalog.entries.length === 0 ||
    catalog.entries.length > maximumCatalogEntries
  ) {
    throw new Error('Agent catalog is invalid')
  }
  const identities = new Set()
  for (const entry of catalog.entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !semanticVersionPattern.test(entry.version ?? '') ||
      !semanticVersionPattern.test(
        entry.minimumDesktopVersion ?? ''
      ) ||
      entry.platform !== 'linux' ||
      !['x64', 'arm64'].includes(entry.architecture) ||
      entry.archive !==
        `goodbuddy-agent-${entry.version}` +
          `-linux-${entry.architecture}.gbagent` ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      !sha256Pattern.test(entry.sha256 ?? '') ||
      entry.downloads?.github?.url !==
        'https://github.com/mesalogo/goodbuddy/releases/download/' +
          `agent-v${entry.version}/${entry.archive}` ||
      entry.downloads?.mirror?.url !==
        'https://goodbuddy.oss-cn-beijing.aliyuncs.com/' +
          `agent-releases/v${entry.version}/${entry.archive}` ||
      entry.format !== 'goodbuddy-agent-package' ||
      entry.formatVersion !== 1 ||
      entry.product !== 'GoodBuddy' ||
      entry.component !== 'agent' ||
      entry.remoteRuntime?.runtimeId !== 'opencode' ||
      entry.remoteRuntime?.provider !== 'opencode' ||
      !semanticVersionPattern.test(
        entry.remoteRuntime?.version ?? ''
      ) ||
      !/^sha256:[a-f0-9]{64}$/u.test(
        entry.remoteRuntime?.bundleDigest ?? ''
      )
    ) {
      throw new Error('Agent catalog entry is invalid')
    }
    assertProtocol(entry.agentProtocol, 'Agent protocol')
    assertProtocol(
      entry.remoteRuntime.protocol,
      'Remote Runtime protocol'
    )
    const identity = `${entry.version}:${entry.architecture}`
    if (identities.has(identity)) {
      throw new Error('Agent catalog contains duplicate entries')
    }
    identities.add(identity)
  }
}

function readVerifiedCatalog(catalogPath, signaturePath, registry) {
  const bytes = readFileSync(resolve(catalogPath))
  const catalog = parseCanonicalJson(bytes, 'Agent catalog')
  assertCatalog(catalog)
  const key = trustedProductionKey(
    registry,
    catalog.signingKeyId
  )
  verifyDetachedSignature(
    bytes,
    readFileSync(resolve(signaturePath)),
    key,
    catalogSignatureDomain,
    'Agent catalog'
  )
  return catalog
}

function parseVersion(value) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u
      .exec(value)
  if (!match) {
    throw new Error(`Invalid semantic version: ${value}`)
  }
  return [
    BigInt(match[1]),
    BigInt(match[2]),
    BigInt(match[3]),
    match[4]?.split('.')
  ]
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (const index of [0, 1, 2]) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1
    }
  }
  const leftPre = leftParts[3]
  const rightPre = rightParts[3]
  if (!leftPre && !rightPre) return 0
  if (!leftPre) return 1
  if (!rightPre) return -1
  for (
    let index = 0;
    index < Math.max(leftPre.length, rightPre.length);
    index += 1
  ) {
    const leftValue = leftPre[index]
    const rightValue = rightPre[index]
    if (leftValue === undefined) return -1
    if (rightValue === undefined) return 1
    if (leftValue === rightValue) continue
    const leftNumeric = /^\d+$/u.test(leftValue)
    const rightNumeric = /^\d+$/u.test(rightValue)
    if (leftNumeric && rightNumeric) {
      return BigInt(leftValue) > BigInt(rightValue) ? 1 : -1
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    }
    return leftValue > rightValue ? 1 : -1
  }
  return 0
}

function createCatalog(options) {
  const projectRoot = options.projectRoot ?? root
  const registry =
    options.registry ?? readTrustedKeyRegistry(projectRoot)
  const signingIdentity =
    options.signingIdentity ??
    productionSigningKey(options.environment ?? process.env)
  const signingRecord = trustedProductionKey(
    registry,
    signingIdentity.keyId
  )
  if (
    publicKeySpkiBase64(signingIdentity.privateKey) !==
    signingRecord.publicKeySpkiBase64
  ) {
    throw new Error(
      'Agent catalog signing key does not match the trusted registry'
    )
  }
  const packages = [
    readPackageMetadata(options.x64Package, registry),
    readPackageMetadata(options.arm64Package, registry)
  ]
  const [first, second] = packages
  const {
    bundleDigest: _firstRuntimeDigest,
    ...firstRuntimeIdentity
  } = first.descriptor.remoteRuntime
  const {
    bundleDigest: _secondRuntimeDigest,
    ...secondRuntimeIdentity
  } = second.descriptor.remoteRuntime
  void _firstRuntimeDigest
  void _secondRuntimeDigest
  if (
    first.descriptor.version !== second.descriptor.version ||
    first.descriptor.minimumDesktopVersion !==
      second.descriptor.minimumDesktopVersion ||
    canonicalJson(first.descriptor.agentProtocol) !==
      canonicalJson(second.descriptor.agentProtocol) ||
    canonicalJson(firstRuntimeIdentity) !==
      canonicalJson(secondRuntimeIdentity) ||
    new Set(packages.map(
      (metadata) => metadata.descriptor.architecture
    )).size !== 2
  ) {
    throw new Error(
      'Agent package matrix does not describe one coherent release'
    )
  }
  const previous =
    options.previousCatalog && options.previousSignature
      ? readVerifiedCatalog(
          options.previousCatalog,
          options.previousSignature,
          registry
        )
      : undefined
  if (
    Boolean(options.previousCatalog) !==
    Boolean(options.previousSignature)
  ) {
    throw new Error(
      'Previous Agent catalog and signature must be provided together'
    )
  }
  const entries = new Map()
  for (const entry of previous?.entries ?? []) {
    entries.set(`${entry.version}:${entry.architecture}`, entry)
  }
  for (const metadata of packages) {
    const entry = catalogEntry(metadata)
    const identity = `${entry.version}:${entry.architecture}`
    const existing = entries.get(identity)
    if (
      existing &&
      canonicalJson(existing) !== canonicalJson(entry)
    ) {
      throw new Error(
        `Agent release identity is immutable: ${identity}`
      )
    }
    entries.set(identity, entry)
  }
  const sortedEntries = [...entries.values()].sort(
    (left, right) =>
      compareVersions(right.version, left.version) ||
      left.architecture.localeCompare(right.architecture, 'en')
  )
  if (sortedEntries.length > maximumCatalogEntries) {
    throw new Error('Agent catalog exceeds its retention limit')
  }
  const catalog = {
    formatVersion: 1,
    product: 'GoodBuddy',
    component: 'agent',
    signingKeyId: signingIdentity.keyId,
    generatedAt: new Date(options.generatedAt).toISOString(),
    entries: sortedEntries
  }
  assertCatalog(catalog)
  const bytes = canonicalBytes(catalog)
  const signature = sign(
    null,
    Buffer.concat([catalogSignatureDomain, bytes]),
    signingIdentity.privateKey
  )
  writeFileSync(resolve(options.outputCatalog), bytes)
  writeFileSync(
    resolve(options.outputSignature),
    `${signature.toString('base64')}\n`,
    'utf8'
  )
  return {
    version: first.descriptor.version,
    catalog: basename(options.outputCatalog),
    signature: basename(options.outputSignature),
    entries: sortedEntries.length
  }
}

function parseArguments(argv) {
  const command = argv[0]
  if (!['create', 'verify'].includes(command)) {
    throw new Error(
      'Usage: agent-catalog.cjs <create|verify> [options]'
    )
  }
  const options = {}
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      ![
        '--x64-package',
        '--arm64-package',
        '--previous-catalog',
        '--previous-signature',
        '--catalog',
        '--signature',
        '--generated-at'
      ].includes(flag) ||
      !value ||
      value.startsWith('--') ||
      options[flag] !== undefined
    ) {
      throw new Error('Invalid Agent catalog argument')
    }
    options[flag] = value
  }
  for (const flag of ['--catalog', '--signature']) {
    if (!options[flag]) {
      throw new Error(`Agent catalog argument is required: ${flag}`)
    }
  }
  if (command === 'verify') {
    return {
      command,
      catalog: resolve(options['--catalog']),
      signature: resolve(options['--signature'])
    }
  }
  for (const flag of [
    '--x64-package',
    '--arm64-package',
    '--generated-at'
  ]) {
    if (!options[flag]) {
      throw new Error(`Agent catalog argument is required: ${flag}`)
    }
  }
  return {
    command,
    x64Package: resolve(options['--x64-package']),
    arm64Package: resolve(options['--arm64-package']),
    ...(options['--previous-catalog']
      ? {
          previousCatalog: resolve(
            options['--previous-catalog']
          )
        }
      : {}),
    ...(options['--previous-signature']
      ? {
          previousSignature: resolve(
            options['--previous-signature']
          )
        }
      : {}),
    outputCatalog: resolve(options['--catalog']),
    outputSignature: resolve(options['--signature']),
    generatedAt: options['--generated-at']
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const registry = readTrustedKeyRegistry(root)
  const result =
    options.command === 'create'
      ? createCatalog(options)
      : {
          entries: readVerifiedCatalog(
            options.catalog,
            options.signature,
            registry
          ).entries.length
        }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

module.exports = {
  catalogName,
  catalogSignatureDomain,
  catalogSignatureName,
  canonicalBytes,
  catalogEntry,
  createCatalog,
  parseArguments,
  readPackageMetadata,
  readVerifiedCatalog
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
