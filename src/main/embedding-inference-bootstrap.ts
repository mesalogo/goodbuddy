import path from 'node:path'
import { GraniteEmbeddingEngine } from './knowledge/granite-embedding-engine'
import {
  createEmbeddingInferenceWorkerPort,
  EmbeddingInferenceWorker
} from './knowledge/embedding-inference-worker'

const modelDirectory = process.argv[2]
if (
  typeof modelDirectory !== 'string' ||
  modelDirectory.length < 1 ||
  modelDirectory.length > 4_096 ||
  !path.isAbsolute(modelDirectory)
) {
  throw new TypeError('Expected a bounded absolute model directory in argv')
}

const worker = new EmbeddingInferenceWorker({
  modelDirectory,
  engine: new GraniteEmbeddingEngine(),
  port: createEmbeddingInferenceWorkerPort(process.parentPort)
})

async function shutdown(): Promise<void> {
  await worker.shutdown()
}

process.once('disconnect', () => {
  void shutdown()
})
process.once('SIGTERM', () => {
  void shutdown()
})
