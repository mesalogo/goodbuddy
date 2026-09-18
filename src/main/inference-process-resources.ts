import type { ProcessMetric } from 'electron'
import type { InferenceResources } from '../shared/local-inference-contracts'

// One sampler per transport: a replacement process never inherits the old baseline.
export function createInferenceProcessSampler(
  getPid: () => number | undefined,
  getMetrics: () => ProcessMetric[],
  now: () => number = () => performance.now()
): () => InferenceResources {
  let previous: { pid: number; creationTime: number; time: number; cpu: number } | undefined
  return () => {
    const pid = getPid()
    let metric: ProcessMetric | undefined
    try {
      if (pid !== undefined) metric = getMetrics().find((entry) => entry.pid === pid && entry.type === 'Utility')
    } catch {
      previous = undefined
      return { scope: 'unavailable', reason: '进程资源采样失败' }
    }
    if (!metric) {
      previous = undefined
      return { scope: 'unavailable', reason: pid === undefined ? '服务进程未运行' : '等待进程资源数据' }
    }
    const time = now()
    const cpu = metric.cpu.cumulativeCPUUsage
    const resources: InferenceResources = {
      scope: 'service-process', pid: metric.pid, sampledAt: Date.now(),
      cpuUnavailableReason: '正在建立采样基线'
    }
    // Electron reports working set in KiB. Do not replace absent readings with zero.
    const memory = metric.memory?.workingSetSize
    if (Number.isFinite(memory) && memory >= 0) resources.workingSetBytes = memory * 1024
    else resources.memoryUnavailableReason = '系统未提供工作集内存'
    if (cpu !== undefined && Number.isFinite(cpu) && cpu >= 0) {
      if (previous && previous.pid === metric.pid && previous.creationTime === metric.creationTime &&
        time > previous.time && time - previous.time <= 15000 && cpu >= previous.cpu) {
        // Single-core capacity is 100%; multithreaded inference may exceed 100%.
        resources.cpuPercent = (cpu - previous.cpu) * 100_000 / (time - previous.time)
        resources.cpuUnavailableReason = undefined
      }
      previous = { pid: metric.pid, creationTime: metric.creationTime, time, cpu }
    } else {
      previous = undefined
      resources.cpuUnavailableReason = '系统未提供进程 CPU 时间'
    }
    return resources
  }
}
