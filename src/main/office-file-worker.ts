import { parentPort, workerData } from 'node:worker_threads'
import { runOfficeFileJob, type OfficeFileJob } from './office-file-operations'

void runOfficeFileJob(workerData as OfficeFileJob).then(
  result => parentPort!.postMessage({ result }),
  error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) })
)
