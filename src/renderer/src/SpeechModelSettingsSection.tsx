import {
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  Mic,
  Square,
  Trash2
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SpeechModelCatalogEntry,
  SpeechModelOperation,
  SpeechModelSnapshot
} from '../../shared/speech-model-contracts'
import type { AppNotificationInput } from './notifications'

type SpeechModelSettingsSectionProps = {
  onNotify?: (notification: AppNotificationInput) => void
}

const qualityLabels: Record<SpeechModelCatalogEntry['quality'], string> = {
  basic: '基础质量',
  balanced: '均衡质量',
  high: '高质量'
}

const speedLabels: Record<SpeechModelCatalogEntry['speed'], string> = {
  fast: '快速',
  balanced: '均衡速度',
  slow: '较慢'
}

const familyLabels: Record<SpeechModelCatalogEntry['family'], string> = {
  sensevoice: 'SenseVoice',
  paraformer: 'Paraformer',
  whisper: 'Whisper'
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function catalogSize(entry: SpeechModelCatalogEntry): number | undefined {
  const downloads = entry.files.map((file) => file.download)
  return downloads.every(Boolean)
    ? downloads.reduce(
        (total, download) => total + (download?.size ?? 0),
        0
      )
    : undefined
}

function progressPercent(operation: SpeechModelOperation): number | undefined {
  return operation.totalBytes && operation.totalBytes > 0
    ? Math.min(
        100,
        (operation.completedBytes / operation.totalBytes) * 100
      )
    : undefined
}

function operationLabel(operation: SpeechModelOperation): string {
  if (operation.phase === 'installing') {
    return '正在校验并安装'
  }
  if (operation.phase === 'preparing') {
    return operation.kind === 'import' ? '正在准备导入' : '正在准备下载'
  }
  return operation.kind === 'import' ? '正在导入' : '正在下载'
}

export function SpeechModelSettingsSection({
  onNotify
}: SpeechModelSettingsSectionProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SpeechModelSnapshot>()
  const [busyModelId, setBusyModelId] = useState<string>()
  const [confirmingRemove, setConfirmingRemove] = useState<string>()
  const [error, setError] = useState<string>()
  const mountedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.goodbuddy.speechModels
    if (!api) {
      throw new Error('当前版本未提供语音模型服务')
    }
    const next = await api.getSnapshot()
    if (mountedRef.current) {
      setSnapshot(next)
    }
  }, [])

  useEffect(() => {
    const api = window.goodbuddy.speechModels
    let active = true
    mountedRef.current = true
    void (async () => {
      if (!api) {
        throw new Error('当前版本未提供语音模型服务')
      }
      return api.getSnapshot()
    })()
      .then((next) => {
        if (active) {
          setSnapshot(next)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : '读取语音模型失败'
          )
        }
      })
    return () => {
      active = false
      mountedRef.current = false
    }
  }, [])

  const shouldPoll =
    busyModelId !== undefined || Boolean(snapshot?.operations.length)

  useEffect(() => {
    if (!shouldPoll) {
      return
    }
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 300)
    return () => window.clearInterval(timer)
  }, [refresh, shouldPoll])

  const run = async (
    modelId: string,
    operation: () => Promise<SpeechModelSnapshot | undefined>,
    successMessage: string
  ): Promise<void> => {
    setBusyModelId(modelId)
    setError(undefined)
    try {
      const next = await operation()
      if (next && mountedRef.current) {
        setSnapshot(next)
        onNotify?.({
          tone: 'success',
          message: successMessage,
          dedupeKey: `speech-model-${modelId}`
        })
      }
    } catch (reason) {
      if (mountedRef.current) {
        setError(
          reason instanceof Error ? reason.message : '语音模型操作失败'
        )
      }
    } finally {
      if (mountedRef.current) {
        setBusyModelId(undefined)
        void refresh().catch(() => undefined)
      }
    }
  }

  const remove = async (modelId: string): Promise<void> => {
    const api = window.goodbuddy.speechModels
    if (!api) {
      return
    }
    if (confirmingRemove !== modelId) {
      setConfirmingRemove(modelId)
      return
    }
    setConfirmingRemove(undefined)
    await run(
      modelId,
      () => api.remove(modelId),
      '语音模型已删除'
    )
  }

  if (!snapshot) {
    return (
      <div className="settings-section">
        <p className={error ? 'settings-warning' : 'settings-empty'}>
          {error ?? '正在读取语音模型…'}
        </p>
      </div>
    )
  }

  const installedById = new Map(
    snapshot.installed.map((model) => [model.id, model])
  )
  const operationsById = new Map(
    snapshot.operations.map((operation) => [
      operation.modelId,
      operation
    ])
  )

  return (
    <section
      aria-labelledby="speech-model-settings-heading"
      className="settings-section speech-model-settings"
    >
      <div className="settings-section__title settings-section__title--actions">
        <Mic aria-hidden="true" size={17} />
        <div>
          <strong id="speech-model-settings-heading">语音模型</strong>
          <small>应用不内置模型权重，按需下载或从本地目录导入</small>
        </div>
        <button
          className="secondary-button"
          onClick={() =>
            void window.goodbuddy.speechModels?.openModelsDirectory()
          }
          type="button"
        >
          <FolderOpen aria-hidden="true" size={13} />
          打开模型目录
        </button>
      </div>

      <p className="settings-notice">
        模型保存在 <code>{snapshot.rootDirectory}</code>。自动下载会固定来源版本，
        并校验文件大小和 SHA-256；也可以从模型仓库手动下载后导入。
      </p>
      {error && <p className="settings-warning" role="alert">{error}</p>}

      <div
        aria-label="可用语音模型"
        className="speech-model-settings__list"
        role="list"
      >
        {snapshot.catalog.map((entry) => {
          const installed = installedById.get(entry.id)
          const operation = operationsById.get(entry.id)
          const percent = operation
            ? progressPercent(operation)
            : undefined
          const size = catalogSize(entry)
          const selected = snapshot.selectedModelId === entry.id
          const status = operation
            ? operationLabel(operation)
            : selected
              ? '正在使用'
              : installed
                ? '已安装'
                : entry.manualOnly
                  ? '手动导入'
                  : '可下载'
          return (
            <article
              className={`speech-model-row${selected ? ' speech-model-row--selected' : ''}`}
              key={entry.id}
              role="listitem"
            >
              <div className="speech-model-row__selection">
                <input
                  aria-label={
                    installed
                      ? `使用 ${entry.displayName}`
                      : `${entry.displayName} 尚未安装`
                  }
                  checked={selected}
                  disabled={!installed || operation !== undefined}
                  name="selected-speech-model"
                  onChange={() =>
                    void run(
                      entry.id,
                      () =>
                        window.goodbuddy.speechModels!.select(entry.id),
                      `已切换到 ${entry.displayName}`
                    )
                  }
                  type="radio"
                />
              </div>

              <div className="speech-model-row__summary">
                <div className="speech-model-row__name">
                  <strong>{entry.displayName}</strong>
                  {entry.recommended && (
                    <span className="speech-model-tag speech-model-tag--recommended">
                      推荐
                    </span>
                  )}
                </div>
                <p>{entry.description}</p>
                <div className="speech-model-row__tags">
                  <span className="speech-model-tag">
                    {familyLabels[entry.family]}
                  </span>
                  <span className="speech-model-tag">
                    {entry.languages.join(' / ')}
                  </span>
                  <span className="speech-model-tag">
                    {entry.quantization.toUpperCase()}
                  </span>
                </div>
              </div>

              <div className="speech-model-row__profile">
                <span>{qualityLabels[entry.quality]}</span>
                <span>{speedLabels[entry.speed]}</span>
                <span>{size ? formatBytes(size) : '大小未知'}</span>
              </div>

              <div className="speech-model-row__state">
                <span
                  className={`speech-model-status${
                    selected
                      ? ' speech-model-status--selected'
                      : installed
                        ? ' speech-model-status--installed'
                        : ''
                  }`}
                >
                  {selected && <CheckCircle2 aria-hidden="true" size={13} />}
                  {status}
                </span>
              </div>

              <div className="speech-model-row__actions">
                {operation ? (
                  <button
                    aria-label={`取消 ${entry.displayName} 操作`}
                    className="secondary-button"
                    onClick={() =>
                      void window.goodbuddy.speechModels
                        ?.cancel(entry.id)
                        .then(() => refresh())
                    }
                    type="button"
                  >
                    <Square aria-hidden="true" size={12} />
                    取消
                  </button>
                ) : installed ? (
                  <button
                    aria-label={`删除 ${entry.displayName}`}
                    className={
                      confirmingRemove === entry.id
                        ? 'danger-button'
                        : 'danger-ghost'
                    }
                    disabled={busyModelId === entry.id}
                    onClick={() => void remove(entry.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={12} />
                    {confirmingRemove === entry.id
                      ? '确认删除'
                      : '删除'}
                  </button>
                ) : (
                  <>
                    {!entry.manualOnly && (
                      <button
                        aria-label={`下载 ${entry.displayName}`}
                        className="primary-button"
                        disabled={busyModelId === entry.id}
                        onClick={() =>
                          void run(
                            entry.id,
                            () =>
                              window.goodbuddy.speechModels!.install(
                                entry.id
                              ),
                            `${entry.displayName} 已安装`
                          )
                        }
                        type="button"
                      >
                        <Download aria-hidden="true" size={13} />
                        下载
                      </button>
                    )}
                    <button
                      aria-label={`从本地目录导入 ${entry.displayName}`}
                      className="secondary-button"
                      disabled={busyModelId === entry.id}
                      onClick={() =>
                        void run(
                          entry.id,
                          () =>
                            window.goodbuddy.speechModels!
                              .importLocalDirectory(entry.id),
                          `${entry.displayName} 已从本地目录导入`
                        )
                      }
                      type="button"
                    >
                      <FolderOpen aria-hidden="true" size={13} />
                      导入
                    </button>
                  </>
                )}
              </div>

              {operation && (
                <div aria-live="polite" className="speech-model-operation">
                  <progress
                    aria-label={`${entry.displayName}下载进度`}
                    max={100}
                    {...(percent === undefined ? {} : { value: percent })}
                  />
                  <small>
                    {operation.currentFile
                      ? `正在处理 ${operation.currentFile}`
                      : `${operationLabel(operation)}…`}
                    {percent === undefined
                      ? ''
                      : ` · ${percent.toFixed(0)}%`}
                  </small>
                </div>
              )}

              <details className="speech-model-row__details">
                <summary>
                  <ChevronDown aria-hidden="true" size={13} />
                  模型详情
                </summary>
                <div>
                  {entry.manualOnly &&
                    entry.manualReason &&
                    !installed && (
                      <p>{entry.manualReason}</p>
                    )}
                  <p>
                    许可证：<strong>{entry.license.name}</strong>。
                    {entry.license.notice}
                  </p>
                  <button
                    aria-label={`打开 ${entry.displayName} 模型仓库`}
                    className="secondary-button"
                    onClick={() =>
                      void window.goodbuddy.speechModels?.openRepository(
                        entry.id
                      )
                    }
                    type="button"
                  >
                    <ExternalLink aria-hidden="true" size={13} />
                    打开模型仓库
                  </button>
                </div>
              </details>
            </article>
          )
        })}
      </div>
    </section>
  )
}
