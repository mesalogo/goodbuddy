import { describe, expect, it } from 'vitest'
import {
  WORKBAR_APP_DEFINITIONS,
  WORKBAR_LIMITS,
  normalizeWorkbarLayoutPreferences,
  workbarAppDefinitionSchema,
  workbarLayoutPreferencesSchema,
  workbarTabInstanceSchema
} from './workbar-contracts'

const taskId = '00000000-0000-4000-8000-000000000101'
const terminalId = '00000000-0000-4000-8000-000000000102'
const projectId = '00000000-0000-4000-8000-000000000201'

describe('workbar contracts', () => {
  it('freezes the first application catalog and instance policies', () => {
    expect(
      WORKBAR_APP_DEFINITIONS.map(({ id, instancePolicy, defaultContext, defaultOpen, required, closable, reorderable }) => ({
        id,
        instancePolicy,
        defaultContext,
        defaultOpen,
        required,
        closable,
        reorderable
      }))
    ).toEqual([
      { id: 'tasks', instancePolicy: 'single', defaultContext: 'current-project', defaultOpen: true, required: true, closable: false, reorderable: true },
      { id: 'workspace', instancePolicy: 'single', defaultContext: 'current-project', defaultOpen: true, required: true, closable: false, reorderable: true },
      { id: 'browser', instancePolicy: 'multiple', defaultContext: 'current-conversation', defaultOpen: true, required: false, closable: true, reorderable: true },
      { id: 'results', instancePolicy: 'single', defaultContext: 'current-project', defaultOpen: true, required: false, closable: true, reorderable: true },
      {
        id: 'terminal',
        instancePolicy: 'multiple',
        defaultContext: 'current-project',
        defaultOpen: false,
        required: false,
        closable: true,
        reorderable: true
      }
    ])
    for (const definition of WORKBAR_APP_DEFINITIONS) {
      expect(workbarAppDefinitionSchema.parse(definition)).toEqual(
        definition
      )
    }
  })

  it('accepts an ordered layout with public target references', () => {
    const layout = {
      instances: [
        { id: taskId, appId: 'tasks', title: '任务中心' },
        {
          id: terminalId,
          appId: 'terminal',
          title: '终端 · 项目',
          targetRef: { type: 'project', projectId }
        }
      ],
      activeInstanceId: terminalId,
      expanded: true,
      dock: 'right',
      widthRatio: 0.35,
      taskScope: 'current-project'
    } as const

    expect(workbarLayoutPreferencesSchema.parse(layout)).toEqual(layout)
  })

  it('persists a browser conversation binding without a runtime tab identifier', () => {
    expect(
      workbarTabInstanceSchema.parse({
        id: '00000000-0000-4000-8000-000000000103',
        appId: 'browser',
        title: '浏览器 · 会话 A',
        targetRef: { type: 'conversation', conversationId: 'conversation-a' }
      })
    ).toEqual({
      id: '00000000-0000-4000-8000-000000000103',
      appId: 'browser',
      title: '浏览器 · 会话 A',
      targetRef: { type: 'conversation', conversationId: 'conversation-a' }
    })
    expect(
      workbarTabInstanceSchema.safeParse({
        id: '00000000-0000-4000-8000-000000000103',
        appId: 'browser',
        title: '浏览器',
        targetRef: { type: 'conversation', conversationId: 'conversation-a' },
        tabId: '00000000-0000-4000-8000-000000000999'
      }).success
    ).toBe(false)
  })

  it('explicitly keeps every existing app visible across context switches', () => {
    for (const definition of WORKBAR_APP_DEFINITIONS) {
      expect(definition.visibleAcrossContextSwitches).toBe(true)
      const { visibleAcrossContextSwitches, ...withoutVisibility } = definition
      expect(workbarAppDefinitionSchema.safeParse(withoutVisibility).success).toBe(false)
      expect(
        workbarAppDefinitionSchema.parse({
          ...withoutVisibility,
          visibleAcrossContextSwitches
        }).visibleAcrossContextSwitches
      ).toBe(true)
    }
  })

  it('rejects unknown and sensitive target parameters', () => {
    for (const targetRef of [
      { type: 'local', cwd: 'C:\\secret' },
      { type: 'ssh-host', hostId: projectId, password: 'secret' },
      {
        type: 'project',
        projectId,
        environment: { MODEL_API_KEY: 'secret' }
      }
    ]) {
      expect(
        workbarTabInstanceSchema.safeParse({
          id: terminalId,
          appId: 'terminal',
          title: '终端',
          targetRef
        }).success
      ).toBe(false)
    }
    expect(
      workbarTabInstanceSchema.safeParse({
        id: taskId,
        appId: 'tasks',
        title: '任务中心',
        privateState: {}
      }).success
    ).toBe(false)
  })

  it('enforces title, count, uniqueness, and active-instance bounds', () => {
    expect(
      workbarTabInstanceSchema.safeParse({
        id: terminalId,
        appId: 'terminal',
        title: 'x'.repeat(WORKBAR_LIMITS.maximumTitleBytes + 1),
        targetRef: { type: 'local' }
      }).success
    ).toBe(false)

    const task = { id: taskId, appId: 'tasks', title: '任务中心' }
    const base = {
      instances: [task],
      activeInstanceId: taskId,
      expanded: true,
      dock: 'right',
      widthRatio: 0.4,
      taskScope: 'current-project'
    }
    expect(
      workbarLayoutPreferencesSchema.safeParse({
        ...base,
        instances: [task, { ...task, id: terminalId }]
      }).success
    ).toBe(false)
    expect(
      workbarLayoutPreferencesSchema.safeParse({
        ...base,
        activeInstanceId: terminalId
      }).success
    ).toBe(false)
    expect(
      workbarLayoutPreferencesSchema.safeParse({
        ...base,
        instances: Array.from(
          { length: WORKBAR_LIMITS.maximumOpenInstances + 1 },
          (_, index) => ({
            id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            appId: 'terminal',
            title: `终端 ${index}`,
            targetRef: { type: 'local' }
          })
        )
      }).success
    ).toBe(false)
  })

  it('normalizes duplicate policies, fixed defaults, and stale active state', () => {
    const browserId = '00000000-0000-4000-8000-000000000103'
    const secondBrowserId = '00000000-0000-4000-8000-000000000104'
    const workspaceId = '00000000-0000-4000-8000-000000000105'
    const normalized = normalizeWorkbarLayoutPreferences(
      {
        instances: [
          { id: browserId, appId: 'browser', title: '浏览器' },
          { id: secondBrowserId, appId: 'browser', title: '浏览器 2' },
          { id: workspaceId, appId: 'workspace', title: '工作区' },
          { id: terminalId, appId: 'workspace', title: '重复工作区' }
        ],
        activeInstanceId: terminalId,
        expanded: true,
        dock: 'right',
        widthRatio: 0.4,
        taskScope: 'all-projects'
      },
      [
        { id: taskId, appId: 'tasks', title: '任务中心' },
        { id: workspaceId, appId: 'workspace', title: '工作区' }
      ]
    )

    expect(normalized?.instances.map(({ id, appId }) => ({ id, appId })))
      .toEqual([
        { id: taskId, appId: 'tasks' },
        { id: browserId, appId: 'browser' },
        { id: secondBrowserId, appId: 'browser' },
        { id: workspaceId, appId: 'workspace' }
      ])
    expect(normalized?.activeInstanceId).toBe(taskId)
    expect(normalized?.taskScope).toBe('all-projects')
  })

  it('preserves a valid empty layout with a null active instance', () => {
    expect(
      normalizeWorkbarLayoutPreferences(
        {
          instances: [],
          activeInstanceId: null,
          expanded: false,
          dock: 'right',
          widthRatio: 0.4
        },
        []
      )
    ).toEqual({
      instances: [],
      activeInstanceId: null,
      expanded: false,
      dock: 'right',
      widthRatio: 0.4,
      taskScope: 'current-project'
    })
  })
})
