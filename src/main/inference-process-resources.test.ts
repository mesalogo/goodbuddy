import { describe, expect, it } from 'vitest'
import type { ProcessMetric } from 'electron'
import { createInferenceProcessSampler } from './inference-process-resources'

describe('inference process resources', () => {
  it('measures only the utility PID, warms CPU and converts KiB to bytes', () => {
    let time = 0
    const metric: ProcessMetric = { pid: 42, type: 'Utility', creationTime: 1, cpu: { cumulativeCPUUsage: 2, percentCPUUsage: 0, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 2048, peakWorkingSetSize: 2048 } }
    const sample = createInferenceProcessSampler(() => 42, () => [{ ...metric, pid: 99 }, metric], () => time)
    expect(sample()).toMatchObject({ scope: 'service-process', pid: 42, workingSetBytes: 2097152, cpuUnavailableReason: '正在建立采样基线' })
    time = 5100
    metric.cpu.cumulativeCPUUsage = 9.65
    expect(sample()).toMatchObject({ cpuPercent: 150 })
    time = 21000
    expect(sample()).toMatchObject({ cpuUnavailableReason: '正在建立采样基线' })
    time = 26000
    metric.creationTime = 2
    expect(sample()).not.toHaveProperty('cpuPercent')
    time = 31000
    metric.cpu.cumulativeCPUUsage = 0
    expect(sample()).not.toHaveProperty('cpuPercent')
  })

  it('clears baselines on exit, missing metrics and failure; preserves partial readings', () => {
    let pid: number | undefined = 42
    let time = 0
    let fail = false
    const metric: ProcessMetric = { pid: 42, type: 'Utility', creationTime: 1, cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 1024, peakWorkingSetSize: 1024 } }
    const sample = createInferenceProcessSampler(() => pid, () => { if (fail) throw new Error('sampling'); return [metric] }, () => time += 2000)
    expect(sample()).toMatchObject({ workingSetBytes: 1048576, cpuUnavailableReason: '系统未提供进程 CPU 时间' })
    metric.cpu.cumulativeCPUUsage = 1
    metric.memory.workingSetSize = NaN
    expect(sample()).toMatchObject({ memoryUnavailableReason: '系统未提供工作集内存' })
    fail = true
    expect(sample()).toEqual({ scope: 'unavailable', reason: '进程资源采样失败' })
    fail = false
    expect(sample()).not.toHaveProperty('cpuPercent')
    pid = undefined
    expect(sample()).toEqual({ scope: 'unavailable', reason: '服务进程未运行' })
    pid = 43
    expect(sample()).toEqual({ scope: 'unavailable', reason: '等待进程资源数据' })
    metric.pid = 43
    expect(sample()).not.toHaveProperty('cpuPercent')
    metric.type = 'Tab'
    expect(sample()).toMatchObject({ scope: 'unavailable' })
  })
})
