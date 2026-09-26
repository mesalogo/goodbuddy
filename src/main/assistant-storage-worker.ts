import { parentPort, workerData } from 'node:worker_threads'
import { upgradeAssistantStorage, type AssistantStorageUpgrade } from './assistant/assistant-storage-upgrade'

const input = workerData as {
  databasePath: string
  cancellation: SharedArrayBuffer
  upgrade: AssistantStorageUpgrade
}
const cancellation = new Int32Array(input.cancellation)
try {
  // Preserve this startup's actual conversion/reclamation decision across retries.
  upgradeAssistantStorage(
    input.databasePath,
    (progress) => parentPort?.postMessage({ progress }),
    () => Atomics.load(cancellation, 0) !== 0,
    { confirmedUpgrade: input.upgrade }
  )
  parentPort?.postMessage({ done: true })
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error && /full|space/iu.test(error.message)
      ? '磁盘空间不足，无法完成空间回收。请释放一些空间后重试。'
      : '本地数据升级未完成。请重试；若仍失败，请备份数据并联系支持。',
    cancelled: error instanceof Error && error.name === 'AbortError'
  })
}
