// Simulated fixture, or read-only production queries from an explicitly supplied local backup. No models.
import { createRoot } from 'react-dom/client'
import { HeartbeatCenter } from '../../src/renderer/src/HeartbeatCenter'
import { SupervisionCard } from '../../src/renderer/src/RightAssistantSidebar'
import { PageShell } from '../../src/renderer/src/WorkspacePrimitives'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import type { SupervisionGraphView } from '../../src/shared/supervision-contracts'
import type { AssistantProject } from '../../src/shared/assistant-contracts'
import { applicationSettingsSchema, defaultLocalToolEnvironmentSettings } from '../../src/shared/application-settings-contracts'
import '../../src/renderer/src/styles.css'
import '@fontsource-variable/noto-sans-sc/wght.css'
import { installBundledUiFonts } from '../../src/renderer/src/fonts'

installBundledUiFonts()

const params = new URLSearchParams(location.search)
if (params.has('spiral')) {
  const THREE = await import('three')
  const add = THREE.Group.prototype.add
  const clear = THREE.Group.prototype.clear
  let points: number[][] = []
  const events = new Set<string>()
  const dots = new Set<string>()
  let clusters = 0
  let timeline: unknown
  let marks: Array<{ ids: string[]; storyId?: string; color: string }> = []
  let staves: Array<{ id: string; color: string }> = []
  THREE.Group.prototype.clear = function () {
    events.clear(); dots.clear(); clusters = 0; marks = []; staves = []
    return clear.call(this)
  }
  THREE.Group.prototype.add = function (...objects) {
    for (const object of objects) {
      for (const event of object.userData.node?.events ?? []) events.add(event.id)
      if (object.userData.cluster) {
        clusters++
        for (const event of object.userData.cluster.events) dots.add(event.id)
        marks.push({ ids: object.userData.cluster.events.map((event: { id: string }) => event.id), storyId: object.userData.cluster.events[0]?.storyId,
          color: ((object as import('three').Mesh).material as import('three').MeshStandardMaterial).color.getHexString() })
      }
      if (object.userData.timeline) {
        const mesh = object as import('three').Mesh<import('three').TubeGeometry, import('three').MeshStandardMaterial[]>
        const positions = mesh.geometry.getAttribute('position'), count = mesh.geometry.parameters.tubularSegments
        const center = (ring: number) => {
          const sum = new THREE.Vector3()
          for (let i = 0; i < 8; i++) sum.add(new THREE.Vector3().fromBufferAttribute(positions, ring * 9 + i))
          return sum.divideScalar(8)
        }
        points = Array.from({length: count + 1}, (_, i) => { const p = center(i); return [Math.hypot(p.x, p.z), p.y] })
        const intervals = object.userData.timeline
        const timeAt = (ring: number) => intervals[0].from + (center(ring).y / 430 + 0.5) * (intervals.at(-1).to - intervals[0].from)
        timeline = { intervals, groups: mesh.geometry.groups.map(group => ({...group, from:timeAt(group.start / 48), to:timeAt((group.start + group.count) / 48)})),
          colors: mesh.material.map(material => material.color.getHexString()), indices: mesh.geometry.index!.count }
      }
      if (object.userData.node && !object.userData.cluster) staves.push({ id: object.userData.node.id,
        color: ((object as import('three').Mesh).material as import('three').MeshBasicMaterial).color.getHexString() })
    }
    document.documentElement.dataset.helix = JSON.stringify({ points, events: [...events], dots: [...dots], clusters, timeline, marks, staves })
    return add.apply(this, objects)
  }
    THREE.Scene.prototype.onAfterRender = function (_renderer, scene, camera) {
      document.documentElement.dataset.camera = JSON.stringify(camera.position.toArray())
      const point = new THREE.Vector3(), bounds = { left: 1, right: -1, top: -1, bottom: 1 }
      scene.traverse(object => {
        const positions = (object as import('three').Mesh).geometry?.getAttribute('position')
        if (!positions) return
        for (let i = 0; i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld).project(camera)
          bounds.left = Math.min(bounds.left, point.x); bounds.right = Math.max(bounds.right, point.x)
          bounds.top = Math.max(bounds.top, point.y); bounds.bottom = Math.min(bounds.bottom, point.y)
        }
      })
      document.documentElement.dataset.sceneBounds = JSON.stringify(bounds)
    }
}
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
const windowed = params.has('windowed')
const dense = params.has('dense') || windowed
const long = params.has('long')
const state = params.get('state')
const graph: SupervisionGraphView = {
  storyLine: { id: 'fixture', scope_json: '{"kind":"global"}' },
  events: Array.from({ length: windowed ? 600 : dense ? 80 : 8 }, (_, index) => ({
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
  entities: Array.from({ length: windowed ? 600 : dense ? 40 : 6 }, (_, index) => ({
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
if (windowed) {
  graph.relations = Array.from({ length: 600 }, (_, index) => ({ ...graph.relations[0]!, id: `relation-${index}`,
    from_entity_id: `entity-${index}`, to_entity_id: `entity-${(index + 1) % 600}` }))
  graph.eventEntities = graph.events.map((event, index) => ({ event_id: event.id, entity_id: `entity-${index}` }))
  graph.eventSources = graph.events.map(event => ({ event_id: event.id, source_id: 'source-1' }))
}
if (params.has('short')) {
  graph.events = graph.events.slice(0, 1)
  graph.entities = graph.entities.slice(0, 1)
  graph.relations = []
  graph.eventEntities = graph.eventEntities.slice(0, 1)
  graph.eventSources = graph.eventSources.slice(0, 1)
}
const menu = params.has('menu')
const createdAt = '2026-09-23T08:00:00.000Z'
Object.defineProperty(window, 'goodbuddy', {
  value:
    state === 'unavailable'
      ? {}
      : {
          supervision: {
            ...(params.has('spiral') ? { stories: async () => ({ stories: [0, 1].map(storyIndex => ({
              id: storyIndex ? 'secondary' : 'feature', projectId: 'p', projectName: 'Fixture project', parentId: null, level: 'feature', name: storyIndex ? 'Secondary story' : 'Fixture story',
              description: '', state: 'active', stateEventId: null, userEdited: false, startedAt: null, endedAt: null,
              events: [...graph.events, { id: 'outside-review', title: 'Outside review', occurred_at: '2026-08-01T00:00:00Z' }].filter((_event, index) => index % 2 === storyIndex).map(event => ({
                id: event.id, title: event.title, startedAt: event.occurred_at, endedAt: event.occurred_at, projectId: 'p', primary: true, userSet: false
              }))
            })), experiences: [], unassigned: 0, canUndo: false }) } : {}),
            continueContext: async () => ({ prompt: '模拟讨论上下文：本周已核对交付清单，负责人已确认。\n\n原始依据：模拟会议记录。外部评审时间仍待确认，下一步需要核对验收条件。' }),
            continue: async () => { throw new Error('Preview fixture must not send a message') },
            execution: async () => ({ active: params.has('activity'), ...(params.has('activity') ? { runId: 'activity-1' } : {}) }),
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
             resume: async () => {}, pause: async () => {}, cancel: async () => {},
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
             graph: async (input?: { resultId?: string }) =>
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
                : params.has('spiral') ? { ...graph,
                  events: (input?.resultId === 'older-result' ? graph.events.slice(0, 1) : graph.events).map((event, index) => ({ ...event,
                    started_at: event.occurred_at, ended_at: new Date(Date.parse(event.occurred_at) + (index % 3 ? 3_600_000 : 0)).toISOString() })),
                  attention: [1, 1, 1, 100, 100, 4, 4].map((turns, index) => ({
                    start: `2026-09-${String(1 + index * 3).padStart(2, '0')}T01:00:00.000Z`, turns, characters: turns * 20
                  })).filter(slot => input?.resultId !== 'older-result' || slot.start < '2026-09-15')
                } : graph,
             run: async () => {
                if (params.has('recap') && !params.has('fail-run')) return new Promise(() => {})
              throw new Error('SIMULATED: 模型暂时不可用。此验证不调用模型。')
            },
            entityAction: async () => {},
            relationAction: async () => {},
            suggestions: async () => menu ? [
              { id: '00000000-0000-4000-8000-000000000901', resultId: 'fixture-result', heartbeatRunId: 'run', scope: { kind: 'global' }, kind: 'open_item',
                title: '模拟建议：确认外部评审时间', detail: '外部评审时间仍未确定，交付清单需要回填。下次回顾前可先确认这一项。', sourceIds: ['source-1', 'source-2'],
                entityId: null, relationId: null, taskId: null, status: 'pending', createdAt },
              { id: '00000000-0000-4000-8000-000000000902', resultId: 'fixture-result', heartbeatRunId: 'run', scope: { kind: 'global' }, kind: 'conflict',
                title: '模拟建议：两种交付顺序尚未统一', detail: '一处记录先核验资料，另一处先确认日期，尚无明确取舍。', sourceIds: ['source-1'],
                entityId: null, relationId: null, taskId: null, status: 'pending', createdAt }
            ] : [],
            suggestionAction: async () => { throw new Error('Preview fixture must not change suggestions') },
            retrySuggestions: async () => 0,
            source: async () => ({
              ...(params.has('preview') ? { sourceType: 'conversation', sourceId: 'simulated-conversation-uuid' } : {}),
              title: '模拟会议记录',
              content: '视觉 fixture，不是真实用户数据。',
              occurredAt: '2026-09-21T08:00:00.000Z'
            })
          }
        }
})
let portableProjects: AssistantProject[] = []
if (params.has('portable')) {
  const data = await (await fetch('/portable-review.json')).json()
  portableProjects = data.projects
  Object.assign(window.goodbuddy.supervision, {
    overview: async () => data.results,
    graph: async ({ resultId }: { resultId: string }) => data.graphs[resultId],
    stories: async ({ scope }: { scope: unknown }) => data.stories[JSON.stringify(scope)],
    run: async () => { throw new Error('Read-only acceptance must not run reviews') }
  })
}
if (windowed) {
  const api = window.goodbuddy.supervision
  const calls = { graph: 0, source: 0, edits: 0 }
  const updateCalls = () => { document.documentElement.dataset.supervisorCalls = JSON.stringify(calls) }
  const readGraph = api.graph, readSource = api.source
  api.graph = async input => { calls.graph++; updateCalls(); return readGraph(input) }
  api.source = async input => { calls.source++; updateCalls(); return readSource(input) }
  api.entityAction = async input => {
    calls.edits++; updateCalls()
    const entity = graph.entities.find(item => item.id === input.entityId)
    if (entity && input.action === 'revise' && input.label) entity.canonical_label = input.label
  }
  updateCalls()
}
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
          overflowWrap: 'anywhere',
          gap: 'var(--space-3)'
        }}
      >
        <span>{params.has('portable') ? 'READ-ONLY PORTABLE BACKUP / 只读回顾验证' : `SIMULATED FIXTURE / 单故事 API / ${story.title}`}</span>
        {!params.has('portable') && stories.map((item, index) => (
          <a key={item.title} href={`?story=${index}`}>
            {item.title}
          </a>
        ))}
      </div>
      {params.has('sidebar') ? <div className="assistant-sidebar__section task-center" style={{ overflowY: 'auto', minHeight: 0 }}>
        <SupervisionCard
          target={{ type: 'conversation', conversationId: 'simulated-conversation-uuid' }}
          conversationTitle={'模拟会话：核对项目交付清单与阶段回顾'.repeat(3)}
          activeConversationId="simulated-conversation-uuid"
          onContinueSupervision={async () => { throw new Error('Preview fixture must not send a message') }}
          pinned
          onTogglePinned={() => {}}
        />
      </div> : <PageShell variant="supervisor">
        <HeartbeatCenter
          onNotify={(notice) => {
            document.documentElement.dataset.reviewNoticeTone = notice.tone
            document.documentElement.dataset.reviewNoticeMessage = notice.message
          }}
          applicationSettings={applicationSettingsSchema.parse({ checkUpdatesOnStartup: true, updateSource: 'github', modelDownloadSource: 'modelscope', localToolEnvironment: defaultLocalToolEnvironmentSettings, conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false })}
          onUpdateApplicationSettings={async () => true}
           configs={menu || params.has('plan-only') ? [{ id: 'plan', name: '模拟每日回顾', scope: { kind: 'global' }, timezone: 'Asia/Shanghai', recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 48, retentionDays: 90, nextRunAt: '2026-09-24T01:00:00.000Z', createdAt, updatedAt: createdAt }] : []}
          runs={menu ? [{ id: 'run', configId: 'plan', trigger: 'scheduled', scheduledFor: createdAt, status: 'completed', attemptCount: 1, createdAt, updatedAt: createdAt }] : []}
          entries={menu ? [{ id: 'report', configId: 'plan', runId: 'run', scheduledFor: createdAt, summary: '模拟历史心跳报告：交付计划已更新，待核对负责人和验收日期。', highlights: ['保留原始依据，核对交付时间。'], proposedMemoryIds: ['memory'], followUpTaskIds: ['task'], createdAt }] : []}
          memories={menu ? [{ id: 'memory', scope: 'global', type: 'preference', content: '模拟建议：周会总结保留负责人和下一次检查日期。', confidence: 0.9, salience: 0.8, status: 'proposed', createdAt, updatedAt: createdAt }] : []}
          projects={portableProjects}
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
           onOpenConversation={params.has('preview') ? () => { throw new Error('Preview fixture must not navigate') } : undefined}
        />
      </PageShell>}
    </div>
  </UiLocaleProvider>
)
