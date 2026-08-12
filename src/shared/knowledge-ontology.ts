import { z } from 'zod'

export const KNOWLEDGE_ONTOLOGY_LIMITS = {
  maximumEntityTypes: 64,
  maximumRelationTypes: 128,
  maximumAliases: 32,
  maximumEndpointTypes: 64,
  maximumIdLength: 64,
  maximumLabelLength: 80,
  maximumDescriptionLength: 500,
  maximumAliasLength: 80
} as const

const canonicalIdSchema = z
  .string()
  .min(1)
  .max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumIdLength)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be a canonical uppercase identifier')

const localizedTextSchema = z
  .object({
    zh: z.string().trim().min(1).max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumLabelLength),
    en: z.string().trim().min(1).max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumLabelLength)
  })
  .strict()

const localizedDescriptionSchema = z
  .object({
    zh: z
      .string()
      .trim()
      .min(1)
      .max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumDescriptionLength),
    en: z
      .string()
      .trim()
      .min(1)
      .max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumDescriptionLength)
  })
  .strict()

const aliasesSchema = z
  .array(
    z.string().trim().min(1).max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumAliasLength)
  )
  .max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumAliases)
  .default([])

export const knowledgeOntologyEntityTypeSchema = z
  .object({
    id: canonicalIdSchema,
    name: localizedTextSchema,
    description: localizedDescriptionSchema.optional(),
    aliases: aliasesSchema
  })
  .strict()
export type KnowledgeOntologyEntityType = z.infer<
  typeof knowledgeOntologyEntityTypeSchema
>

export const knowledgeOntologyRelationTypeSchema = z
  .object({
    id: canonicalIdSchema,
    name: localizedTextSchema,
    description: localizedDescriptionSchema.optional(),
    aliases: aliasesSchema,
    sourceTypes: z
      .array(canonicalIdSchema)
      .min(1)
      .max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumEndpointTypes)
      .optional(),
    targetTypes: z
      .array(canonicalIdSchema)
      .min(1)
      .max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumEndpointTypes)
      .optional()
  })
  .strict()
export type KnowledgeOntologyRelationType = z.infer<
  typeof knowledgeOntologyRelationTypeSchema
>

/**
 * Normalizes user/model spelling for lookup only. Canonical ids in persisted
 * settings remain strict uppercase ids.
 */
export function normalizeOntologyAlias(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s-]+/g, '_')
}

function addUniquenessIssues(
  definitions: readonly {
    id: string
    aliases: readonly string[]
  }[],
  path: 'entityTypes' | 'relationTypes',
  context: z.RefinementCtx
): void {
  const owners = new Map<string, { id: string; index: number }>()
  for (const [index, definition] of definitions.entries()) {
    const key = normalizeOntologyAlias(definition.id)
    const owner = owners.get(key)
    if (owner) {
      context.addIssue({
        code: 'custom',
        path: [path, index, 'id'],
        message: `duplicate id ${definition.id}`
      })
    } else {
      owners.set(key, { id: definition.id, index })
    }
  }
  for (const [index, definition] of definitions.entries()) {
    const localAliases = new Set<string>()
    for (const value of definition.aliases) {
      const key = normalizeOntologyAlias(value)
      if (localAliases.has(key)) {
        context.addIssue({
          code: 'custom',
          path: [path, index, 'aliases'],
          message: `duplicate alias "${value}"`
        })
        continue
      }
      localAliases.add(key)
      const owner = owners.get(key)
      if (owner && owner.id !== definition.id) {
        context.addIssue({
          code: 'custom',
          path: [path, index, 'aliases'],
          message: `alias "${value}" already maps to ${owner.id}`
        })
      } else {
        owners.set(key, { id: definition.id, index })
      }
    }
  }
}

