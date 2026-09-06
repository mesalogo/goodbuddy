const { generateKeyPairSync } = require('node:crypto')
const {
  mkdirSync,
  rmSync
} = require('node:fs')
const {
  basename,
  dirname,
  join,
  resolve
} = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  buildAgentBundle,
  publicKeySpkiBase64,
  readRuntimeLock,
  supportedArchitectures
} = require('./agent-bundle.cjs')
const {
  buildRuntimeBundle,
  readRemoteRuntimeLock
} = require('./remote-runtime-bundle.cjs')
const {
  assembleAgentPackage
} = require('./agent-package.cjs')
const { sha256File } = require('./file-hash.cjs')
const { targetName } = require('./agent-build-target.cjs')

const ciSigningKeyId = 'goodbuddy-agent-ci-ephemeral'

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (
      ![
        '--arch',
        '--platform',
        '--node-archive',
        '--opencode-archive',
        '--output-directory',
        '--archive'
      ].includes(argument)
    ) {
      throw new Error(`Unknown Agent CI bundle argument: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    const key = argument.slice(2).replaceAll('-', '')
    if (options[key] !== undefined) {
      throw new Error(`${argument} may be provided only once`)
    }
    options[key] = value
    index += 1
  }
  if (!supportedArchitectures.includes(options.arch)) {
    throw new Error('--arch must be x64 or arm64')
  }
  const platform = options.platform ?? 'linux'
  targetName(options.arch, platform)
  for (const key of [
    'nodearchive',
    'opencodearchive',
    'outputdirectory',
    'archive'
  ]) {
    if (!options[key]) {
      throw new Error(
        'Usage: agent-ci-bundle.cjs --arch <x64|arm64> --node-archive <path> --opencode-archive <path> --output-directory <path> --archive <path>'
      )
    }
  }
  return {
    arch: options.arch,
    platform,
    nodeArchive: resolve(options.nodearchive),
    opencodeArchive: resolve(options.opencodearchive),
    outputDirectory: resolve(options.outputdirectory),
    archive: resolve(options.archive)
  }
}

function readCiLocks(platform = 'linux', architecture = 'x64') {
  const projectRoot = resolve(__dirname, '..')
  targetName(architecture, platform)
  const lock = readRuntimeLock(projectRoot)
  const runtimeLock = readRemoteRuntimeLock(projectRoot)
  return { lock, runtimeLock }
}

function ephemeralSigningIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    registry: {
      formatVersion: 1,
      keys: [
        {
          keyId: ciSigningKeyId,
          publicKeySpkiBase64: publicKeySpkiBase64(publicKey),
          environment: 'test'
        }
      ],
      revocations: []
    }
  }
}

async function buildCiAgentBundle(options) {
  const projectRoot = resolve(__dirname, '..')
  const platform = options.platform ?? 'linux'
  const target = targetName(options.arch, platform)
  if (process.platform !== platform || process.arch !== options.arch) {
    throw new Error(`Agent CI build requires a native ${target} host`)
  }
  const { lock, runtimeLock } = readCiLocks(platform, options.arch)
  const signing = ephemeralSigningIdentity()
  const firstArchiveRoot = resolve(
    join(
      dirname(options.archive),
      `.agent-ci-first-${process.pid}`
    )
  )
  mkdirSync(firstArchiveRoot, { recursive: true })
  const firstArchive = join(
    firstArchiveRoot,
    basename(options.archive)
  )
  const runtimeRoot = resolve(
    `${options.outputDirectory}-runtime`
  )
  try {
    const identity = {
      keyId: ciSigningKeyId,
      privateKey: signing.privateKey
    }
    rmSync(options.outputDirectory, {
      recursive: true,
      force: true
    })
    buildAgentBundle({
      platform,
      lock,
      projectRoot,
      arch: options.arch,
      runtimeArchive: options.nodeArchive,
      outputDirectory: options.outputDirectory,
      registry: signing.registry,
      testSigningIdentity: identity
    })
    const runtime = buildRuntimeBundle({
      platform,
      lock: runtimeLock,
      projectRoot,
      architecture: options.arch,
      runtimeArchive: options.opencodeArchive,
      outputRoot: runtimeRoot,
      registry: signing.registry,
      testSigningIdentity: identity
    })
    const assemble = (archive) =>
      assembleAgentPackage({
        platform,
        projectRoot,
        architecture: options.arch,
        minimumDesktopVersion:
          require('../package.json').version,
        output: archive,
        agentBundle: options.outputDirectory,
        runtimeBundle: runtime.bundleDirectory,
        agentLock: lock,
        runtimeLock,
        registry: signing.registry,
        testSigningIdentity: identity
      })

    assemble(firstArchive)
    const firstDigest = await sha256File(firstArchive)
    const second = assemble(options.archive)
    const archiveDigest = await sha256File(options.archive)
    if (firstDigest !== archiveDigest) {
      throw new Error('Agent CI archives are not deterministic')
    }

    const smoke = spawnSync(
      resolve(options.outputDirectory, 'goodbuddy-agent'),
      ['ci-invalid-command'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true
      }
    )
    if (
      smoke.error ||
      smoke.status !== 2 ||
      !smoke.stderr.includes(
        'Expected daemon, attach-or-bootstrap, doctor'
      )
    ) {
      throw new Error('Built Agent native launch smoke failed')
    }

    const nativeChecks = [
      [
        resolve(options.outputDirectory, 'node'),
        ['-e', `const k = require(${JSON.stringify(resolve(options.outputDirectory, 'lib/node_modules/koffi'))}); if (k.sizeof('int') !== 4) process.exit(1)`]
      ],
      [join(runtime.bundleDirectory, 'bin', 'opencode'), ['--version']]
    ]
    for (const [executable, args] of nativeChecks) {
      const result = spawnSync(executable, args, {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true
      })
      if (
        result.error ||
        result.status !== 0 ||
        (args[0] === '--version' &&
          result.stdout.trim() !== runtimeLock.runtimes.opencode.version)
      ) {
        throw new Error(`Built native dependency smoke failed: ${basename(executable)}`)
      }
    }

    return {
      platform,
      agentVersion: lock.agentVersion,
      remoteRuntimeVersion:
        runtimeLock.runtimes.opencode.version,
      architecture: options.arch,
      archive: second.archive,
      archiveSha256: archiveDigest
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
    rmSync(firstArchive, { force: true })
    rmSync(firstArchiveRoot, { recursive: true, force: true })
  }
}

async function main(argv = process.argv.slice(2)) {
  const result = await buildCiAgentBundle(parseArguments(argv))
  process.stdout.write(
    `${JSON.stringify(result)}\n`
  )
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 1
  })
}

module.exports = {
  buildCiAgentBundle,
  parseArguments,
  readCiLocks
}
