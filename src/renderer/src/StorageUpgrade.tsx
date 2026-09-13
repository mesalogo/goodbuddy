import { useEffect, useState } from 'react'
import type { AssistantStorageProgress } from '../../shared/assistant-storage-contracts'
import { PageHeader, PageShell } from './WorkspacePrimitives'
import { useUiLocale } from './i18n/UiLocaleProvider'
import './StorageUpgrade.css'

export function StorageUpgrade(): React.JSX.Element {
  const { resolvedLocale } = useUiLocale()
  const en = resolvedLocale === 'en-US'
  const [progress, setProgress] = useState<AssistantStorageProgress>()
  const [rate, setRate] = useState<number>()
  const [actionError, setActionError] = useState('')
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let sample: { count: number; time: number } | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await window.goodbuddy.storageUpgrade.getProgress()
        if (active) {
          setProgress(next)
          if (next.stage === 'converting') {
            const now = performance.now()
            if (sample && now - sample.time >= 2_000) {
              setRate(Math.max(0, (next.processed - sample.count) * 1_000 / (now - sample.time)))
              sample = { count: next.processed, time: now }
            } else if (!sample) {
              sample = { count: next.processed, time: now }
            }
          } else {
            sample = undefined
            setRate(undefined)
          }
        }
      } catch {
        // The normal application replaces this page when startup continues.
      }
      if (active) timer = setTimeout(() => void poll(), 500)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [])
  const title = en ? 'Optimizing saved execution history' : '正在优化历史执行记录'
  const stage = progress?.stage
  const status = stage === 'failed'
    ? progress?.error
    : stage === 'compacting'
      ? en ? 'Reclaiming disk space…' : '正在回收磁盘空间…'
      : stage === 'complete'
        ? en ? 'Optimization complete. Starting GoodBuddy…' : '优化完成，正在启动 GoodBuddy…'
        : progress?.stage === 'converting'
          ? `${en ? 'Processed' : '已处理'} ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}`
          : en ? 'Checking saved execution history…' : '正在检查历史执行记录…'
  const act = async (action: 'retry' | 'quit'): Promise<void> => {
    try {
      setActionError('')
      await window.goodbuddy.storageUpgrade.act(action)
    } catch {
      setActionError(en ? 'The action failed. Please try again.' : '操作未完成，请重试。')
    }
  }
  return (
    <main className="storage-upgrade" aria-labelledby="storage-upgrade-title">
      <PageShell variant="standard">
        <PageHeader
          headingId="storage-upgrade-title"
          title={title}
          description={en
            ? 'This update removes repeated copies of subagent progress. Your chats, execution details and results are preserved. Time depends on the history size and disk speed.'
            : '本次更新清理子任务进度的重复副本，保留聊天、执行详情和结果。处理时间取决于历史数据量和磁盘速度。'}
        />
        <p role={stage === 'failed' ? 'alert' : 'status'}>{status}</p>
        {progress?.stage === 'converting' && progress.total > 0 && (
          <progress aria-label={title} max={progress.total} value={progress.processed} />
        )}
        {stage === 'converting' && rate !== undefined && (
          <p>{en ? 'Processing speed' : '处理速度'}：{Math.round(rate).toLocaleString()} {en ? 'events/s' : '条/秒'}</p>
        )}
        <p>{en
          ? 'You can quit and retry on the next launch. Completed batches are preserved.'
          : '可以退出并在下次启动时继续处理，已完成的批次会保留。'}</p>
        {actionError && <p role="alert">{actionError}</p>}
        {stage === 'failed' && (
          <button className="primary-button" onClick={() => void act('retry')}>
            {en ? 'Retry' : '重试'}
          </button>
        )}
        <button className="secondary-button" onClick={() => void act('quit')}>
          {en ? 'Quit and continue later' : '退出，稍后继续'}
        </button>
      </PageShell>
    </main>
  )
}
