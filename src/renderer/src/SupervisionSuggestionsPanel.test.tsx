import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n, { changeUiLocale } from './i18n'
import { SupervisionSuggestionsPanel } from './SupervisionSuggestionsPanel'

const base = { resultId: 'result-1', heartbeatRunId: 'run-1', scope: { kind: 'global' }, sourceIds: ['source-1'], entityId: null, relationId: null,
  taskId: null, status: 'pending', createdAt: '2026-09-30T10:00:00Z' }
const stalled = { ...base, id: '00000000-0000-4000-8000-000000000911', kind: 'stalled', title: 'Knowledge import', detail: '14 days without new events',
  storyId: 'story-1', experienceId: null }
const experience = { ...base, id: '00000000-0000-4000-8000-000000000912', kind: 'experience', title: 'Let long jobs run', detail: 'May apply to "Indexing"',
  storyId: 'story-2', experienceId: 'experience-1' }

beforeEach(async () => {
  await changeUiLocale('en-US')
  Object.assign(window, { goodbuddy: { supervision: {
    suggestions: vi.fn(async () => [stalled, experience]),
    suggestionAction: vi.fn(async () => ({ ...stalled, status: 'accepted', taskId: null })),
    source: vi.fn(async () => null)
  } } })
})
afterEach(async () => { await changeUiLocale('zh-CN') })

it('labels story suggestions and opens the story or experience they are about', async () => {
  const onOpenResult = vi.fn()
  render(<SupervisionSuggestionsPanel tasks={[]} onUseFollowUpTask={vi.fn()} onOpenResult={onOpenResult} />)
  const panel = await screen.findByRole('region', { name: i18n.t('suggestions.title', { ns: 'heartbeat' }) })
  expect(within(panel).getByText('No recent progress')).toBeVisible()
  expect(within(panel).getByText('Relevant experience')).toBeVisible()
  const [first, second] = within(panel).getAllByRole('button', { name: i18n.t('supervisor.viewInGraph', { ns: 'heartbeat' }) })
  fireEvent.click(first!)
  expect(onOpenResult).toHaveBeenLastCalledWith('result-1', { kind: 'story', id: 'story-1' })
  fireEvent.click(second!)
  expect(onOpenResult).toHaveBeenLastCalledWith('result-1', { kind: 'experience', id: 'experience-1' })
  expect(within(panel).getByRole('button', { name: 'Create task' })).toBeVisible()
  expect(within(panel).getByRole('button', { name: 'Noted' })).toBeVisible()
})