const defaultEntityTypesInput = [
  {
    id: 'PERSON',
    name: { zh: '人物', en: 'Person' },
    description: { zh: '个人或人物', en: 'An individual or person' },
    aliases: ['person', 'persons', 'people', 'human', 'individual', '人员', '人物', '个人']
  },
  {
    id: 'ORGANIZATION',
    name: { zh: '组织', en: 'Organization' },
    description: { zh: '公司、团队或机构', en: 'A company, team, or institution' },
    aliases: [
      'organization',
      'organisation',
      'org',
      'company',
      'business',
      'team',
      'institution',
      '组织',
      '公司',
      '企业',
      '机构',
      '团队'
    ]
  },
  {
    id: 'EVENT',
    name: { zh: '事件', en: 'Event' },
    description: { zh: '发生的活动或事件', en: 'An activity or occurrence' },
    aliases: ['event', 'occurrence', 'activity', '事件', '活动']
  },
  {
    id: 'LOCATION',
    name: { zh: '地点', en: 'Location' },
    description: { zh: '地理或虚拟位置', en: 'A geographic or virtual place' },
    aliases: ['location', 'place', 'site', 'address', '地点', '位置', '地址']
  },
  {
    id: 'DOCUMENT',
    name: { zh: '文档', en: 'Document' },
    description: { zh: '文档、文件或出版物', en: 'A document, file, or publication' },
    aliases: ['document', 'doc', 'file', 'publication', '文档', '文件', '资料']
  },
  {
    id: 'CONCEPT',
    name: { zh: '概念', en: 'Concept' },
    description: { zh: '其他概念或主题', en: 'Any other concept or topic' },
    aliases: ['concept', 'topic', 'subject', 'thing', '概念', '主题', '事物']
  }
]

const defaultRelationTypesInput = [
  {
    id: 'DEPENDS_ON',
    name: { zh: '依赖于', en: 'Depends on' },
    aliases: ['depends on', 'depends upon', 'requires', '依赖', '依赖于', '需要']
  },
  {
    id: 'USES',
    name: { zh: '使用', en: 'Uses' },
    aliases: ['uses', 'use', '使用']
  },
  {
    id: 'CALLS',
    name: { zh: '调用', en: 'Calls' },
    aliases: ['calls', 'call', '调用']
  },
  {
    id: 'IMPORTS',
    name: { zh: '导入', en: 'Imports' },
    aliases: ['imports', 'import', '导入']
  },
  {
    id: 'EXTENDS',
    name: { zh: '继承', en: 'Extends' },
    aliases: ['extends', 'inherits from', '继承', '继承自']
  },
  {
    id: 'IMPLEMENTS',
    name: { zh: '实现', en: 'Implements' },
    aliases: ['implements', 'implement', '实现']
  },
  {
    id: 'CONTAINS',
    name: { zh: '包含', en: 'Contains' },
    aliases: ['contains', 'includes', '包含', '包括']
  },
  {
    id: 'BELONGS_TO',
    name: { zh: '属于', en: 'Belongs to' },
    aliases: ['belongs to', 'is part of', '属于']
  },
  {
    id: 'CONNECTS_TO',
    name: { zh: '连接到', en: 'Connects to' },
    aliases: ['connects to', 'connects', '连接到', '连接']
  },
  {
    id: 'RELATED_TO',
    name: { zh: '相关', en: 'Related to' },
    aliases: ['related to', 'relates to', '相关', '相关于']
  }
]

export const knowledgeOntologySettingsSchema = z
  .object({
    version: z.literal(1).default(1),
    entityTypes: z
      .array(knowledgeOntologyEntityTypeSchema)
      .min(1)
      .max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumEntityTypes)
      .default(
        defaultEntityTypesInput.map((definition) => ({
          ...definition,
          name: { ...definition.name },
          description: { ...definition.description },
          aliases: [...definition.aliases]
        }))
      ),
    relationTypes: z
      .array(knowledgeOntologyRelationTypeSchema)
      .max(KNOWLEDGE_ONTOLOGY_LIMITS.maximumRelationTypes)
      .default(
        defaultRelationTypesInput.map((definition) => ({
          ...definition,
          name: { ...definition.name },
          aliases: [...definition.aliases]
        }))
      )
  })
  .strict()
  .superRefine((value, context) => {
    addUniquenessIssues(value.entityTypes, 'entityTypes', context)
    addUniquenessIssues(value.relationTypes, 'relationTypes', context)
    const entityIds = new Set(value.entityTypes.map((definition) => definition.id))
    if (!entityIds.has('CONCEPT')) {
      context.addIssue({
        code: 'custom',
        path: ['entityTypes'],
        message: 'CONCEPT is required as the fallback entity type'
      })
    }
    for (const [index, relation] of value.relationTypes.entries()) {
      for (const field of ['sourceTypes', 'targetTypes'] as const) {
        const seen = new Set<string>()
        for (const endpointType of relation[field] ?? []) {
          if (seen.has(endpointType)) {
            context.addIssue({
              code: 'custom',
              path: ['relationTypes', index, field],
              message: `duplicate endpoint type ${endpointType}`
            })
          }
          seen.add(endpointType)
          if (!entityIds.has(endpointType)) {
            context.addIssue({
              code: 'custom',
              path: ['relationTypes', index, field],
              message: `unknown endpoint type ${endpointType}`
            })
          }
        }
      }
    }
  })
