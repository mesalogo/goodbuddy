// Simulated visual fixture only. No preload, user database, or model is used.
import { createRoot } from 'react-dom/client'
import { HeartbeatCenter } from '../../src/renderer/src/HeartbeatCenter'
import { PageShell } from '../../src/renderer/src/WorkspacePrimitives'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import type { SupervisionGraphView } from '../../src/shared/supervision-contracts'
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
            overview: async () => {
              if (state === 'loading') return new Promise(() => {})
              if (state === 'error')
                throw new Error('SIMULATED: 读取监督者数据库失败，请重试。')
               return state === 'empty' ? [] : [{ id: 'fixture-result', storyLineId: 'fixture', sourceId: 'source-1',
                 summary: '模拟回顾', changeDigest: '', createdAt: '2026-09-22T00:00:00Z',
                 scope: { kind: 'global' }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z' }, openItems: [] }]
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
      <PageShell variant="supervisor">
        <HeartbeatCenter
          configs={[]}
          runs={[]}
          entries={[]}
          memories={[]}
          projects={[]}
          tasks={[]}
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
      </PageShell>
    </div>
  </UiLocaleProvider>
)
