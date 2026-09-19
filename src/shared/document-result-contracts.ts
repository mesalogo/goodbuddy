import { z } from 'zod'
import { documentParsingSettingsSchema } from './document-parsing-contracts'

export const documentResultSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string().min(1).max(500),
  sourceFormat: z.string(),
  content: z.string().max(5_000_000),
  sections: z.array(z.object({
    locator: z.string(), content: z.string(), pageNumber: z.number().int().optional(),
    sourcePages: z.array(z.number().int()).optional(), confidence: z.number().optional(),
    method: z.string().optional()
  })),
  images: z.array(z.object({
    id: z.string().uuid(), pageNumber: z.number().int(), key: z.string(),
    locator: z.string().optional(),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int(), height: z.number().int(), size: z.number().int()
  })),
  missingImages: z.array(z.object({ pageNumber: z.number().int(), key: z.string(), reason: z.string() })).default([]),
  pageCount: z.number().int().optional(),
  warnings: z.array(z.string()),
  completeness: z.enum(['complete', 'partial', 'images-only']),
  parsedAt: z.string(), durationMs: z.number().nonnegative(),
  settings: documentParsingSettingsSchema,
  restructure: z.object({ changed: z.boolean(), sourcePages: z.array(z.number()) }).optional()
}).strict()
export type DocumentResult = z.infer<typeof documentResultSchema>

export const documentResourceInputSchema = z.object({
  id: z.string().uuid(), imageId: z.string().uuid().optional(), thumbnail: z.boolean().optional()
}).strict()
