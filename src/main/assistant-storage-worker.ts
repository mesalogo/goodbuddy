import { parentPort, workerData } from 'node:worker_threads'
import { upgradeAssistantStorage } from './assistant/assistant-storage-upgrade'

const input = workerData as {
  databasePath: string
  cancellation: SharedArrayBuffer
}
const cancellation = new Int32Array(input.cancellation)
try {
  upgradeAssistantStorage(
    input.databasePath,
    (progress) => parentPort?.postMessage({ progress }),
    () => Atomics.load(cancellation, 0) !== 0
  )
  parentPort?.postMessage({ done: true })
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error && /full|space/iu.test(error.message)
      ? '磁盘空间不足，无法完成空间回收。请释放一些空间后重试。'
      : '历史执行记录优化未完成。请重试；若仍失败，请备份数据并联系支持。',
    cancelled: error instanceof Error && error.name === 'AbortError'
  })
}
