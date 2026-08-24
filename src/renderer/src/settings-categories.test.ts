import { describe, expect, it } from 'vitest'
import { getSettingsCategoryList } from './settings-categories'

describe('getSettingsCategoryList', () => {
  it('hides SSH hosts while Remote Projects is disabled', () => {
    expect(
      getSettingsCategoryList(false).map(({ id }) => id)
    ).not.toContain('ssh-hosts')
  })

  it('includes SSH hosts while Remote Projects is enabled', () => {
    expect(
      getSettingsCategoryList(true).map(({ id }) => id)
    ).toContain('ssh-hosts')
  })
})
