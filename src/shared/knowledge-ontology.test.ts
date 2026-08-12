import { describe, expect, it } from 'vitest'
import {
  defaultKnowledgeOntologySettings,
  getKnowledgeOntologyDisplayDefinitions,
  isRelationEndpointAllowed,
  knowledgeOntologySettingsSchema,
  normalizeEntityTypeAlias,
  normalizeRelationTypeAlias
} from './knowledge-ontology'

describe('knowledge ontology contract', () => {
  it('provides the version 1 controlled defaults and useful aliases', () => {
    expect(defaultKnowledgeOntologySettings.version).toBe(1)
    expect(
      defaultKnowledgeOntologySettings.entityTypes.map(({ id }) => id)
    ).toEqual([
      'PERSON',
      'ORGANIZATION',
      'EVENT',
      'LOCATION',
      'DOCUMENT',
      'CONCEPT'
    ])
    expect(normalizeEntityTypeAlias('people')).toBe('PERSON')
    expect(normalizeEntityTypeAlias('人员')).toBe('PERSON')
    expect(normalizeEntityTypeAlias('公司')).toBe('ORGANIZATION')
    expect(normalizeEntityTypeAlias('uncontrolled legacy type')).toBe('CONCEPT')
    expect(normalizeRelationTypeAlias('depends on')).toBe('DEPENDS_ON')
    expect(normalizeRelationTypeAlias('依赖于')).toBe('DEPENDS_ON')
  })

  it('rejects noncanonical ids, collisions, missing fallback, and bad endpoints', () => {
    const concept = {
      id: 'CONCEPT',
      name: { zh: '概念', en: 'Concept' },
      aliases: ['topic']
    }
    expect(() =>
      knowledgeOntologySettingsSchema.parse({
        entityTypes: [concept, { ...concept, id: 'person' }],
        relationTypes: []
      })
    ).toThrow()
    expect(() =>
      knowledgeOntologySettingsSchema.parse({
        entityTypes: [
          concept,
          {
            id: 'PERSON',
            name: { zh: '人物', en: 'Person' },
            aliases: ['shared']
          },
          {
            id: 'ORGANIZATION',
            name: { zh: '组织', en: 'Organization' },
            aliases: ['shared']
          }
        ],
        relationTypes: []
      })
    ).toThrow()
    expect(() =>
      knowledgeOntologySettingsSchema.parse({
        entityTypes: [
          {
            id: 'PERSON',
            name: { zh: '人物', en: 'Person' },
            aliases: []
          }
        ],
        relationTypes: []
      })
    ).toThrow()
    expect(() =>
      knowledgeOntologySettingsSchema.parse({
        entityTypes: [concept],
        relationTypes: [
          {
            id: 'KNOWS',
            name: { zh: '认识', en: 'Knows' },
            aliases: [],
            sourceTypes: ['MISSING']
          }
        ]
      })
    ).toThrow()
  })

  it('enforces optional relation endpoint constraints', () => {
    const settings = knowledgeOntologySettingsSchema.parse({
      entityTypes: [
        {
          id: 'CONCEPT',
          name: { zh: '概念', en: 'Concept' },
          aliases: []
        },
        {
          id: 'PERSON',
          name: { zh: '人物', en: 'Person' },
          aliases: ['people']
        },
        {
          id: 'ORGANIZATION',
          name: { zh: '组织', en: 'Organization' },
          aliases: ['company']
        }
      ],
      relationTypes: [
        {
          id: 'WORKS_FOR',
          name: { zh: '任职于', en: 'Works for' },
          aliases: ['works for'],
          sourceTypes: ['PERSON'],
          targetTypes: ['ORGANIZATION']
        }
      ]
    })

    expect(isRelationEndpointAllowed('works for', 'people', 'company', settings)).toBe(
      true
    )
    expect(
      isRelationEndpointAllowed('WORKS_FOR', 'ORGANIZATION', 'PERSON', settings)
    ).toBe(false)
    expect(isRelationEndpointAllowed('UNKNOWN', 'PERSON', 'ORGANIZATION', settings)).toBe(
      false
    )
  })

  it('returns localized, detached display data', () => {
    const display = getKnowledgeOntologyDisplayDefinitions(
      defaultKnowledgeOntologySettings,
      'en'
    )
    expect(display.fallbackEntityType).toBe('CONCEPT')
    expect(display.entityTypes.find(({ id }) => id === 'PERSON')?.label).toBe(
      'Person'
    )
    display.entityTypes[0]?.aliases.push('local mutation')
    expect(defaultKnowledgeOntologySettings.entityTypes[0]?.aliases).not.toContain(
      'local mutation'
    )
  })
})
