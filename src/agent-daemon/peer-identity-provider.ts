import { arch, endianness } from 'node:os'
import type { Socket } from 'node:net'
import type koffiType from 'koffi'
import { AgentUnsupportedError } from './errors'
import type {
  PeerIdentity,
  UnixPeerIdentityProvider
} from './private-endpoint'

const SOL_SOCKET = 1
const SO_PEERCRED = 17
const LINUX_UCRED_BYTES = 12
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64'])

type Koffi = typeof koffiType

export type LinuxPeerCredentialNativeBinding = {
  getSocketPeerCredentials(
    descriptor: number,
    credentials: Buffer,
    length: Buffer
  ): number
  errno(): number
}

export class LinuxPeerIdentityProvider
  implements UnixPeerIdentityProvider
{
  readonly #native: LinuxPeerCredentialNativeBinding

  constructor(native: LinuxPeerCredentialNativeBinding) {
    this.#native = native
  }

  async getPeerIdentity(socket: Socket): Promise<PeerIdentity> {
    const descriptor = socketDescriptor(socket)
    const credentials = Buffer.alloc(LINUX_UCRED_BYTES)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(credentials.byteLength)
    const result = this.#native.getSocketPeerCredentials(
      descriptor,
      credentials,
      length
    )
    if (result !== 0) {
      const nativeError = this.#native.errno()
      throw new Error(
        `getsockopt(SO_PEERCRED) failed with errno ${nativeError}`
      )
    }
    if (length.readUInt32LE() !== LINUX_UCRED_BYTES) {
      throw new Error('getsockopt(SO_PEERCRED) returned an invalid ABI size')
    }
    const pid = credentials.readInt32LE(0)
    const uid = credentials.readUInt32LE(4)
    if (pid <= 0) {
      throw new Error('getsockopt(SO_PEERCRED) returned an invalid PID')
    }
    return { uid, pid }
  }
}

export async function createLinuxPeerIdentityProvider(
  options: {
    platform?: NodeJS.Platform
    architecture?: string
    byteOrder?: 'BE' | 'LE'
    loadKoffi?: () => Promise<Koffi>
  } = {}
): Promise<LinuxPeerIdentityProvider> {
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? arch()
  const byteOrder = options.byteOrder ?? endianness()
  if (
    platform !== 'linux' ||
    !SUPPORTED_ARCHITECTURES.has(architecture) ||
    byteOrder !== 'LE'
  ) {
    throw unavailable(
      'SO_PEERCRED is certified only on little-endian Linux x64 and arm64'
    )
  }
  try {
    const koffi =
      await (options.loadKoffi?.() ??
        import('koffi').then((module) => module.default))
    return new LinuxPeerIdentityProvider(createNativeBinding(koffi))
  } catch (error) {
    if (error instanceof AgentUnsupportedError) {
      throw error
    }
    throw unavailable(
      `SO_PEERCRED native binding is unavailable: ${boundedError(error)}`
    )
  }
}

export function createNativeBinding(
  koffi: Koffi
): LinuxPeerCredentialNativeBinding {
  if (
    koffi.sizeof('int32_t') !== 4 ||
    koffi.sizeof('uint32_t') !== 4
  ) {
    throw unavailable('Linux peer credential integer ABI is unsupported')
  }
  const libc = koffi.load(null)
  const getsockopt = libc.func('getsockopt', 'int', [
    'int',
    'int',
    'int',
    'void *',
    'void *'
  ])
  return {
    getSocketPeerCredentials: (
      descriptor,
      credentials,
      length
    ): number =>
      getsockopt(
        descriptor,
        SOL_SOCKET,
        SO_PEERCRED,
        credentials,
        length
      ) as number,
    errno: () => koffi.errno()
  }
}

function socketDescriptor(socket: Socket): number {
  const descriptor = (
    socket as Socket & {
      _handle?: { fd?: unknown }
    }
  )._handle?.fd
  if (
    typeof descriptor !== 'number' ||
    !Number.isSafeInteger(descriptor) ||
    descriptor < 0
  ) {
    throw unavailable('The accepted Unix socket descriptor is unavailable')
  }
  return descriptor
}

function unavailable(message: string): AgentUnsupportedError {
  return new AgentUnsupportedError(
    message,
    'peer-identity-unavailable'
  )
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(/\s+/gu, ' ').trim().slice(0, 500)
}
