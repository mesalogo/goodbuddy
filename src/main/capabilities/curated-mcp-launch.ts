import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  buildDesktopHelperEnvironment,
  type SecurePathMetadata,
  type SessionEnvironmentOptions
} from '../linux-desktop/session-environment'
import { isPathInside } from '../workspace-file-access'

const MAX_ARGUMENTS = 64
const MAX_ARGUMENT_LENGTH = 4_096
const MAX_ENVIRONMENT_ENTRIES = 64
const MAX_ENVIRONMENT_VALUE_LENGTH = 8_192
const DESKTOP_ENVIRONMENT_NAMES = new Set([
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
  'NO_AT_BRIDGE'
])
declare const curatedMcpLaunchBrand: unique symbol

export type CuratedMcpPathMetadata = Readonly<SecurePathMetadata>

export interface CuratedMcpFileSystem {
  inspect(path: string): Promise<CuratedMcpPathMetadata>
}

export type CuratedMcpLaunchOptions = Readonly<{
  executable: string
  args?: readonly string[]
  cwd: string
  ownedRoots: readonly string[]
  ownerUid: number
  environment?: Readonly<Record<string, string>>
  allowedEnvironmentNames?: readonly string[]
  linuxDesktopEnvironment?: SessionEnvironmentOptions
}>

export type CuratedMcpLaunchDescriptor = Readonly<{
  readonly [curatedMcpLaunchBrand]: true
  readonly transport: 'curated-stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}>

export type CuratedMcpLaunchDependencies = Readonly<{
  fileSystem?: CuratedMcpFileSystem
  validateLinuxDesktopEnvironment?: (
    options: SessionEnvironmentOptions
  ) => Promise<NodeJS.ProcessEnv>
}>

const descriptors = new WeakSet<object>()

const defaultFileSystem: CuratedMcpFileSystem = {
  async inspect(path) {
    const [linkMetadata, canonicalPath] = await Promise.all([
      lstat(path),
      realpath(path)
    ])
    const metadata = await stat(canonicalPath)
    return {
      canonicalPath,
      uid: metadata.uid,
      mode: metadata.mode,
      isDirectory: metadata.isDirectory(),
      isFile: metadata.isFile(),
      isSymbolicLink: linkMetadata.isSymbolicLink()
    }
  }
}

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })

const isSafePathText = (value: string): boolean =>
  value.length >= 1 &&
  value.length <= MAX_ENVIRONMENT_VALUE_LENGTH &&
  !hasControlCharacters(value)

const assertOwnedCanonicalPath = (
  requestedPath: string,
  metadata: CuratedMcpPathMetadata,
  ownerUid: number,
  expectedKind: 'directory' | 'file'
): void => {
  if (
    !isAbsolute(requestedPath) ||
    metadata.canonicalPath !== requestedPath ||
    metadata.isSymbolicLink ||
    metadata.uid !== ownerUid ||
    (metadata.mode & 0o022) !== 0 ||
    (expectedKind === 'directory'
      ? !metadata.isDirectory
      : !metadata.isFile)
  ) {
    throw new Error(`Unsafe curated MCP ${expectedKind} path`)
  }
}

const isRejectedEnvironmentName = (name: string): boolean => {
  const upperName = name.toUpperCase()
  return (
    upperName.startsWith('LD_') ||
    upperName === 'NODE_OPTIONS' ||
    upperName === 'GTK_MODULES' ||
    upperName === 'QT_PLUGIN_PATH' ||
    upperName.startsWith('ELECTRON_') ||
    upperName.startsWith('CHROME_') ||
    upperName.startsWith('CHROMIUM_') ||
    upperName === 'HTTP_PROXY' ||
    upperName === 'HTTPS_PROXY' ||
    upperName === 'ALL_PROXY' ||
    upperName === 'NO_PROXY' ||
    /(?:CREDENTIAL|PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTHORIZATION|COOKIE)/u.test(
      upperName
    )
  )
}

const copyEnvironment = (
  source: Readonly<Record<string, string>>,
  allowedNames: ReadonlySet<string>,
  target: Record<string, string>
): void => {
  for (const [name, value] of Object.entries(source)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      !allowedNames.has(name) ||
      isRejectedEnvironmentName(name) ||
      value.length > MAX_ENVIRONMENT_VALUE_LENGTH ||
      hasControlCharacters(value)
    ) {
      throw new Error(`Unsafe curated MCP environment variable: ${name}`)
    }
    target[name] = value
  }
}

