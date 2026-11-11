import { z } from 'zod'
import { sharingIdSchema } from './device-sharing-contracts'

export const personaDraftSchema = z.object({
  id: sharingIdSchema.optional(), revision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(120), description: z.string().max(2000),
  instructions: z.string().trim().min(1).max(8000), modelId: sharingIdSchema,
  sourceIds: z.array(sharingIdSchema).max(8), memberIds: z.array(sharingIdSchema).max(200), groupIds: z.array(sharingIdSchema).max(100),
  status: z.enum(['draft', 'published', 'paused'])
}).strict()
export const sharedPersonaSchema = personaDraftSchema.omit({ instructions: true, memberIds: true, groupIds: true, status: true }).extend({
  id: sharingIdSchema, revision: z.number().int(), ownerId: z.string(),
  origin: z.enum(['admin', 'device']), execution: z.literal('server'),
  sourceDeviceId: z.string().optional(), sourceDeviceName: z.string().optional(),
  status: z.enum(['draft', 'published', 'paused', 'revoked']),
  instructions: z.string().optional(), memberIds: z.array(z.string()).optional(), groupIds: z.array(z.string()).optional(),
  canManage: z.boolean().optional(), canEdit: z.boolean().optional(), createdAt: z.string(), updatedAt: z.string()
})
const subject = z.object({ id: z.string(), name: z.string() })
export const personaCatalogSchema = z.object({
  personas: z.array(sharedPersonaSchema), canCreate: z.boolean(),
  models: z.array(z.object({ id: z.string(), alias: z.string() })),
  sources: z.array(subject.extend({ kind: z.string() })),
  subjects: z.object({ members: z.array(subject), groups: z.array(subject) })
})
export const personaTransitionSchema = z.object({ id: sharingIdSchema, revision: z.number().int().positive(), action: z.enum(['pause', 'revoke']) }).strict()
export const personaChatSchema = z.object({ id: sharingIdSchema, requestId: z.uuid(), message: z.string().trim().min(1).max(8000) }).strict()
export const personaAnswerSchema = z.object({ answer: z.string(), model: z.string(), aiGenerated: z.literal(true), sources: z.array(z.object({ id: z.string(), name: z.string(), versionId: z.string(), filename: z.string() })) })
export type SharedPersona = z.infer<typeof sharedPersonaSchema>
export type PersonaDraft = z.infer<typeof personaDraftSchema>
export type PersonaCatalog = z.infer<typeof personaCatalogSchema>
export type PersonaAnswer = z.infer<typeof personaAnswerSchema>
export type SharingPersonasApi = {
  getPersonas: () => Promise<PersonaCatalog>
  savePersona: (input: PersonaDraft) => Promise<SharedPersona>
  transitionPersona: (input: z.infer<typeof personaTransitionSchema>) => Promise<SharedPersona>
  chatPersona: (input: z.infer<typeof personaChatSchema>) => Promise<PersonaAnswer>
  cancelPersonaChat: (requestId: string) => Promise<void>
}
