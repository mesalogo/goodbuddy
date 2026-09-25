import { expect, it } from 'vitest'
import { supervisionNavigationOutputSchema, supervisionSummaryOutputSchema, supervisionResultViewSchema } from './supervision-contracts'

it('accepts complete generated content beyond former per-field and collection limits', () => {
  const content = 'Retained detail. '.repeat(900)
  const output = {
    summary: content, changeDigest: content, openItems: Array(21).fill(content),
    events: Array.from({ length: 41 }, (_, i) => ({ title: content, description: content, occurredAt: '2026-09-24T00:00:00Z', eventType: 'decision', entityIds: [`entity_${i}`], sourceReferenceIds: Array.from({ length: 21 }, (_, j) => `source_${j}`) })),
    entities: Array.from({ length: 41 }, (_, i) => ({ id: `entity_${i}`, label: content, description: content, sourceReferenceIds: [] })),
    entityChanges: Array.from({ length: 81 }, () => ({ entityId: 'entity_0', changeType: 'revised', description: content, sourceReferenceIds: [] })),
    relations: Array.from({ length: 81 }, () => ({ fromEntityId: 'entity_0', toEntityId: 'entity_1', relationType: 'related', reason: content, sourceReferenceIds: [] }))
  }
  expect(supervisionSummaryOutputSchema.parse(output)).toEqual(output)
  const navigation = { summary: content, changeDigest: content, openItems: output.openItems }
  expect(supervisionNavigationOutputSchema.parse(navigation)).toEqual(navigation)
  const result = { ...navigation, id: 'result', storyLineId: 'story', sourceId: null, createdAt: '2026-09-24T00:00:00Z', scope: { kind: 'global' }, timeRange: { from: '2026-09-17T08:03:00Z', to: '2026-09-24T08:03:00Z' } }
  expect(supervisionResultViewSchema.parse(result)).toEqual(result)
  expect(supervisionNavigationOutputSchema.safeParse({ ...navigation, events: output.events }).success).toBe(false)
  expect(supervisionSummaryOutputSchema.safeParse({ ...output, events: undefined }).success).toBe(false)
})
