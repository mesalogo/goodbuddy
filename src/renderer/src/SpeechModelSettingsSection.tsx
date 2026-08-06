import {
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

export function SpeechModelSettingsSection(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SpeechModelSnapshot>()
  const [busyModelId, setBusyModelId] = useState<string>()
  const [confirmingRemove, setConfirmingRemove] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
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
    setNotice(undefined)
    try {
      const next = await operation()
      if (next && mountedRef.current) {
        setSnapshot(next)
        setNotice(successMessage)
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
      {notice && <p className="settings-success" role="status">{notice}</p>}

      <div className="speech-model-settings__list">
        {snapshot.catalog.map((entry) => {
          const installed = installedById.get(entry.id)
          const operation = operationsById.get(entry.id)
          const percent = operation
            ? progressPercent(operation)
            : undefined
          const size = catalogSize(entry)
          const selected = snapshot.selectedModelId === entry.id
          return (
            <article className="capability-card" key={entry.id}>
              <div className="capability-card__header">
                <div>
                  <strong>{entry.displayName}</strong>
                  <small>
                    {entry.languages.join('、')} · {entry.quantization.toUpperCase()}
                    {size ? ` · ${formatBytes(size)}` : ''}
                  </small>
                </div>
                <span>
                  {selected
                    ? '正在使用'
                    : installed
                      ? '已安装'
                      : entry.manualOnly
                        ? '手动导入'
                        : '可下载'}
                </span>
              </div>
              <p>{entry.description}</p>
              <p>
                许可证：<strong>{entry.license.name}</strong>。
                {entry.license.notice}
              </p>

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
                      : operation.phase === 'installing'
                        ? '正在校验并安装…'
                        : '正在准备…'}
                    {percent === undefined
                      ? ''
                      : ` · ${percent.toFixed(0)}%`}
                  </small>
                </div>
              )}

              {entry.manualOnly && entry.manualReason && !installed && (
                <p className="settings-notice">{entry.manualReason}</p>
              )}

              <div className="speech-model-card__actions">
                {operation ? (
                  <button
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
                  <>
                    {!selected && (
                      <button
                        className="primary-button"
                        disabled={busyModelId === entry.id}
                        onClick={() =>
                          void run(
                            entry.id,
                            () =>
                              window.goodbuddy.speechModels!.select(
                                entry.id
                              ),
                            `已切换到 ${entry.displayName}`
                          )
                        }
                        type="button"
                      >
                        使用此模型
                      </button>
                    )}
                    <button
                      className={
                        confirmingRemove === entry.id
                          ? 'danger-button'
                          : 'secondary-button'
                      }
                      disabled={busyModelId === entry.id}
                      onClick={() => void remove(entry.id)}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={12} />
                      {confirmingRemove === entry.id
                        ? '确认删除模型'
                        : '删除模型'}
                    </button>
                  </>
                ) : (
                  <>
                    {!entry.manualOnly && (
                      <button
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
                        下载模型
                      </button>
                    )}
                    <button
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
                      从本地目录导入
                    </button>
                  </>
                )}
                <button
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
            </article>
          )
        })}
      </div>
    </section>
  )
}
