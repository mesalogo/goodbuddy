import { z } from 'zod'

export const browserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hover'), ref: z.string().min(1).max(256) }),
  z.object({ kind: z.literal('press'), key: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('scroll'), deltaX: z.number().finite(), deltaY: z.number().finite() }),
  z.object({ kind: z.literal('drag'), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ kind: z.literal('check'), ref: z.string().min(1), checked: z.boolean() }),
  z.object({ kind: z.literal('wait'), ref: z.string().min(1), state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible') }),
  z.object({ kind: z.literal('upload'), ref: z.string().optional(), paths: z.array(z.string().min(1)).max(100) }),
  z.object({ kind: z.literal('dialog'), accept: z.boolean(), text: z.string().optional() }),
  z.object({ kind: z.literal('console') }),
  z.object({ kind: z.literal('requests') }),
  z.object({ kind: z.literal('downloads') }),
  z.object({ kind: z.literal('clickAt'), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.object({ kind: z.literal('fill'), ref: z.string().min(1), text: z.string().max(16_384) })
])
export type BrowserAction = z.infer<typeof browserActionSchema>
