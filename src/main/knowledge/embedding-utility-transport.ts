import { app, utilityProcess } from 'electron'
import { createInferenceProcessSampler } from '../inference-process-resources'
import type { EmbeddingInferenceTransport } from './embedding-inference-broker'

export function createEmbeddingUtilityTransport(
  modulePath: string,
  modelDirectory: string
): Promise<EmbeddingInferenceTransport> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(modulePath, [modelDirectory], {
      serviceName: 'GoodBuddy Embedding Inference',
      stdio: 'pipe',
      allowLoadingUnsignedLibraries: false
    })
    const startupError = (): void => { reject(new Error('向量进程启动失败')) }
    child.once('error', startupError)
    child.once('exit', startupError)
    child.once('spawn', () => {
      child.removeListener('error', startupError)
      child.removeListener('exit', startupError)
      resolve({
        getResources: createInferenceProcessSampler(() => child.pid, () => app.getAppMetrics()),
        postMessage: (message) => child.postMessage(message),
        onMessage: (listener) => {
          child.on('message', listener)
          return () => { child.removeListener('message', listener) }
        },
        onClose: (listener) => {
          let closed = false
          const notify = (): void => {
            if (closed) return
            closed = true
            listener()
          }
          child.on('exit', notify)
          child.on('error', notify)
          return () => {
            child.removeListener('exit', notify)
            child.removeListener('error', notify)
          }
        },
        close: () => new Promise<void>((resolveClose, rejectClose) => {
          const finish = (): void => {
            clearTimeout(timeout)
            resolveClose()
          }
          const timeout = setTimeout(() => {
            child.removeListener('exit', finish)
            rejectClose(new Error('向量进程尚未确认退出，请刷新状态后重试'))
          }, 5000)
          child.once('exit', finish)
          if (!child.kill()) {
            clearTimeout(timeout)
            child.removeListener('exit', finish)
            rejectClose(new Error('无法停止向量进程，请刷新状态后重试'))
          }
        })
      })
    })
  })
}
