import type { AssistantExpert } from '../../shared/assistant-contracts'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { requestSystemOne } from '../agent/system-one-service'

export type SystemOneRoleSelection = {
  expert: AssistantExpert
  choice: string
  confidence?: number
  probabilities?: Record<string, number>
}

export async function selectRoleWithSystemOne(
  prompt: string,
  experts: readonly AssistantExpert[],
  settings: Pick<ResolvedRuntimeSettings, 'modelProfiles' | 'roleSelectionModelProfileId'>,
  signal: AbortSignal
): Promise<SystemOneRoleSelection | undefined> {
  const profile = settings.roleSelectionModelProfileId
    ? settings.modelProfiles.find((candidate) => candidate.id === settings.roleSelectionModelProfileId)
    : undefined
  const candidates = experts.filter((expert) => expert.enabled)
  if (!profile || profile.protocol !== 'system-one' || candidates.length < 1) return undefined
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => {
    timeoutController.abort(new Error('System One 角色选择超时'))
  }, 10_000)
  let response
  try {
    response = await requestSystemOne(profile, {
      model: profile.modelName,
      state: { task: prompt.slice(0, 20_000) },
      questions: {
        role: {
          type: 'choice',
          instructions: '请选择最适合处理当前任务的 Assistant 角色。',
          criteria: Object.fromEntries(
            candidates.map((expert) => [
              expert.id,
              expert.description || expert.name
            ])
          )
        }
      }
    }, AbortSignal.any([signal, timeoutController.signal]))
  } finally {
    clearTimeout(timeout)
  }
  const answer = response.answers.role
  if (!answer || answer.type !== 'choice' || !answer.choice) return undefined
  const expert = candidates.find((candidate) => candidate.id === answer.choice)
  if (!expert) return undefined
  const probabilities = answer.probabilities
  const ranked = probabilities
    ? Object.values(probabilities).sort((left, right) => right - left)
    : []
  const topProbability = ranked[0]
  const secondProbability = ranked[1]
  const confidence = answer.confidence ?? undefined
  if (confidence !== undefined && confidence < 0.6) return undefined
  if (
    topProbability !== undefined &&
    secondProbability !== undefined &&
    topProbability - secondProbability < 0.15
  ) return undefined
  return { expert, choice: answer.choice, confidence, probabilities }
}
