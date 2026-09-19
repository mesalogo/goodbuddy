import type { ConversationMessageBlock } from './assistant-contracts'

export function appendConversationQuestionBlock(
  blocks: ConversationMessageBlock[] | undefined,
  questionId: string
): ConversationMessageBlock[] | undefined {
  if (!blocks || blocks.some(block => block.type === 'question' && block.questionId === questionId)) {
    return blocks
  }
  return [...blocks, { id: crypto.randomUUID(), type: 'question', questionId }]
}
