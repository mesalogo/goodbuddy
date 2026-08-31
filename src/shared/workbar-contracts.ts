import { z } from 'zod'

export const WORKBAR_LIMITS = {
  maximumOpenInstances: 32,
  maximumTitleBytes: 256,
  maximumDescriptionBytes: 512,
  maximumUnavailableReasonBytes: 512
} as const

const boundedUtf8TextSchema = (
  maximumBytes: number,
  minimumBytes = 1
): z.ZodType<string> =>
  z.string().refine(
    (value) => {
      const size = new TextEncoder().encode(value).byteLength
      return size >= minimumBytes && size <= maximumBytes
    },
    `Text must contain ${minimumBytes}-${maximumBytes} UTF-8 bytes`
  )

export const workbarAppIdSchema = z.enum([
  'tasks',
  'workspace',
  'browser',
  'results',
  'terminal'
])
export type WorkbarAppId = z.infer<typeof workbarAppIdSchema>

export const workbarInstancePolicySchema = z.enum([
  'single',
  'multiple'
])
export type WorkbarInstancePolicy = z.infer<
  typeof workbarInstancePolicySchema
>

export const workbarDefaultContextSchema = z.enum([
  'application',
  'current-project'
])
export type WorkbarDefaultContext = z.infer<
  typeof workbarDefaultContextSchema
>

export const workbarAvailabilitySchema = z.discriminatedUnion(
  'state',
  [
    z.object({ state: z.literal('available') }).strict(),
    z
      .object({
        state: z.literal('unavailable'),
        reason: boundedUtf8TextSchema(
          WORKBAR_LIMITS.maximumUnavailableReasonBytes
        ),
        remedy: z.enum([
          'open-project-settings',
          'open-host-settings',
          'open-application-settings',
          'retry'
        ])
      })
      .strict()
  ]
)
export type WorkbarAvailability = z.infer<
  typeof workbarAvailabilitySchema
>

export const workbarAppDefinitionSchema = z
  .object({
    id: workbarAppIdSchema,
    label: boundedUtf8TextSchema(WORKBAR_LIMITS.maximumTitleBytes),
    icon: workbarAppIdSchema,
    description: boundedUtf8TextSchema(
      WORKBAR_LIMITS.maximumDescriptionBytes
    ),
    instancePolicy: workbarInstancePolicySchema,
    defaultContext: workbarDefaultContextSchema,
    defaultOpen: z.boolean(),
    availability: workbarAvailabilitySchema
  })
  .strict()
  .refine(
    (definition) => definition.icon === definition.id,
    'The stable icon identifier must match the application identifier'
  )
export type WorkbarAppDefinition = z.infer<
  typeof workbarAppDefinitionSchema
>

export const WORKBAR_APP_DEFINITIONS = [
  {
    id: 'tasks',
    label: '任务中心',
    icon: 'tasks',
    description: '查看和管理当前任务。',
    instancePolicy: 'single',
    defaultContext: 'current-project',
    defaultOpen: true,
    availability: { state: 'available' }
  },
  {
    id: 'workspace',
    label: '工作区',
    icon: 'workspace',
    description: '查看当前项目的工作区。',
    instancePolicy: 'single',
    defaultContext: 'current-project',
    defaultOpen: true,
    availability: { state: 'available' }
  },
  {
    id: 'browser',
    label: '浏览器',
    icon: 'browser',
    description: '浏览任务相关内容。',
    instancePolicy: 'single',
    defaultContext: 'application',
    defaultOpen: true,
    availability: { state: 'available' }
  },
  {
    id: 'results',
    label: '成果',
    icon: 'results',
    description: '查看任务生成的成果。',
    instancePolicy: 'single',
    defaultContext: 'current-project',
    defaultOpen: true,
    availability: { state: 'available' }
  },
  {
    id: 'terminal',
    label: '终端',
    icon: 'terminal',
    description: '打开当前项目的用户终端。',
    instancePolicy: 'multiple',
    defaultContext: 'current-project',
    defaultOpen: false,
    availability: { state: 'available' }
  }
] as const satisfies readonly WorkbarAppDefinition[]

export const workbarTargetRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local') }).strict(),
  z
    .object({
      type: z.literal('project'),
      projectId: z.string().uuid()
    })
    .strict()
])
export type WorkbarTargetRef = z.infer<
  typeof workbarTargetRefSchema
>

export const workbarTabInstanceSchema = z
  .object({
    id: z.string().uuid(),
    appId: workbarAppIdSchema,
    title: boundedUtf8TextSchema(WORKBAR_LIMITS.maximumTitleBytes),
    targetRef: workbarTargetRefSchema.optional()
  })
  .strict()
  .superRefine((instance, context) => {
    if (instance.appId === 'terminal' && !instance.targetRef) {
      context.addIssue({
        code: 'custom',
        path: ['targetRef'],
        message: 'Terminal instances require a public target reference'
      })
    }
  })
export type WorkbarTabInstance = z.infer<
  typeof workbarTabInstanceSchema
>

const singleInstanceAppIds = new Set<WorkbarAppId>(
  WORKBAR_APP_DEFINITIONS.filter(
    (definition) => definition.instancePolicy === 'single'
  ).map((definition) => definition.id)
)

export const workbarLayoutPreferencesSchema = z
  .object({
    instances: z
      .array(workbarTabInstanceSchema)
      .max(WORKBAR_LIMITS.maximumOpenInstances),
    activeInstanceId: z.string().uuid().nullable(),
    expanded: z.boolean(),
    dock: z.literal('right'),
    widthRatio: z.number().finite().gt(0).lt(1)
  })
  .strict()
  .superRefine((layout, context) => {
    const instanceIds = new Set<string>()
    const seenSingleApps = new Set<WorkbarAppId>()

    layout.instances.forEach((instance, index) => {
      if (instanceIds.has(instance.id)) {
        context.addIssue({
          code: 'custom',
          path: ['instances', index, 'id'],
          message: 'Workbar instance identifiers must be unique'
        })
      }
      instanceIds.add(instance.id)

      if (singleInstanceAppIds.has(instance.appId)) {
        if (seenSingleApps.has(instance.appId)) {
          context.addIssue({
            code: 'custom',
            path: ['instances', index, 'appId'],
            message: 'Single-instance applications cannot be duplicated'
          })
        }
        seenSingleApps.add(instance.appId)
      }
    })

    if (
      layout.activeInstanceId !== null &&
      !instanceIds.has(layout.activeInstanceId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activeInstanceId'],
        message: 'The active workbar instance must be open'
      })
    }
    if (
      layout.instances.length > 0 &&
      layout.activeInstanceId === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activeInstanceId'],
        message: 'An open workbar layout requires an active instance'
      })
    }
  })
export type WorkbarLayoutPreferences = z.infer<
  typeof workbarLayoutPreferencesSchema
>
