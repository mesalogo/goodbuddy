import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { assertDesktopUpdateRestartReady } from './desktop-update-restart-guard'
import { useWorkspaceUnsavedChanges } from './workspace-unsaved-changes'
import { createComposerDraftStore } from './composer-draft-store'

const idle = { ready: true, activeRequests: 0, taskStatuses: [], hasComposerDrafts: false, knowledgeBusy: false }
afterEach(cleanup)
function Dirty({ dirty }: { dirty: boolean }) { useWorkspaceUnsavedChanges(dirty); return null }

describe('update restart renderer preflight', () => {
  it.each([
    { ready: false }, { activeRequests: 1 }, { knowledgeBusy: true },
    { taskStatuses: ['queued'] }, { taskStatuses: ['waiting_approval'] }, { hasComposerDrafts: true }
  ])('blocks unfinished work: %j', change => {
    expect(() => assertDesktopUpdateRestartReady({ ...idle, ...change })).toThrow()
  })
  it('tracks dirty editors outside the visible route and releases them on save', () => {
    const { rerender, unmount } = render(<Dirty dirty />)
    expect(() => assertDesktopUpdateRestartReady(idle)).toThrow('未保存')
    rerender(<Dirty dirty={false} />)
    expect(() => assertDesktopUpdateRestartReady(idle)).not.toThrow()
    unmount()
    expect(() => assertDesktopUpdateRestartReady(idle)).not.toThrow()
  })
  it('checks drafts in every conversation rather than just the selected one', () => {
    const store = createComposerDraftStore()
    store.set('background', 'unfinished input')
    expect(store.hasDrafts()).toBe(true)
    store.delete('background')
    expect(store.hasDrafts()).toBe(false)
  })
  it('honors existing beforeunload guards without unloading the page', () => {
    const prevent = (event: Event) => event.preventDefault()
    window.addEventListener('beforeunload', prevent)
    try { expect(() => assertDesktopUpdateRestartReady(idle)).toThrow('未保存') }
    finally { window.removeEventListener('beforeunload', prevent) }
    expect(() => assertDesktopUpdateRestartReady(idle)).not.toThrow()
  })
})
