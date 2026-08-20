import { describe, expect, it } from 'vitest'
import type { AssistantProject } from '../../shared/assistant-contracts'
import {
  builtInDefaultProjectSeedDescription,
  builtInDefaultProjectSeedName
} from '../../shared/assistant-contracts'
import { getProjectDisplayText } from './project-display'

const project: AssistantProject = {
  id: '00000000-0000-4000-8000-000000000101',
  name: builtInDefaultProjectSeedName,
  description: builtInDefaultProjectSeedDescription,
  rootPath: 'C:\\Workspace',
  defaultWorkMode: 'ask',
  kind: 'user',
  builtInDefault: true,
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
}

describe('getProjectDisplayText', () => {
  it('localizes the untouched seed without changing the project', () => {
    expect(
      getProjectDisplayText(project, (key) => ({
        'builtInDefaultProject.name': 'Default project',
        'builtInDefaultProject.description':
          'GoodBuddy default workspace'
      })[key])
    ).toEqual({
      name: 'Default project',
      description: 'GoodBuddy default workspace'
    })
    expect(project.name).toBe(builtInDefaultProjectSeedName)
    expect(project.description).toBe(
      builtInDefaultProjectSeedDescription
    )
  })

  it('keeps independently created identical project text raw', () => {
    const independentProject = {
      ...project,
      builtInDefault: false
    }
    expect(
      getProjectDisplayText(independentProject, () => 'localized')
    ).toEqual({
      name: builtInDefaultProjectSeedName,
      description: builtInDefaultProjectSeedDescription
    })
  })

  it('keeps localization across unrelated project setting changes', () => {
    expect(
      getProjectDisplayText(
        {
          ...project,
          rootPath: 'D:\\Moved',
          defaultWorkMode: 'execute',
          runtimeSelection: { provider: 'continue' },
          updatedAt: '2026-08-01T00:00:01.000Z'
        },
        (key) =>
          key === 'builtInDefaultProject.name'
            ? 'Default project'
            : 'GoodBuddy default workspace'
      )
    ).toEqual({
      name: 'Default project',
      description: 'GoodBuddy default workspace'
    })
  })
})
