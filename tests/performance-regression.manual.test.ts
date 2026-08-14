import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  conversationSnapshotsSchema,
  localConversationSaveBatchSchema,
  type ConversationSnapshot,
  type LocalConversationHeader,
  type LocalConversationSaveBatch
} from '../src/shared/assistant-contracts'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'

const runPerformanceBenchmarks = process.env.GOODBUDDY_PERF === '1'
const conversationCount = 60
const messagesPerConversation = 200

let temporaryDirectory = ''

function benchmarkId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

function createConversations(
  projectId: string
): ConversationSnapshot[] {
  return Array.from({ length: conversationCount }, (_, conversationIndex) => ({
    id: benchmarkId(conversationIndex + 1),
    projectId,
    title: `Conversation ${conversationIndex}`,
    updatedAt: Date.UTC(2026, 7, 14, 12, conversationIndex),
    messages: Array.from(
      { length: messagesPerConversation },
      (_, messageIndex) => ({
        id: benchmarkId(
          1_000_000 +
            conversationIndex * messagesPerConversation +
            messageIndex
        ),
        role: messageIndex % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Message ${messageIndex} ${'x'.repeat(180)}`,
        createdAt: Date.UTC(
          2026,
          7,
          14,
          12,
          conversationIndex,
          messageIndex
        ),
        state: 'complete' as const
      })
    )
  }))
}

function measure(operation: () => void): number {
  const startedAt = performance.now()
  operation()
  return performance.now() - startedAt
}

function localHeader(
  conversation: ConversationSnapshot
): LocalConversationHeader {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    runtimeSelection: conversation.runtimeSelection,
    knowledgeRetrievalMode: conversation.knowledgeRetrievalMode,
    title: conversation.title,
    updatedAt: conversation.updatedAt
  }
}

describe.skipIf(!runPerformanceBenchmarks)(
  'manual performance regression benchmarks',
  () => {
    beforeAll(async () => {
      temporaryDirectory = await mkdtemp(
        join(tmpdir(), 'goodbuddy-performance-')
      )
    })

    afterAll(async () => {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true })
      }
    })

    it('measures conversation persistence and hydration at scale', async () => {
      const databasePath = join(temporaryDirectory, 'assistant.sqlite')
      const database = new AssistantDatabase(databasePath)
      database.initialize('C:\\Workspace')
      const project = database.listProjects()[0]!
      const conversations = conversationSnapshotsSchema.parse(
        createConversations(project.id)
      )

      const initialReplaceMs = measure(() => {
        database.replaceConversations(conversations)
      })
      const unchangedReplaceMs = measure(() => {
        database.replaceConversations(conversations)
      })
      const updated = conversations.map((conversation, index) =>
        index === 0
          ? {
              ...conversation,
              updatedAt: conversation.updatedAt + 1,
              messages: conversation.messages.map((message, messageIndex) =>
                messageIndex === conversation.messages.length - 1
                  ? { ...message, content: `${message.content} updated` }
                  : message
              )
            }
          : conversation
      )
      const legacySingleConversationUpdateMs = measure(() => {
        database.replaceConversations(updated)
      })
      const incrementallyUpdated = {
        ...updated[0]!,
        updatedAt: updated[0]!.updatedAt + 1,
        messages: updated[0]!.messages.map((message, messageIndex) =>
          messageIndex === updated[0]!.messages.length - 1
            ? { ...message, content: `${message.content} incremental` }
            : message
        )
      }
      const incrementalBatch: LocalConversationSaveBatch =
        localConversationSaveBatchSchema.parse([
          {
            header: localHeader(incrementallyUpdated),
            messages: [incrementallyUpdated.messages.at(-1)!]
          }
        ])
      const incrementalSingleMessageMs = measure(() => {
        database.saveLocalConversations(incrementalBatch)
      })
      const metadataOnlyBatch: LocalConversationSaveBatch = [
        {
          header: {
            ...localHeader(incrementallyUpdated),
            title: 'Incrementally renamed conversation',
            updatedAt: incrementallyUpdated.updatedAt + 1
          },
          messages: []
        }
      ]
      const incrementalMetadataOnlyMs = measure(() => {
        database.saveLocalConversations(metadataOnlyBatch)
      })
      let restored: ConversationSnapshot[] = []
      const listMs = measure(() => {
        restored = database.listConversations()
      })
      database.close()

      const databaseBytes = (await stat(databasePath)).size
      const metrics = {
        conversationCount,
        messagesPerConversation,
        totalMessages: conversationCount * messagesPerConversation,
        initialReplaceMs: Number(initialReplaceMs.toFixed(2)),
        unchangedReplaceMs: Number(unchangedReplaceMs.toFixed(2)),
        legacySingleConversationUpdateMs: Number(
          legacySingleConversationUpdateMs.toFixed(2)
        ),
        incrementalSingleMessageMs: Number(
          incrementalSingleMessageMs.toFixed(2)
        ),
        incrementalMetadataOnlyMs: Number(
          incrementalMetadataOnlyMs.toFixed(2)
        ),
        fullSnapshotPayloadBytes: Buffer.byteLength(
          JSON.stringify(conversations)
        ),
        incrementalPayloadBytes: Buffer.byteLength(
          JSON.stringify(incrementalBatch)
        ),
        listMs: Number(listMs.toFixed(2)),
        databaseBytes
      }
      console.log(`PERF_METRICS=${JSON.stringify(metrics)}`)

      expect(restored).toHaveLength(conversationCount)
      expect(restored[0]?.messages).toHaveLength(messagesPerConversation)
    }, 30_000)
  }
)
