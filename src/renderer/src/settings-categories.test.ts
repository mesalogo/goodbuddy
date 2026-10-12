import { describe, expect, it } from 'vitest'
import { getSettingsCategoryList } from './settings-categories'

describe('getSettingsCategoryList', () => {
  it('defines an icon for every settings category', () => {
    expect(
      getSettingsCategoryList().every(({ icon }) => icon != null)
    ).toBe(true)
  })

  it('no longer lists SSH hosts, which moved to the Hosts application', () => {
    expect(
      getSettingsCategoryList().map(({ id }) => id as string)
    ).not.toContain('ssh-hosts')
  })
})
