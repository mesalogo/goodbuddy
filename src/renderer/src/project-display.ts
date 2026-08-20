import type { AssistantProject } from '../../shared/assistant-contracts'
import { isUntouchedBuiltInDefaultProject } from '../../shared/assistant-contracts'

export type ProjectDisplayText = {
  name: string
  description: string
}

type ProjectDisplayTranslation = (
  key:
    | 'builtInDefaultProject.name'
    | 'builtInDefaultProject.description'
) => string

export function getProjectDisplayText(
  project: AssistantProject,
  translate: ProjectDisplayTranslation
): ProjectDisplayText {
  return isUntouchedBuiltInDefaultProject(project)
    ? {
        name: translate('builtInDefaultProject.name'),
        description: translate('builtInDefaultProject.description')
      }
    : {
        name: project.name,
        description: project.description
      }
}
