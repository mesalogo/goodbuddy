import { z } from 'zod'
import type { ImageOperation } from './image-generation-contracts'

export const imageOperationTargetSchema = z.object({
  conversationId: z.string().min(1).max(128),
  operationId: z.string().uuid()
}).strict()

export type ImageOperationTarget = z.infer<typeof imageOperationTargetSchema>
export type ImageOperationsApi = {
  cancel(input: ImageOperationTarget): Promise<ImageOperation>
  regenerate(input: ImageOperationTarget): Promise<ImageOperation>
  onChanged(listener: (operation: ImageOperation) => void): () => void
}
