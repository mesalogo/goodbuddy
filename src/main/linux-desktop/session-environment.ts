import { isAbsolute, basename, posix } from 'node:path'

export type SecurePathMetadata = {
  canonicalPath: string
  uid: number
  mode: number
  isDirectory: boolean
  isFile: boolean
  isSymbolicLink: boolean
}

export interface SessionEnvironmentFileSystem {
  inspect(path: string): Promise<SecurePathMetadata>
}

export type SessionEnvironmentOptions = {
  source?: NodeJS.ProcessEnv
  uid: number
  fileSystem: SessionEnvironmentFileSystem
}

const DISPLAY_PATTERN = /^(?:(?:[A-Za-z0-9._-]+)?):\d+(?:\.\d+)?$/
const WAYLAND_BASENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LOCALE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/
const DBUS_VALUE_PATTERN = /^(?:[A-Za-z0-9._~:/@+-]|%[0-9A-Fa-f]{2})+$/

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })

const isSafePathText = (value: string): boolean =>
  value.length >= 1 &&
  value.length <= 8192 &&
  !hasControlCharacters(value)

const assertSafePath = async (
  path: string,
  expectedKind: 'directory' | 'file',
  options: SessionEnvironmentOptions
): Promise<string> => {
  if (!isAbsolute(path) || !isSafePathText(path)) {
    throw new Error(`Invalid ${expectedKind} path`)
  }
  const metadata = await options.fileSystem.inspect(path)
  if (
    metadata.isSymbolicLink ||
    metadata.canonicalPath !== path ||
    metadata.uid !== options.uid ||
    (metadata.mode & 0o022) !== 0 ||
    (expectedKind === 'directory'
      ? !metadata.isDirectory
      : !metadata.isFile)
  ) {
    throw new Error(`Unsafe ${expectedKind} path`)
  }
  return path
}

const validateBusAddress = (address: string): string => {
  if (
    address.length === 0 ||
    address.length > 4096 ||
    hasControlCharacters(address)
  ) {
    throw new Error('Invalid session bus address')
  }
  const alternatives = address.split(';')
  if (alternatives.some((entry) => entry.length === 0)) {
    throw new Error('Invalid session bus address')
  }
  for (const entry of alternatives) {
    const separator = entry.indexOf(':')
    if (separator <= 0 || !/^[a-z][a-z0-9_-]*$/.test(entry.slice(0, separator))) {
      throw new Error('Invalid session bus address')
    }
    const properties = entry.slice(separator + 1).split(',')
    if (properties.some((property) => property.length === 0)) {
      throw new Error('Invalid session bus address')
    }
    const seen = new Set<string>()
    for (const property of properties) {
      const equals = property.indexOf('=')
      const key = property.slice(0, equals)
      const value = property.slice(equals + 1)
      if (
        equals <= 0 ||
        !/^[a-z][a-z0-9_-]*$/.test(key) ||
        !DBUS_VALUE_PATTERN.test(value) ||
        seen.has(key)
      ) {
        throw new Error('Invalid session bus address')
      }
      seen.add(key)
    }
  }
  return address
}

const copySafeValue = (
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp
): void => {
  const value = source[name]
  if (value !== undefined) {
    if (!pattern.test(value)) {
      throw new Error(`Invalid ${name}`)
    }
    target[name] = value
  }
}

const copySafePath = (
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv
): void => {
  const value = source.PATH
  if (value === undefined) {
    return
  }
  const entries = value.split(':')
  if (
    !isSafePathText(value) ||
    entries.length === 0 ||
    entries.some((entry) => !posix.isAbsolute(entry))
  ) {
    throw new Error('Invalid PATH')
  }
  target.PATH = value
}

/**
 * Builds a new environment rather than filtering in place. Native desktop
 * helpers must never inherit loader hooks, provider credentials, or proxies.
 */
export async function buildDesktopHelperEnvironment(
  options: SessionEnvironmentOptions
): Promise<NodeJS.ProcessEnv> {
  const source = options.source ?? process.env
  const environment: NodeJS.ProcessEnv = {}

  copySafePath(environment, source)
  copySafeValue(environment, source, 'LANG', LOCALE_PATTERN)
  copySafeValue(environment, source, 'LC_ALL', LOCALE_PATTERN)
  copySafeValue(environment, source, 'LC_CTYPE', LOCALE_PATTERN)

  const display = source.DISPLAY
  if (display !== undefined) {
    if (!DISPLAY_PATTERN.test(display)) {
      throw new Error('Invalid DISPLAY')
    }
    environment.DISPLAY = display
  }

  const runtimeDirectory = source.XDG_RUNTIME_DIR
  if (runtimeDirectory !== undefined) {
    environment.XDG_RUNTIME_DIR = await assertSafePath(
      runtimeDirectory,
      'directory',
      options
    )
  }

  const waylandDisplay = source.WAYLAND_DISPLAY
  if (waylandDisplay !== undefined) {
    if (
      basename(waylandDisplay) !== waylandDisplay ||
      !WAYLAND_BASENAME_PATTERN.test(waylandDisplay) ||
      runtimeDirectory === undefined
    ) {
      throw new Error('Invalid WAYLAND_DISPLAY')
    }
    environment.WAYLAND_DISPLAY = waylandDisplay
  }

  const busAddress = source.DBUS_SESSION_BUS_ADDRESS
  if (busAddress !== undefined) {
    environment.DBUS_SESSION_BUS_ADDRESS = validateBusAddress(busAddress)
  }

  const authority = source.XAUTHORITY
  if (authority !== undefined) {
    environment.XAUTHORITY = await assertSafePath(
      authority,
      'file',
      options
    )
  }

  if (source.NO_AT_BRIDGE === '1') {
    environment.NO_AT_BRIDGE = '1'
  }

  return environment
}
