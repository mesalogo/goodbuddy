import { describe, expect, it } from 'vitest'
import { parseContinueChecklist, runtimeChecklistSchema } from './runtime-checklist'

describe('native runtime checklist', () => {
  it('preserves long lists, duplicate items and explicit clears', () => {
    const content = 'task'.repeat(1500)
    expect(parseContinueChecklist('Checklist', { checklist: `- [ ] ${content}\n- [X] ${content}` })).toEqual({
      source: 'continue', items: [{ content, status: 'pending' }, { content, status: 'completed' }]
    })
    expect(runtimeChecklistSchema.parse(parseContinueChecklist('Checklist', '{"checklist":""}'))).toEqual({ source: 'continue', items: [] })
  })
  it('rejects unrelated tools and malformed lists without clearing', () => {
    for (const input of [{}, { checklist: [] }, { checklist: '- [ ] valid\ninvalid' }, { checklist: '- [ ]    ' }, '{']) {
      expect(parseContinueChecklist('Checklist', input)).toBeUndefined()
    }
    expect(parseContinueChecklist('checklist', { checklist: '' })).toBeUndefined()
    expect(runtimeChecklistSchema.safeParse({ source: 'opencode', items: [{ content: 'x', status: 'done' }] }).success).toBe(false)
  })
})
