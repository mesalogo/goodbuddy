import { afterEach, describe, expect, it, vi } from 'vitest'

const key = 'goodbuddy.interface-layout'

async function load(mode: string) {
  vi.resetModules()
  vi.stubEnv('MODE', mode)
  return (await import('./interface-layout')).loadInterfaceLayout()
}

describe('interface layout preference', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    localStorage.removeItem(key)
  })

  it('opens upgrades and new installs without a saved choice in the workbench', async () => {
    expect(await load('production')).toBe('workbench')
    localStorage.setItem(key, 'unknown')
    expect(await load('production')).toBe('workbench')
  })

  it('keeps a layout the user picked in Settings', async () => {
    localStorage.setItem(key, 'classic')
    expect(await load('production')).toBe('classic')
    localStorage.setItem(key, 'workbench')
    expect(await load('production')).toBe('workbench')
  })
})
