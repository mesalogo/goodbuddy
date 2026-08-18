import { describe, expect, it } from 'vitest'
import {
  computerCapabilityCatalog,
  getComputerCapability,
  isComputerCapabilitySupported
} from './computer-capability-catalog'

describe('computer capability catalog', () => {
  it('defines immutable, disabled curated capabilities without launch overrides', () => {
    expect(computerCapabilityCatalog.map(({ id }) => id)).toEqual([
      'host-browser-control',
      'linux-desktop-control'
    ])
    for (const capability of computerCapabilityCatalog) {
      expect(capability.enabledByDefault).toBe(false)
      expect(capability.requiredDiagnostics.length).toBeGreaterThan(0)
      expect(capability).not.toHaveProperty('executable')
      expect(capability).not.toHaveProperty('args')
      expect(capability).not.toHaveProperty('env')
    }
    expect(Object.isFrozen(computerCapabilityCatalog)).toBe(true)
  })

  it('rejects unsupported platform and architecture combinations', () => {
    const browser = getComputerCapability('host-browser-control')
    const desktop = getComputerCapability('linux-desktop-control')

    expect(isComputerCapabilitySupported(browser, 'win32', 'x64')).toBe(true)
    expect(isComputerCapabilitySupported(browser, 'linux', 'arm64')).toBe(true)
    expect(isComputerCapabilitySupported(browser, 'win32', 'ia32')).toBe(false)
    expect(isComputerCapabilitySupported(browser, 'freebsd', 'x64')).toBe(false)
    expect(isComputerCapabilitySupported(desktop, 'darwin', 'arm64')).toBe(
      false
    )
    expect(isComputerCapabilitySupported(desktop, 'linux', 'x64')).toBe(false)
    expect(
      isComputerCapabilitySupported(
        desktop,
        'linux',
        'x64',
        new Set(['managed-linux-desktop-driver'])
      )
    ).toBe(true)
    expect(browser.name).toBe('内置浏览器')
    expect(browser.description).toContain('不会控制客户端已安装的浏览器')
    expect(browser.riskSummary).toContain('不再逐次询问')
    expect(desktop.description).toContain('技术预览')
    expect(desktop.riskSummary).toContain('尚未')
  })
})
