import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { ConversationMessageBlock } from '../../shared/assistant-contracts'
import type { AssistantStorageProgress } from '../../shared/assistant-storage-contracts'
import {
  compactSubagentPayload,
  restoreSubagentPayload
} from './subagent-progress-storage'

export function upgradeAssistantStorage(
  databasePath: string,
  onProgress: (progress: AssistantStorageProgress) => void,
  isCancelled: () => boolean = () => false
): void {
  const database = new DatabaseSync(databasePath, { timeout: 5_000 })
  const checkCancelled = (): void => {
    if (isCancelled()) throw new DOMException('Upgrade cancelled', 'AbortError')
  }
  const bytesBefore = statSync(databasePath).size
  try {
    const version = database.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (version.user_version < 1 || version.user_version >= 34) return
    checkCancelled()
    const progress: AssistantStorageProgress = {
      stage: 'scanning', processed: 0, total: 0, bytesBefore
    }
    onProgress({ ...progress })
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = OFF;
      PRAGMA cache_size = -65536;
      CREATE INDEX IF NOT EXISTS task_events_subagent_idx
        ON task_events(task_id, id) WHERE kind = 'subagent';
    `)
    const tasks = database.prepare(
      `SELECT task_id, COUNT(*) AS count FROM task_events
       WHERE kind = 'subagent' GROUP BY task_id`
    ).all() as Array<{ task_id: string; count: number }>
    progress.total = tasks.reduce((sum, task) => sum + task.count, 0)
    progress.stage = 'converting'
    const select = database.prepare(
      `SELECT id, payload_json FROM task_events
       WHERE task_id = ? AND kind = 'subagent' AND id > ?
       ORDER BY id LIMIT 32`
    )
    const update = database.prepare(
      'UPDATE task_events SET payload_json = ? WHERE id = ?'
    )
    for (const task of tasks) {
      const blocks = new Map<string, ConversationMessageBlock[]>()
      let afterId = 0
      for (;;) {
        checkCancelled()
        const rows = select.all(task.task_id, afterId) as Array<{
          id: number; payload_json: string
        }>
        if (!rows.length) break
        database.exec('BEGIN IMMEDIATE')
        try {
          for (const row of rows) {
            const payload: unknown = JSON.parse(row.payload_json)
            const compact = compactSubagentPayload(payload, blocks)
            // Replay mixed old/new rows on retry. Never delete events or provenance.
            restoreSubagentPayload(payload, blocks)
            if (compact !== payload) {
              update.run(JSON.stringify(compact), row.id)
            }
            afterId = row.id
          }
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
        progress.processed += rows.length
        onProgress({ ...progress })
      }
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    }
    checkCancelled()
    const free = database.prepare('PRAGMA freelist_count').get() as {
      freelist_count: number
    }
    if (free.freelist_count > 0) {
      progress.stage = 'compacting'
      onProgress({ ...progress })
      // Rebuild the now-small live database, not a second copy of the bloated input.
      database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;')
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    }
    checkCancelled()
    onProgress({
      ...progress, stage: 'complete',
      bytesAfter: statSync(databasePath).size
    })
  } finally {
    database.close()
  }
}
