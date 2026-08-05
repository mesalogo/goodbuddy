import { describe, expect, it } from 'vitest'
import {
  probeLinuxDesktopCapabilities,
  type LinuxCapabilityProbes
} from './capability-probe'

const probes = (
  overrides: Partial<LinuxCapabilityProbes> = {}
): LinuxCapabilityProbes => ({
  sessionBus: async () => true,
  accessibilityBus: async () => ({
    busOwner: true,
    registryOwner: true
  }),
  portalVersions: async () => ({ screenCast: 4, remoteDesktop: 2 }),
  pipeWire: async () => true,
  eis: async () => true,
  x11: async () => false,
  xTest: async () => false,
  ydotool: async () => false,
  electronCapture: async () => true,
  ...overrides
})

describe('probeLinuxDesktopCapabilities', () => {
  it('reports concrete protocol checks without using desktop labels', async () => {
    const result = await probeLinuxDesktopCapabilities(probes(), {
      XDG_CURRENT_DESKTOP: 'GNOME:Treeland'
    })

    expect(result.overall).toBe('supported')
    expect(result.sessionLabels).toEqual(['GNOME', 'Treeland'])
    expect(result.checks).toContainEqual({
      capability: 'portal-remote-desktop',
      status: 'supported',
      diagnostic: 'RemoteDesktop portal version 2 responded'
    })
    expect(result.checks.find((check) => check.capability === 'xtest')?.status)
      .toBe('unavailable')
  })

  it('does not infer availability from a known desktop product name', async () => {
    const unavailable = probes({
      sessionBus: async () => false,
      accessibilityBus: async () => ({
        busOwner: false,
        registryOwner: false
      }),
      portalVersions: async () => ({}),
      pipeWire: async () => false,
      eis: async () => false,
      electronCapture: async () => false
    })
    const result = await probeLinuxDesktopCapabilities(unavailable, {
      XDG_CURRENT_DESKTOP: 'KDE'
    })

    expect(result.overall).toBe('unavailable')
    expect(result.sessionLabels).toEqual(['KDE'])
    expect(result.checks.every((check) => check.status === 'unavailable')).toBe(
      true
    )
  })

  it('contains bounded diagnostics rather than thrown details or environment values', async () => {
    const result = await probeLinuxDesktopCapabilities(
      probes({
        sessionBus: async () => {
          throw new Error(
            'address=unix:path=/run/user/1000/bus token=very-secret'
          )
        },
        ydotool: async () => true,
        accessibilityBus: async () => ({
          busOwner: true,
          registryOwner: false
        })
      }),
      { DBUS_SESSION_BUS_ADDRESS: 'private-address' }
    )
    const diagnostics = result.checks
      .map((check) => check.diagnostic)
      .join(' ')

    expect(diagnostics).not.toContain('/run/')
    expect(diagnostics).not.toContain('secret')
    expect(diagnostics).not.toContain('private-address')
    expect(
      result.checks.find((check) => check.capability === 'accessibility')
        ?.status
    ).toBe('degraded')
    expect(
      result.checks.find((check) => check.capability === 'ydotool')?.status
    ).toBe('supported')
  })
})
