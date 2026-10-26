import { parentPort, workerData } from 'node:worker_threads'
import { downloadDesktopUpdate } from './desktop-update-download'
import { cleanupDesktopUpdateCache, type DesktopUpdateWorkerJob } from './desktop-update-cache'

const job = workerData as DesktopUpdateWorkerJob
void ('kind' in job ? cleanupDesktopUpdateCache(job) : downloadDesktopUpdate(job,
  progress => parentPort!.postMessage({ progress })
)).then(
  () => parentPort!.postMessage({ done: true }),
  error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) })
)
