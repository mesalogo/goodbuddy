import { HeartPulse } from 'lucide-react'
import { useState } from 'react'
import type {
  AssistantHeartbeatConfig,
  HeartbeatCreateInput
} from '../../shared/assistant-contracts'

type HeartbeatSettingsProps = {
  heartbeats: AssistantHeartbeatConfig[]
  variant?: 'settings' | 'sidebar'
  onCreate: (input: HeartbeatCreateInput) => Promise<void>
  onSetPaused: (heartbeatId: string, paused: boolean) => Promise<void>
  onRemove: (heartbeatId: string) => Promise<void>
  onRunNow: (heartbeatId: string) => Promise<void>
}

const heartbeatStatusLabels: Record<
  NonNullable<AssistantHeartbeatConfig['lastStatus']>,
  string
> = {
  claimed: '运行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过'
}

export function HeartbeatSettings({
  heartbeats,
  variant = 'settings',
  onCreate,
  onSetPaused,
  onRemove,
  onRunNow
}: HeartbeatSettingsProps): React.JSX.Element {
  const [time, setTime] = useState('09:00')
  const [recurrence, setRecurrence] = useState<'daily' | 'weekly'>(
    'daily'
  )
  const [weekday, setWeekday] = useState(1)
  const [pendingAction, setPendingAction] = useState<string>()
  const [error, setError] = useState<string>()
  const [confirmingRemoveId, setConfirmingRemoveId] =
    useState<string>()

  const runAction = async (
    actionId: string,
    action: () => Promise<void>
  ): Promise<void> => {
    if (pendingAction) {
      return
    }
    setPendingAction(actionId)
    setError(undefined)
    try {
      await action()
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '智能心跳操作失败'
      )
    } finally {
      setPendingAction(undefined)
    }
  }

  return (
    <div className={`heartbeat-settings heartbeat-settings--${variant}`}>
      <div className="heartbeat-settings__intro">
        <h3>
          <HeartPulse size={15} />
          智能心跳
        </h3>
        <p>
          定期回顾经历、沉淀记忆、发现问题，并把变化转化为可处理的成长建议。智能心跳只读且不调用工具。
        </p>
      </div>
      <div
        className={`heartbeat-settings__form${
          recurrence === 'weekly'
            ? ' heartbeat-settings__form--weekly'
            : ''
        }`}
      >
        <select
          aria-label="心跳重复规则"
          onChange={(event) =>
            setRecurrence(event.target.value as 'daily' | 'weekly')
          }
          value={recurrence}
        >
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
        </select>
        {recurrence === 'weekly' && (
          <select
            aria-label="心跳星期"
            onChange={(event) => setWeekday(Number(event.target.value))}
            value={weekday}
          >
            <option value={1}>周一</option>
            <option value={2}>周二</option>
            <option value={3}>周三</option>
            <option value={4}>周四</option>
            <option value={5}>周五</option>
            <option value={6}>周六</option>
            <option value={0}>周日</option>
          </select>
        )}
        <input
          aria-label="心跳时间"
          onChange={(event) => setTime(event.target.value)}
          type="time"
          value={time}
        />
        <button
          aria-label="启用智能心跳"
          className="primary-button"
          disabled={!time || pendingAction !== undefined}
          onClick={() =>
            void runAction('create', () =>
              onCreate({
                name: '智能成长回顾',
                timezone:
                  Intl.DateTimeFormat().resolvedOptions().timeZone ||
                  'UTC',
                recurrence:
                  recurrence === 'daily'
                    ? {
                        type: 'daily',
                        localTime: time
                      }
                    : {
                        type: 'weekly',
                        localTime: time,
                        weekday
                      },
                enabled: true,
                lookbackHours:
                  recurrence === 'daily' ? 48 : 24 * 14,
                retentionDays: 90
              })
            )
          }
          type="button"
        >
          {pendingAction === 'create' ? '启用中…' : '启用智能心跳'}
        </button>
      </div>
      {error && (
        <p className="heartbeat-settings__error" role="alert">
          {error}
        </p>
      )}
      {heartbeats.length === 0 ? (
        <p className="heartbeat-settings__empty">
          当前范围尚未配置智能心跳。
        </p>
      ) : (
        <div className="heartbeat-settings__list">
          {heartbeats.map((heartbeat) => (
            <article
              className="heartbeat-settings__item"
              key={heartbeat.id}
            >
              <span>
                <strong>{heartbeat.name}</strong>
                <small>
                  {heartbeat.enabled ? '运行中' : '已暂停'} · 下次{' '}
                  {new Date(heartbeat.nextRunAt).toLocaleString('zh-CN')}
                  {heartbeat.lastStatus
                    ? ` · 上次 ${heartbeatStatusLabels[heartbeat.lastStatus]}`
                    : ''}
                </small>
              </span>
              <div className="heartbeat-settings__actions">
                <button
                  aria-label={`${
                    heartbeat.enabled ? '暂停' : '恢复'
                  } ${heartbeat.name}`}
                  disabled={pendingAction !== undefined}
                  onClick={() =>
                    void runAction(
                      `pause:${heartbeat.id}`,
                      () =>
                        onSetPaused(
                          heartbeat.id,
                          heartbeat.enabled
                        )
                    )
                  }
                  type="button"
                >
                  {heartbeat.enabled ? '暂停' : '恢复'}
                </button>
                <button
                  aria-label={`立即心跳 ${heartbeat.name}`}
                  disabled={pendingAction !== undefined}
                  onClick={() =>
                    void runAction(`run:${heartbeat.id}`, () =>
                      onRunNow(heartbeat.id)
                    )
                  }
                  type="button"
                >
                  立即心跳
                </button>
                {confirmingRemoveId === heartbeat.id ? (
                  <>
                    <button
                      aria-label={`确认删除 ${heartbeat.name}`}
                      disabled={pendingAction !== undefined}
                      onClick={() =>
                        void runAction(
                          `remove:${heartbeat.id}`,
                          async () => {
                            await onRemove(heartbeat.id)
                            setConfirmingRemoveId(undefined)
                          }
                        )
                      }
                      type="button"
                    >
                      确认删除历史
                    </button>
                    <button
                      aria-label={`取消删除 ${heartbeat.name}`}
                      disabled={pendingAction !== undefined}
                      onClick={() => setConfirmingRemoveId(undefined)}
                      type="button"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    aria-label={`删除 ${heartbeat.name}`}
                    disabled={pendingAction !== undefined}
                    onClick={() =>
                      setConfirmingRemoveId(heartbeat.id)
                    }
                    type="button"
                  >
                    删除
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