export async function createCuratedMcpLaunch(
  options: CuratedMcpLaunchOptions,
  dependencies: CuratedMcpLaunchDependencies = {}
): Promise<CuratedMcpLaunchDescriptor> {
  if (
    options.ownedRoots.length === 0 ||
    options.ownedRoots.some(
      (root) => !isAbsolute(root) || !isSafePathText(root)
    )
  ) {
    throw new Error('Curated MCP requires an absolute allowlisted root')
  }
  if (
    !isAbsolute(options.executable) ||
    !isAbsolute(options.cwd) ||
    !isSafePathText(options.executable) ||
    !isSafePathText(options.cwd) ||
    (options.args?.length ?? 0) > MAX_ARGUMENTS ||
    options.args?.some(
      (argument) =>
        argument.length > MAX_ARGUMENT_LENGTH ||
        hasControlCharacters(argument)
    )
  ) {
    throw new Error('Invalid curated MCP launch parameters')
  }

  const fileSystem = dependencies.fileSystem ?? defaultFileSystem
  const rootMetadata = await Promise.all(
    options.ownedRoots.map((root) => fileSystem.inspect(root))
  )
  rootMetadata.forEach((metadata, index) => {
    assertOwnedCanonicalPath(
      options.ownedRoots[index]!,
      metadata,
      options.ownerUid,
      'directory'
    )
  })

  const [executableMetadata, cwdMetadata] = await Promise.all([
    fileSystem.inspect(options.executable),
    fileSystem.inspect(options.cwd)
  ])
  assertOwnedCanonicalPath(
    options.executable,
    executableMetadata,
    options.ownerUid,
    'file'
  )
  assertOwnedCanonicalPath(
    options.cwd,
    cwdMetadata,
    options.ownerUid,
    'directory'
  )
  if (
    (process.platform !== 'win32' &&
      (executableMetadata.mode & 0o111) === 0) ||
    !rootMetadata.some((root) =>
      isPathInside(root.canonicalPath, executableMetadata.canonicalPath)
    ) ||
    !rootMetadata.some((root) =>
      isPathInside(root.canonicalPath, cwdMetadata.canonicalPath)
    )
  ) {
    throw new Error('Curated MCP paths are outside the owned allowlist')
  }

  const allowedNames = new Set(options.allowedEnvironmentNames ?? [])
  if (
    (options.allowedEnvironmentNames?.length ?? 0) >
      MAX_ENVIRONMENT_ENTRIES ||
    allowedNames.size > MAX_ENVIRONMENT_ENTRIES ||
    [...allowedNames].some(
      (name) =>
        isRejectedEnvironmentName(name) ||
        DESKTOP_ENVIRONMENT_NAMES.has(name.toUpperCase())
    )
  ) {
    throw new Error('Unsafe curated MCP environment allowlist')
  }
  const environment: Record<string, string> = {}
  copyEnvironment(options.environment ?? {}, allowedNames, environment)

  if (options.linuxDesktopEnvironment) {
    const validate =
      dependencies.validateLinuxDesktopEnvironment ??
      buildDesktopHelperEnvironment
    const desktopEnvironment = await validate(
      options.linuxDesktopEnvironment
    )
    copyEnvironment(
      desktopEnvironment as Record<string, string>,
      new Set([
        'PATH',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'XDG_RUNTIME_DIR',
        'DBUS_SESSION_BUS_ADDRESS',
        'XAUTHORITY',
        'NO_AT_BRIDGE'
      ]),
      environment
    )
  }

  const descriptor = Object.freeze({
    transport: 'curated-stdio' as const,
    command: executableMetadata.canonicalPath,
    args: Object.freeze([...(options.args ?? [])]),
    cwd: cwdMetadata.canonicalPath,
    env: Object.freeze({ ...environment })
  }) as CuratedMcpLaunchDescriptor
  descriptors.add(descriptor)
  return descriptor
}

export function isCuratedMcpLaunchDescriptor(
  value: unknown
): value is CuratedMcpLaunchDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    descriptors.has(value)
  )
}
