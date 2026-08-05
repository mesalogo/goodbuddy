import type { AssistantExpert } from '../../shared/assistant-contracts'

export type SubagentRouteCandidate = {
  expert: AssistantExpert
  score: number
  matches: number
}

export type SubagentRouteResult = SubagentRouteCandidate | undefined

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
}

function isEnglishWord(keyword: string): boolean {
  return /^[a-z][a-z0-9_-]*$/u.test(keyword)
}

function matchesKeyword(text: string, keyword: string): boolean {
  if (isEnglishWord(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'u')
      .test(text)
  }
  return text.includes(keyword)
}

function keywordScore(keyword: string): number {
  const hanCount = keyword.match(/\p{Script=Han}/gu)?.length ?? 0
  const englishTokens = keyword.match(/[a-z][a-z0-9_-]*/gu) ?? []
  return hanCount >= 2 || englishTokens.length >= 2 ? 6 : 4
}

export function routeSubagent(
  prompt: string,
  experts: readonly AssistantExpert[]
): SubagentRouteResult {
  const normalizedPrompt = normalize(prompt.slice(0, 8_000))
  const firstLine = normalize(prompt.split(/\r?\n/u, 1)[0]!.slice(0, 8_000))
  const candidates = experts.map((expert) => {
    let score = 0
    let matches = 0
    for (const rawKeyword of expert.routingKeywords) {
      const keyword = normalize(rawKeyword).trim()
      if (!keyword || !matchesKeyword(normalizedPrompt, keyword)) {
        continue
      }
      matches += 1
      score += keywordScore(keyword)
      if (matchesKeyword(firstLine, keyword)) {
        score += 2
      }
    }
    return { expert, score, matches }
  }).filter((candidate) => candidate.matches > 0)

  candidates.sort((left, right) =>
    right.score - left.score ||
    right.matches - left.matches ||
    left.expert.createdAt.localeCompare(right.expert.createdAt) ||
    left.expert.id.localeCompare(right.expert.id)
  )
  const best = candidates[0]
  if (
    !best ||
    best.score < 6 ||
    best.score - (candidates[1]?.score ?? 0) < 2
  ) {
    return undefined
  }
  return best
}
