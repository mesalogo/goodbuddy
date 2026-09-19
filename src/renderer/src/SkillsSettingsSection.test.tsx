import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SkillsSettingsSection } from './SkillsSettingsSection'
import i18n from './i18n'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('moves runtime support to title help while keeping assignment notice and skill descriptions visible', async () => {
  vi.stubGlobal('goodbuddy', { capabilities: { getSnapshot: vi.fn().mockResolvedValue({ skills: [
    { id: 'skill', name: 'Skill', source: 'builtin', enabled: true, description: 'Actual skill description', tags: [], assignments: [] }
  ] }) } })
  render(<SkillsSettingsSection />)
  expect(await screen.findByText('Actual skill description')).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Skills' }).closest('header')?.querySelector('p')).toBeNull()
  expect(screen.getByText(i18n.t('settingsSections:skills.notice'))).toBeVisible()
  expect(screen.queryByText(i18n.t('settingsSections:skills.description'))).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(i18n.t('settingsSections:skills.description'))
  expect(screen.getByRole('tooltip').querySelector('button')).toBeNull()
})
