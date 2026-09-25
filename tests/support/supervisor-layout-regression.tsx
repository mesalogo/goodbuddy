// Simulated visual fixture only. No preload, user database, or model is used.
import { createRoot } from 'react-dom/client'
import { HeartbeatCenter } from '../../src/renderer/src/HeartbeatCenter'
import { SupervisionCard } from '../../src/renderer/src/RightAssistantSidebar'
import { PageShell } from '../../src/renderer/src/WorkspacePrimitives'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import type { SupervisionGraphView } from '../../src/shared/supervision-contracts'
import { applicationSettingsSchema, defaultLocalToolEnvironmentSettings } from '../../src/shared/application-settings-contracts'
import '../../src/renderer/src/styles.css'
import '@fontsource-variable/noto-sans-sc/wght.css'
import { installBundledUiFonts } from '../../src/renderer/src/fonts'

installBundledUiFonts()

const params = new URLSearchParams(location.search)
const stories = [
  {
    title: '监督者 · 故事图谱',
    events: [
      '观察工作过程',
      '记录关键决定',
      '整理阶段总结',
      '连接原始记录',
      '核对归纳依据',
      '保留知识来路',
      '确认来源追溯',
      '继续未完成工作'
    ],
    entities: [
      '工作过程',
      '关键决定',
      '阶段总结',
      '原始记录',
      '归纳依据',
      '来源追溯'
    ]
  },
  {
    title: '个人知识库',
    events: [
      '记录学习问题',
      '整理问答笔记',
      '发现共同主题',
      '建立知识关联',
      '补充适用条件',
      '核对引用原文',
      '保留知识出处',
      '复用已有知识'
    ],
    entities: [
      '学习记录',
      '问答笔记',
      '共同主题',
      '知识关联',
      '适用条件',
      '知识出处'
    ]
  },
  {
    title: '记忆架构',
    events: [
      '保存原始数据',
      '整理过程信息',
      '区分理解层次',
      '建立分层记忆',
      '说明归纳依据',
      '检验知识结论',
      '连接底层记录',
      '形成可解释归纳'
    ],
    entities: [
      '原始数据',
      '过程信息',
      'DIKW 分层',
      '分层记忆',
      '归纳依据',
      '可解释归纳'
    ]
  }
]
const story = stories[Number(params.get('story') ?? 0)] ?? stories[0]
const titles = story.events
const labels = story.entities
const dense = params.has('dense')
const long = params.has('long')
const state = params.get('state')
const graph: SupervisionGraphView = {
  storyLine: { id: 'fixture', scope_json: '{"kind":"global"}' },
  events: Array.from({ length: dense ? 80 : 8 }, (_, index) => ({
    id: `event-${index}`,
    title: dense
      ? `模拟事件 ${index + 1}`
      : titles[index] +
        (long ? '：跨团队讨论中仍需保留完整的上下文与决策依据'.repeat(3) : ''),
    description:
      '阶段总结与聚合知识应保留来源，支持追溯原始记录。每次形成判断，都可以回到当时的问题、决定和未完成事项。此处为固定模拟内容。',
    occurred_at: dense
      ? '2026-09-21T08:00:00.000Z'
      : `2026-09-${String(14 + index).padStart(2, '0')}T08:00:00.000Z`
  })),
  entities: Array.from({ length: dense ? 40 : 6 }, (_, index) => ({
    id: `entity-${index}`,
    canonical_label: dense
      ? `模拟实体 ${index + 1}`
      : labels[index] + (long ? '需要关联跨阶段的完整原始记录'.repeat(4) : ''),
    description:
      '总结保留讨论的问题、形成的判断与尚未解决的事项。归纳需要连接原始依据，方便核对结论与理解语境。',
    confirmation_state: 'automatic'
  })),
  relations: [
    {
      id: 'relation-1',
      from_entity_id: 'entity-0',
      to_entity_id: 'entity-5',
      relation_type: 'supports',
      reason: '归纳结果需要能够回到原始工作记录，核对产生结论时的上下文。',
      confirmation_state: 'automatic'
    }
  ],
  sources: [
    {
      id: 'source-1',
      title: '模拟会议记录',
      occurred_at: '2026-09-21T08:00:00.000Z'
    }
  ],
  eventEntities: titles.map((_, index) => ({
    event_id: `event-${index}`,
    entity_id: `entity-${index % 6}`
  })),
  eventSources: titles.map((_, index) => ({
    event_id: `event-${index}`,
    source_id: 'source-1'
  }))
}
if (params.has('short')) {
  graph.events = graph.events.slice(0, 1)
  graph.entities = graph.entities.slice(0, 1)
  graph.relations = []
  graph.eventEntities = graph.eventEntities.slice(0, 1)
  graph.eventSources = graph.eventSources.slice(0, 1)
}
Object.defineProperty(window, 'goodbuddy', {
  value:
    state === 'unavailable'
      ? {}
      : {
          supervision: {
            batches: async ({ runId, offset, limit }: { runId: string; offset: number; limit: number }) => Array.from({ length: runId === 'activity-0' ? 6 : 12 }, (_, index) => ({
              id: `leaf-${index}`, projectId: index < 3 ? 'Atlas' : 'Beacon', conversationId: `conversation-${Math.floor(index / 2)}`,
              evidence: [{ id: `source-${index}`, sourceType: 'conversation', sourceId: `conversation-${Math.floor(index / 2)}`,
                title: ['交付计划与验收', '接口迁移讨论', '用户反馈核对'][Math.floor(index / 2) % 3],
                content: '模拟来源：验收需要核对负责人、交付日期和原始讨论依据。'.repeat(20),
                occurredAt: '2026-09-23T08:00:00Z', locator: { messageId: `message-${index}`, start: 0, end: 750, revision: 'saved-source-revision' } }],
              output: { summary: ['确认交付前先完成验收资料核验，外部评审日期待定。', '保留接口变更依据，迁移方案仍需项目负责人确认。'][index % 2],
                changeDigest: '已补充负责人和待核对项。', openItems: ['核对外部评审日期。'],
                events: [{ title: '验收安排', description: '先核对资料，再确认交付日期。', sourceReferenceIds: [`source-${index}`] }], entities: [], entityChanges: [], relations: [] }
            })).slice(offset, offset + limit),
            resume: async () => {}, pause: async () => {},
            activity: async (input?: { configId?: string }) => ['running', 'failed', 'completed'].map((status, index) => ({
              id: `activity-${index}`, kind: index === 2 ? 'supervision' : 'heartbeat', trigger: index === 2 ? 'manual' : 'scheduled', status,
              scope: { kind: 'global' }, startedAt: '2026-09-23T08:00:00Z', completedAt: status === 'running' ? null : '2026-09-23T08:01:00Z',
              timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-23T00:00:00Z' },
              error: status === 'failed' ? 'SIMULATED: 下游监督回顾失败，已保存心跳报告。'.repeat(8) : null,
              summary: 'SIMULATED: 已保存的执行摘要。', resultId: status === 'completed' ? 'fixture-result' : null,
              heartbeatStatus: index === 2 ? null : 'completed', supervisionStatus: status,
              ...(params.has('activity') ? {
                status: index === 0 ? 'failed' : index === 1 ? 'running' : 'completed',
                supervisionStatus: index === 0 ? 'failed' : index === 1 ? 'running' : 'completed',
                error: index === 0 ? JSON.stringify(['events', 'entities', 'entityChanges', 'relations'].map(key => ({ expected: 'array', code: 'invalid_type', path: [key], message: 'Invalid input: expected array, received undefined' })), null, 2) : null,
                reviewProgress: { runId: `activity-${index}`, batches: index === 0 ? 6 : 12, characters: index === 0 ? 4515 : 9800,
                  sources: 32, remainingSources: index === 1 ? 8 : 0, complete: index === 2,
                  phase: index === 0 ? 'summarizing' : index === 1 ? 'extracting' : 'saving', navigationNodes: index === 0 ? 1 : index === 1 ? 0 : 11, inFlight: index === 1 ? 2 : 0,
                  settings: { pageSize: 50, batchCharacters: 8000, batchMessages: 20, executionSeconds: 300, timeoutSeconds: 240, concurrency: 2 } }
              } : {})
            })).filter(row => !input?.configId || (input.configId === 'plan' && row.kind === 'heartbeat')),
            overview: async () => {
              if (state === 'loading') return new Promise(() => {})
              if (state === 'error')
                throw new Error('SIMULATED: 读取监督者数据库失败，请重试。')
               return state === 'empty' ? [] : [{ id: 'fixture-result', storyLineId: 'fixture', sourceId: 'source-1',
                 summary: params.has('long-summary') ? Array.from({ length: 24 }, (_, index) => `第 ${index + 1} 项核验：本周已核对交付计划中的负责人、验收日期和原始讨论记录。团队决定先完成资料核验，再确认最终交付时间。现有记录支持这一安排，但外部评审时间仍待确认，不能将内部计划日期视为已承诺的截止日期。下一次回顾需要核对评审意见是否返回。`).join('\n\n') + '\n\n长摘要末尾：仍须确认最终验收条件。' : params.has('recap') ? '本周已核对交付计划中的负责人、验收日期和原始讨论记录。需求澄清与阶段总结能够对应到具体会议，交付清单中的两项缺失信息已补齐。\n\n团队决定先完成资料核验，再确认最终交付时间。现有记录支持这一安排，但外部评审时间仍待确认，不能将内部计划日期视为已承诺的截止日期。\n\n下一次回顾需要核对评审意见是否返回，以及负责人与验收条件是否发生变化。保留这些未完成事项，便于继续跟进。' : '模拟回顾',
                 changeDigest: params.has('recap') ? '交付清单补充了负责人；验收条件已与原始讨论对齐。' : '', createdAt: '2026-09-22T00:00:00Z',
                 scope: { kind: 'global' }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z' }, openItems: params.has('recap') ? ['确认外部评审时间，并回填交付清单。', '检查验收材料是否覆盖所有已确认需求。'] : [] },
                 ...(params.has('recap') ? [{ id: 'older-result', storyLineId: 'fixture', sourceId: 'source-1', summary: '上期结果：交付清单尚缺负责人，需要继续核对。', changeDigest: '', createdAt: '2026-09-15T00:00:00Z', scope: { kind: 'global' }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-15T00:00:00Z' }, openItems: ['核对负责人。'] }] : [])]
            },
            graph: async () =>
              state === 'empty'
                ? {
                    storyLine: null,
                    events: [],
                    entities: [],
                    relations: [],
                    sources: [],
                    eventEntities: [],
                    eventSources: []
                  }
                : graph,
             run: async () => {
                if (params.has('recap') && !params.has('fail-run')) return new Promise(() => {})
              throw new Error('SIMULATED: 模型暂时不可用。此验证不调用模型。')
            },
            entityAction: async () => {},
            relationAction: async () => {},
            source: async () => ({
              title: '模拟会议记录',
              content: '视觉 fixture，不是真实用户数据。',
              occurredAt: '2026-09-21T08:00:00.000Z'
            })
          }
        }
})
const noop = async () => {}
const menu = params.has('menu')
const createdAt = '2026-09-23T08:00:00.000Z'
createRoot(document.getElementById('root')!).render(
  <UiLocaleProvider initialPreference="zh-CN">
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0
      }}
    >
      <div
        style={{
          padding: 'var(--space-2) var(--space-4)',
          color: 'var(--text-secondary)',
          display: 'flex',
          flexWrap: 'wrap',
          overflowWrap: 'anywhere',
          gap: 'var(--space-3)'
        }}
      >
        <span>SIMULATED FIXTURE / 单故事 API / {story.title}</span>
        {stories.map((item, index) => (
          <a key={item.title} href={`?story=${index}`}>
            {item.title}
          </a>
        ))}
      </div>
      {params.has('sidebar') ? <div className="assistant-sidebar__section task-center">
        <SupervisionCard
          target={{ type: 'conversation', conversationId: 'simulated-conversation-uuid' }}
          conversationTitle={'模拟会话：核对项目交付清单与阶段回顾'.repeat(3)}
          pinned
          onTogglePinned={() => {}}
        />
      </div> : <PageShell variant="supervisor">
        <HeartbeatCenter
          applicationSettings={applicationSettingsSchema.parse({ checkUpdatesOnStartup: true, updateSource: 'github', modelDownloadSource: 'modelscope', localToolEnvironment: defaultLocalToolEnvironmentSettings, conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false })}
          onUpdateApplicationSettings={async () => true}
          configs={menu ? [{ id: 'plan', name: '模拟每日回顾', scope: { kind: 'global' }, timezone: 'Asia/Shanghai', recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 48, retentionDays: 90, nextRunAt: '2026-09-24T01:00:00.000Z', createdAt, updatedAt: createdAt }] : []}
          runs={menu ? [{ id: 'run', configId: 'plan', trigger: 'scheduled', scheduledFor: createdAt, status: 'completed', attemptCount: 1, createdAt, updatedAt: createdAt }] : []}
          entries={menu ? [{ id: 'report', configId: 'plan', runId: 'run', scheduledFor: createdAt, summary: '模拟自动监督报告：交付计划已更新，待核对负责人和验收日期。', highlights: ['保留原始依据，核对交付时间。'], proposedMemoryIds: ['memory'], followUpTaskIds: ['task'], createdAt }] : []}
          memories={menu ? [{ id: 'memory', scope: 'global', type: 'preference', content: '模拟建议：周会总结保留负责人和下一次检查日期。', confidence: 0.9, salience: 0.8, status: 'proposed', createdAt, updatedAt: createdAt }] : []}
          projects={[]}
          tasks={menu ? [{ id: 'task', title: '模拟行动：核对交付清单', instructions: '核对负责人、验收日期和原始讨论依据。', origin: 'assistant', status: 'paused', createdAt }] : []}
          onCreate={noop}
          onUpdate={noop}
          onSetPaused={noop}
          onRemove={noop}
          onRunNow={noop}
          onRefresh={noop}
          onSetMemoryStatus={noop}
          onSetTaskStatus={noop}
          onUseFollowUpTask={() => {}}
          onRetryLoad={noop}
        />
      </PageShell>}
    </div>
  </UiLocaleProvider>
)
