import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  createNativeBinding,
  createLinuxPeerIdentityProvider,
  LinuxPeerIdentityProvider,
  type LinuxPeerCredentialNativeBinding
} from './peer-identity-provider'

describe('Linux SO_PEERCRED provider', () => {
  it('returns only kernel-provided credentials for the accepted socket', async () => {
    const native = nativeBinding((descriptor, credentials, length) => {
      expect(descriptor).toBe(42)
      expect(length.readUInt32LE()).toBe(12)
      credentials.writeInt32LE(1234, 0)
      credentials.writeUInt32LE(1000, 4)
      credentials.writeUInt32LE(1000, 8)
      return 0
    })
    const provider = new LinuxPeerIdentityProvider(native)

    await expect(
      provider.getPeerIdentity(socketWithDescriptor(42))
    ).resolves.toEqual({ uid: 1000, pid: 1234 })
  })

  it('fails closed on missing descriptors, native errors, and ABI mismatch', async () => {
    const provider = new LinuxPeerIdentityProvider(
      nativeBinding((_descriptor, _credentials, length) => {
        length.writeUInt32LE(8)
        return 0
      })
    )
    await expect(
      provider.getPeerIdentity({} as Socket)
    ).rejects.toMatchObject({
      code: 'peer-identity-unavailable'
    })
    await expect(
      new LinuxPeerIdentityProvider(
        nativeBinding(() => -1, 13)
      ).getPeerIdentity(socketWithDescriptor(7))
    ).rejects.toThrow('errno 13')
    await expect(
      provider.getPeerIdentity(socketWithDescriptor(7))
    ).rejects.toThrow('invalid ABI size')
  })

  it('rejects unsupported platforms and ABIs before loading native code', async () => {
    const loadKoffi = vi.fn()
    await expect(
      createLinuxPeerIdentityProvider({
        platform: 'win32',
        architecture: 'x64',
        byteOrder: 'LE',
        loadKoffi
      })
    ).rejects.toMatchObject({
      code: 'peer-identity-unavailable'
    })
    await expect(
      createLinuxPeerIdentityProvider({
        platform: 'linux',
        architecture: 'ia32',
        byteOrder: 'LE',
        loadKoffi
      })
    ).rejects.toMatchObject({
      code: 'peer-identity-unavailable'
    })
    await expect(
      createLinuxPeerIdentityProvider({
        platform: 'linux',
        architecture: 'arm64',
        byteOrder: 'BE',
        loadKoffi
      })
    ).rejects.toMatchObject({
      code: 'peer-identity-unavailable'
    })
    expect(loadKoffi).not.toHaveBeenCalled()
    expect(() =>
      createNativeBinding({
        sizeof: () => 8
      } as never)
    ).toThrow('integer ABI is unsupported')
  })
})

function nativeBinding(
  getSocketPeerCredentials: LinuxPeerCredentialNativeBinding[
    'getSocketPeerCredentials'
  ],
  errorNumber = 0
): LinuxPeerCredentialNativeBinding {
  return {
    getSocketPeerCredentials,
    errno: () => errorNumber
  }
}

function socketWithDescriptor(descriptor: number): Socket {
  return {
    _handle: { fd: descriptor }
  } as unknown as Socket
}
