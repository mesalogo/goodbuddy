import { describe, expect, it } from 'vitest'
import {
  WORKBAR_APP_DEFINITIONS,
  WORKBAR_LIMITS,
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
      WORKBAR_APP_DEFINITIONS.map(({ id, instancePolicy, defaultOpen }) => ({
        id,
        instancePolicy,
        defaultOpen
      }))
    ).toEqual([
      { id: 'tasks', instancePolicy: 'single', defaultOpen: true },
      { id: 'workspace', instancePolicy: 'single', defaultOpen: true },
      { id: 'browser', instancePolicy: 'single', defaultOpen: true },
      { id: 'results', instancePolicy: 'single', defaultOpen: true },
      {
        id: 'terminal',
        instancePolicy: 'multiple',
        defaultOpen: false
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
      widthRatio: 0.35
    } as const

    expect(workbarLayoutPreferencesSchema.parse(layout)).toEqual(layout)
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
      widthRatio: 0.4
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
})
