import { parentPort, workerData } from 'node:worker_threads'
import type { ExecutionStatsInput } from '../shared/assistant-contracts'
import { AssistantDatabase } from './assistant/assistant-database'

const database = new AssistantDatabase((workerData as { databasePath: string }).databasePath)
database.openReadOnly()
parentPort!.on('message', (message: {
  id: number; scope: ExecutionStatsInput; activeRequestIds: string[]
}) => {
  try {
    const result = database.getExecutionStats(message.scope, new Set(message.activeRequestIds))
    parentPort!.postMessage({ id: message.id, result })
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
})
parentPort!.on('close', () => database.close())
