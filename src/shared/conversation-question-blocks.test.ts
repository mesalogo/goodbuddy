import { expect, it } from 'vitest'
import { conversationMessageBlocksSchema } from './assistant-contracts'
import { appendConversationQuestionBlock } from './conversation-question-blocks'

it('appends one stable question marker without moving earlier content or duplicate questions', () => {
  const text = { id: crypto.randomUUID(), type: 'text' as const, content: 'Before' }
  const blocks = appendConversationQuestionBlock([text], 'question-1')!
  expect(blocks[0]).toBe(text)
  expect(blocks[1]).toMatchObject({ type: 'question', questionId: 'question-1' })
  expect(appendConversationQuestionBlock(blocks, 'question-1')).toBe(blocks)
  expect(conversationMessageBlocksSchema.parse(blocks)).toEqual(blocks)
  expect(appendConversationQuestionBlock(blocks, 'question-2')?.map(block => block.type)).toEqual([
    'text', 'question', 'question'
  ])
})

it('does not fabricate positions for legacy messages without blocks', () => {
  expect(appendConversationQuestionBlock(undefined, 'question-1')).toBeUndefined()
})
