import { describe, expect, it } from 'vitest'
import {
  REMOTE_PROJECT_SAVE_LIMITS,
  remoteProjectCreateDraftSchema,
  remoteProjectSaveProgressSchema,
  remoteProjectSaveRequestSchema,
  remoteProjectUpdateDraftSchema
} from './remote-project-candidate-contracts'

const hostId = '00000000-0000-4000-8000-000000000010'
const projectId = '00000000-0000-4000-8000-000000000020'
const profileId = '00000000-0000-4000-8000-000000000040'
const draft = {
  name: '远程项目',
  description: 'Awaited save',
  defaultWorkMode: 'ask' as const,
  runtimeSelection: { provider: 'model' as const, profileId },
  hostId,
  remoteRootPath: '/srv/projects/goodbuddy'
}

describe('remote project save contracts', () => {
  it('accepts closed create and update save requests', () => {
    expect(
      remoteProjectSaveRequestSchema.parse({
        intent: 'create',
        draft
      })
    ).toEqual({ intent: 'create', draft })
    expect(
      remoteProjectSaveRequestSchema.parse({
        intent: 'update',
        draft: { projectId, ...draft }
      })
    ).toEqual({ intent: 'update', draft: { projectId, ...draft } })
    expect(() =>
      remoteProjectCreateDraftSchema.parse({
        ...draft,
        candidateId: projectId
      })
    ).toThrow()
    expect(() =>
      remoteProjectUpdateDraftSchema.parse({
        projectId,
        ...draft,
        commitToken: 'token'
      })
    ).toThrow()
  })

  it('accepts Execute without consent or trust fields', () => {
    expect(
      remoteProjectCreateDraftSchema.parse({
        ...draft,
        defaultWorkMode: 'execute'
      }).defaultWorkMode
    ).toBe('execute')
    expect(() =>
      remoteProjectCreateDraftSchema.parse({
        ...draft,
        trust: {},
        defaultWorkMode: 'execute'
      })
    ).toThrow()
  })

  it('requires a Runtime and a bounded absolute remote root', () => {
    const withoutRuntime: Partial<typeof draft> = { ...draft }
    delete withoutRuntime.runtimeSelection
    expect(() =>
      remoteProjectCreateDraftSchema.parse(withoutRuntime)
    ).toThrow()
    expect(() =>
      remoteProjectCreateDraftSchema.parse({
        ...draft,
        remoteRootPath: 'srv/project'
      })
    ).toThrow()
    expect(() =>
      remoteProjectCreateDraftSchema.parse({
        ...draft,
        remoteRootPath: '/srv/\nprivate'
      })
    ).toThrow(/control characters/iu)
    for (const remoteRootPath of [
      '/srv//project',
      '/srv/./project',
      '/srv/../project'
    ]) {
      expect(() =>
        remoteProjectCreateDraftSchema.parse({
          ...draft,
          remoteRootPath
        })
      ).toThrow(/empty, dot, or parent segments/iu)
    }
    expect(() =>
      remoteProjectCreateDraftSchema.parse({
        ...draft,
        remoteRootPath: `/${'界'.repeat(
          Math.floor(
            REMOTE_PROJECT_SAVE_LIMITS.maximumAbsolutePathBytes / 3
          ) + 1
        )}`
      })
    ).toThrow(/4096 UTF-8 bytes/iu)
  })

  it('exposes only an ephemeral progress phase', () => {
    expect(remoteProjectSaveProgressSchema.parse({ phase: 'agent' })).toEqual({
      phase: 'agent'
    })
    expect(() =>
      remoteProjectSaveProgressSchema.parse({
        phase: 'agent',
        candidateId: projectId
      })
    ).toThrow()
  })
})
