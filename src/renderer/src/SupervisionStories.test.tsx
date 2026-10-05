import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SupervisionStoryView } from '../../shared/supervision-story-contracts'
import { useSupervisionStories } from './SupervisionStories'

const scopeA = { kind: 'projects' as const, projectIds: ['11111111-1111-4111-8111-111111111111'] }
const scopeB = { kind: 'projects' as const, projectIds: ['22222222-2222-4222-8222-222222222222'] }
const rename = { action: 'rename' as const, storyId: '11111111-1111-4111-8111-111111111111', name: 'Renamed story' }
const snapshot = (name: string): SupervisionStoryView => ({ stories: [{ id: rename.storyId, name, projectId: null,
  projectName: null, parentId: null, level: 'feature', description: '', state: 'active', stateEventId: null,
  userEdited: false, events: [], startedAt: null, endedAt: null }], experiences: [], unassigned: 0, canUndo: false })

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.goodbuddy = {} as never })

it.each(['scope', 'refresh revision'] as const)('does not let a retained mutation reload invalidate the new %s read', async change => {
  const initial = snapshot('Initial'), current = snapshot('Current'), stale = snapshot('Stale mutation reload')
  let finishMutation!: () => void
  let finishCurrent!: (value: SupervisionStoryView) => void
  const storyAction = vi.fn(() => new Promise<void>(resolve => { finishMutation = resolve }))
  const stories = vi.fn().mockResolvedValueOnce(initial)
    .mockImplementationOnce(() => new Promise<SupervisionStoryView>(resolve => { finishCurrent = resolve }))
    .mockResolvedValue(stale)
  window.goodbuddy = { supervision: { stories, storyAction } } as never
  const revision = {}
  const view = renderHook(({ scope, revision }) => useSupervisionStories(scope, true, revision),
    { initialProps: { scope: scopeA, revision } })
  await waitFor(() => expect(view.result.current.view).toBe(initial))
  let mutation!: Promise<boolean>
  act(() => { mutation = view.result.current.act(rename) })
  view.rerender({ scope: change === 'scope' ? scopeB : scopeA, revision: change === 'scope' ? revision : {} })
  await waitFor(() => expect(stories).toHaveBeenCalledTimes(2))
  // The old action finishes while the replacement read is still pending.
  await act(async () => { finishMutation(); await mutation })
  await act(async () => finishCurrent(current))
  await waitFor(() => expect(view.result.current.view).toBe(current))
  expect(stories).toHaveBeenCalledTimes(2)
  expect(view.result.current.error).toBeUndefined()
  expect(view.result.current.pending).toBe(false)
})

it('rejects a retained reload before sending a request after same-scope refresh or unmount', async () => {
  const current = snapshot('Current')
  const stories = vi.fn().mockResolvedValue(current)
  window.goodbuddy = { supervision: { stories } } as never
  const view = renderHook(({ revision }) => useSupervisionStories(scopeA, true, revision), { initialProps: { revision: 1 } })
  await waitFor(() => expect(view.result.current.view).toBe(current))
  const obsoleteReload = view.result.current.reload
  view.rerender({ revision: 2 })
  await waitFor(() => expect(stories).toHaveBeenCalledTimes(2))
  await act(async () => obsoleteReload())
  expect(stories).toHaveBeenCalledTimes(2)
  const unmountedReload = view.result.current.reload
  view.unmount()
  await unmountedReload()
  expect(stories).toHaveBeenCalledTimes(2)
})

it('still reloads an owned mutation and reuses its refreshed snapshot on tab return', async () => {
  const initial = snapshot('Initial'), updated = snapshot('Renamed story')
  const stories = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(updated)
  const storyAction = vi.fn().mockResolvedValue(undefined)
  window.goodbuddy = { supervision: { stories, storyAction } } as never
  const view = renderHook(({ active }) => useSupervisionStories(scopeA, active, 1), { initialProps: { active: true } })
  await waitFor(() => expect(view.result.current.view).toBe(initial))
  await act(async () => { expect(await view.result.current.act(rename)).toBe(true) })
  expect(view.result.current.view).toBe(updated)
  expect(stories).toHaveBeenCalledTimes(2)
  expect(storyAction).toHaveBeenCalledWith(rename)
  view.rerender({ active: false })
  view.rerender({ active: true })
  expect(view.result.current.view).toBe(updated)
  expect(stories).toHaveBeenCalledTimes(2)
})
