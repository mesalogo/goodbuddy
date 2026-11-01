import { z } from 'zod'

const jsonContentSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown())
])

const noulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: jsonContentSchema,
  criteria: z.object({
    true: z.string().optional(),
    false: z.string().optional()
  }).strict().optional()
}).strict()

const choiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: jsonContentSchema,
  criteria: z.record(z.string().min(1), z.union([z.string(), z.null()]))
    .refine((criteria) => Object.keys(criteria).length >= 2, 'choice 至少需要两个候选项')
}).strict()

const scoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: jsonContentSchema,
  criteria: z.array(z.string()).min(2).max(10)
}).strict()

export const systemOneQuestionSchema = z.discriminatedUnion('type', [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema
])

export const systemOneRequestSchema = z.object({
  model: z.string().trim().min(1).max(256),
  state: jsonContentSchema,
  questions: z.record(z.string().min(1), systemOneQuestionSchema).refine(
    (questions) => Object.keys(questions).length > 0,
    '至少需要一个问题'
  ),
  keep_alive: z.union([z.string(), z.number()]).optional()
}).strict()

const systemOneAnswerSchema = z.object({
  type: z.enum(['noul', 'choice', 'score']),
  noul: z.number().min(0).max(1).optional(),
  choice: z.string().optional(),
  score: z.number().optional(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  confidence: z.number().min(0).max(1).nullable().optional()
}).passthrough()

export const systemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), systemOneAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative()
  })
}).passthrough()

export type SystemOneQuestion = z.infer<typeof systemOneQuestionSchema>
export type SystemOneRequest = z.infer<typeof systemOneRequestSchema>
export type SystemOneResponse = z.infer<typeof systemOneResponseSchema>

export function systemOneEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/u, '')
  if (path.endsWith('/v1/systemone')) return url.toString()
  if (path.endsWith('/v1')) {
    url.pathname = `${path}/systemone`
  } else {
    url.pathname = `${path}/v1/systemone`
  }
  return url.toString()
}