export type KnowledgeOntologySettings = z.infer<
  typeof knowledgeOntologySettingsSchema
>

export const defaultKnowledgeOntologySettings =
  knowledgeOntologySettingsSchema.parse({})

export function resolveKnowledgeOntologySettings(
  settings?: KnowledgeOntologySettings
): KnowledgeOntologySettings {
  return settings
    ? knowledgeOntologySettingsSchema.parse(settings)
    : defaultKnowledgeOntologySettings
}

function aliasMap(
  definitions: readonly { id: string; aliases: readonly string[] }[]
): ReadonlyMap<string, string> {
  return new Map(
    definitions.flatMap((definition) =>
      [definition.id, ...definition.aliases].map(
        (alias) => [normalizeOntologyAlias(alias), definition.id] as const
      )
    )
  )
}

export function normalizeEntityTypeAlias(
  value: string | undefined,
  settings: KnowledgeOntologySettings = defaultKnowledgeOntologySettings
): string {
  if (!value) {
    return 'CONCEPT'
  }
  return (
    aliasMap(settings.entityTypes).get(normalizeOntologyAlias(value)) ??
    'CONCEPT'
  )
}

export function normalizeRelationTypeAlias(
  value: string | undefined,
  settings: KnowledgeOntologySettings = defaultKnowledgeOntologySettings
): string | undefined {
  if (!value) {
    return undefined
  }
  return aliasMap(settings.relationTypes).get(normalizeOntologyAlias(value))
}

export function isRelationEndpointAllowed(
  relationType: string,
  sourceType: string,
  targetType: string,
  settings: KnowledgeOntologySettings = defaultKnowledgeOntologySettings
): boolean {
  const canonicalRelation = normalizeRelationTypeAlias(relationType, settings)
  if (!canonicalRelation) {
    return false
  }
  const definition = settings.relationTypes.find(
    (candidate) => candidate.id === canonicalRelation
  )
  if (!definition) {
    return false
  }
  const canonicalSource = normalizeEntityTypeAlias(sourceType, settings)
  const canonicalTarget = normalizeEntityTypeAlias(targetType, settings)
  return (
    (!definition.sourceTypes ||
      definition.sourceTypes.includes(canonicalSource)) &&
    (!definition.targetTypes ||
      definition.targetTypes.includes(canonicalTarget))
  )
}

export type KnowledgeOntologyDisplayLocale = 'zh' | 'en'

export interface KnowledgeOntologyDisplayDefinition {
  id: string
  label: string
  description?: string
  aliases: string[]
}

export interface KnowledgeOntologyRelationDisplayDefinition
  extends KnowledgeOntologyDisplayDefinition {
  sourceTypes?: string[]
  targetTypes?: string[]
}

export interface KnowledgeOntologyDisplayDefinitions {
  version: 1
  fallbackEntityType: 'CONCEPT'
  entityTypes: KnowledgeOntologyDisplayDefinition[]
  relationTypes: KnowledgeOntologyRelationDisplayDefinition[]
}

export function getKnowledgeOntologyDisplayDefinitions(
  settings: KnowledgeOntologySettings = defaultKnowledgeOntologySettings,
  locale: KnowledgeOntologyDisplayLocale = 'zh'
): KnowledgeOntologyDisplayDefinitions {
  return {
    version: 1,
    fallbackEntityType: 'CONCEPT',
    entityTypes: settings.entityTypes.map((definition) => ({
      id: definition.id,
      label: definition.name[locale],
      ...(definition.description
        ? { description: definition.description[locale] }
        : {}),
      aliases: [...definition.aliases]
    })),
    relationTypes: settings.relationTypes.map((definition) => ({
      id: definition.id,
      label: definition.name[locale],
      ...(definition.description
        ? { description: definition.description[locale] }
        : {}),
      aliases: [...definition.aliases],
      ...(definition.sourceTypes
        ? { sourceTypes: [...definition.sourceTypes] }
        : {}),
      ...(definition.targetTypes
        ? { targetTypes: [...definition.targetTypes] }
        : {})
    }))
  }
}
