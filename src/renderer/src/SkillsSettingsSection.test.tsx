import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SkillsSettingsSection } from './SkillsSettingsSection'
import i18n from './i18n'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps skill descriptions visible and places import actions in the content area', async () => {
  vi.stubGlobal('goodbuddy', { capabilities: { getSnapshot: vi.fn().mockResolvedValue({ skills: [
    { id: 'skill', name: 'Skill', source: 'builtin', enabled: true, description: 'Actual skill description', tags: [], assignments: [] }
  ] }) } })
  render(<SkillsSettingsSection />)
  expect(await screen.findByText('Actual skill description')).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'Skills' })).not.toBeInTheDocument()
  expect(screen.getByText(i18n.t('settingsSections:skills.notice'))).toBeVisible()
  expect(screen.queryByText(i18n.t('settingsSections:skills.description'))).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', {
      name: i18n.t('settingsSections:skills.actions.importDirectory')
    })
  ).toBeVisible()
  expect(
    screen.getByRole('button', {
      name: i18n.t('settingsSections:skills.actions.importZip')
    })
  ).toBeVisible()
})
