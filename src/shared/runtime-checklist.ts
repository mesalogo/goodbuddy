import { z } from 'zod'

export const runtimeChecklistSchema = z.object({
  source: z.enum(['opencode', 'continue']),
  items: z.array(z.object({
    content: z.string().trim().min(1),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
    priority: z.enum(['low', 'medium', 'high']).optional()
  }).strict())
}).strict()

export type RuntimeChecklist = z.infer<typeof runtimeChecklistSchema>

// Only the native Checklist argument uses this syntax. Invalid input is not a clear.
export function parseContinueChecklist(name: string, input: unknown): RuntimeChecklist | undefined {
  if (name !== 'Checklist') return undefined
  try {
    const args = typeof input === 'string' ? JSON.parse(input) : input
    if (!args || typeof args.checklist !== 'string') return undefined
    const items: RuntimeChecklist['items'] = []
    for (const line of args.checklist.split(/\r?\n/u)) {
      if (!line.trim()) continue
      const match = /^\s*- \[([ xX])\]\s+(.+?)\s*$/u.exec(line)
      if (!match || !match[2]?.trim()) return undefined
      items.push({ content: match[2]!, status: match[1] === ' ' ? 'pending' : 'completed' })
    }
    return { source: 'continue', items }
  } catch {
    return undefined
  }
}
