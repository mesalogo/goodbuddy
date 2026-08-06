import {
  Activity,
  Database,
  FlaskConical,
  RefreshCw,
  XCircle
} from 'lucide-react'
import type {
  EmbeddingConfigurationSummary,
  EmbeddingDiagnosticResult,
  EmbeddingIndexJob,
  EmbeddingIndexStatus
} from '../../shared/embedding-contracts'
import { isEmbeddingIndexJobActive } from '../../shared/embedding-contracts'

const jobStatusLabels: Record<EmbeddingIndexJob['status'], string> = {
  queued: '重建等待开始',
  running: '正在重建',
  completed: '最近一次重建成功',
  failed: '最近一次重建失败',
  cancelled: '最近一次重建已取消'
}

export interface EmbeddingSettingsSectionProps {
  configuration: EmbeddingConfigurationSummary
  diagnostic?: EmbeddingDiagnosticResult | null
  diagnosticRunning?: boolean
  indexStatus: EmbeddingIndexStatus
  disabled?: boolean
  onTest: () => void
  onRebuild: () => void
  onCancel?: (jobId: string) => void
}

function formatCheckedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(timestamp)
}

function DiagnosticResult({
  result
}: {
  result: EmbeddingDiagnosticResult
}): React.JSX.Element {
  if (result.status === 'available') {
    return (
      <div aria-live="polite" className="capability-diagnostic__result">
        <strong>测试成功</strong>
        <p>
          服务返回 {result.dimensions} 维向量，耗时 {result.latencyMs} 毫秒。
        </p>
        <small>测试时间：{formatCheckedAt(result.checkedAt)}</small>
      </div>
    )
  }
  return (
    <div
      aria-live="assertive"
      className="capability-diagnostic__result"
      role="alert"
    >
      <strong>测试失败</strong>
      <p>{result.error.message}</p>
      {result.error.remedy && <p>处理建议：{result.error.remedy}</p>}
    </div>
  )
}

function IndexJobStatus({
  job,
  disabled,
  onCancel
}: {
  job: EmbeddingIndexJob
  disabled: boolean
  onCancel?: (jobId: string) => void
}): React.JSX.Element {
  const active = isEmbeddingIndexJobActive(job)
  return (
    <div
      aria-live="polite"
      className="embedding-settings__job"
      data-status={job.status}
    >
      <div className="embedding-settings__job-header">
        <div>
          <strong>{jobStatusLabels[job.status]}</strong>
          <small>
            {job.provider} · {job.model}
          </small>
        </div>
        {active && onCancel && (
          <button
            aria-label="取消向量索引重建"
            className="secondary-button"
            disabled={disabled}
            onClick={() => onCancel(job.id)}
            type="button"
          >
            <XCircle aria-hidden="true" size={13} />
            取消重建
          </button>
        )}
      </div>
      {active && (
        <>
          <progress
            aria-label="向量索引重建进度"
            max={100}
            {...(job.progress.total > 0
              ? { value: job.progress.percent }
              : {})}
          />
          <p>
            {job.progress.total > 0
              ? `已完成 ${job.progress.completed} / ${job.progress.total} 篇文档`
              : '正在准备待处理文档…'}
          </p>
          <p className="settings-notice">
            每篇文档会一次性更新，处理完成后立即可用于检索。取消后，已完成文档会保留，其余文档的原有或缺失状态不变。
          </p>
        </>
      )}
      {job.status === 'completed' && (
        <p>
          已完成 {job.progress.completed} / {job.progress.total} 篇文档
          {job.completedAt
            ? `，完成于 ${formatCheckedAt(job.completedAt)}。`
            : '。'}
        </p>
      )}
      {job.status === 'cancelled' && (
        <>
          <p>
            已完成 {job.progress.completed} / {job.progress.total} 篇文档。
          </p>
          <p>
            已完成文档保留新向量；其余文档保留原有向量，原本没有向量的仍保持缺失。
          </p>
        </>
      )}
      {job.status === 'failed' && job.error && (
        <div role="alert">
          <p>{job.error.message}</p>
          <p>{`已完成 ${job.progress.completed} / ${job.progress.total} 篇文档。发生错误的文档已标记为错误，已完成文档仍可用于检索。`}</p>
          <p>
            处理建议：
            {job.error.remedy ?? '请检查向量模型配置和网络连接。'}
            修复后点击“重建向量索引”重试。
          </p>
        </div>
      )}
    </div>
  )
}

export function EmbeddingSettingsSection({
  configuration,
  diagnostic,
  diagnosticRunning = false,
  indexStatus,
  disabled = false,
  onTest,
  onRebuild,
  onCancel
}: EmbeddingSettingsSectionProps): React.JSX.Element {
  const active = isEmbeddingIndexJobActive(indexStatus.job)

  return (
    <section
      aria-label="向量模型"
      className="embedding-settings settings-section"
    >
      <div className="settings-section__title">
        <Activity aria-hidden="true" size={17} />
        <div>
          <h2 id="embedding-settings-heading">向量与知识检索</h2>
          <small>确认模型可用，并管理知识检索使用的向量索引</small>
        </div>
      </div>

      <div
        aria-labelledby="embedding-model-heading"
        className="embedding-settings__group"
      >
        <div className="embedding-settings__subheading">
          <div>
            <FlaskConical aria-hidden="true" size={15} />
            <h3 id="embedding-model-heading">当前向量模型</h3>
          </div>
        </div>
        <div className="embedding-settings__model">
          <div className="embedding-settings__model-name">
            <span>已配置模型</span>
            <strong>{configuration.model}</strong>
            <small>服务提供方：{configuration.provider}</small>
          </div>
          <span className="embedding-settings__credential">
            {configuration.credentialConfigured ? '已配置凭据' : '未配置凭据'}
          </span>
        </div>
        {configuration.endpoint && (
          <p className="embedding-settings__endpoint">
            服务地址：<code>{configuration.endpoint}</code>
          </p>
        )}
        <div className="capability-diagnostic">
          <button
            className="secondary-button"
            disabled={disabled || diagnosticRunning}
            onClick={onTest}
            type="button"
          >
            <FlaskConical aria-hidden="true" size={13} />
            {diagnosticRunning ? '正在测试…' : '测试向量模型'}
          </button>
          {diagnostic && <DiagnosticResult result={diagnostic} />}
          {!diagnostic && !diagnosticRunning && (
            <p className="settings-notice">
              测试会向当前服务发送一次实际请求，不会更改知识索引。
            </p>
          )}
        </div>
      </div>

      <div
        aria-labelledby="embedding-index-heading"
        className="embedding-settings__group"
      >
        <div className="embedding-settings__subheading">
          <div>
            <Database aria-hidden="true" size={15} />
            <h3 id="embedding-index-heading">知识向量索引</h3>
          </div>
          <button
            className="secondary-button"
            disabled={disabled || active}
            onClick={onRebuild}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={13} />
            {active ? '重建进行中…' : '重建向量索引'}
          </button>
        </div>

        {indexStatus.job ? (
          <IndexJobStatus
            disabled={disabled}
            job={indexStatus.job}
            onCancel={onCancel}
          />
        ) : (
          <div className="embedding-settings__empty">
            <strong>还没有重建记录</strong>
            <p>点击“重建向量索引”，为知识文档生成可用于检索的向量。</p>
          </div>
        )}
      </div>
    </section>
  )
}
