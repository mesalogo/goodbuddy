const hanPattern = /\p{Script=Han}/u
const latinTokenPattern = /[\p{Letter}\p{Number}_.$/@-]+/gu
export const maximumContextPrefixCharacters = 512

export function contextualIndexText(
  content: string,
  contextPrefix?: unknown
): string {
  return `${
    typeof contextPrefix === 'string'
      ? contextPrefix.slice(0, maximumContextPrefixCharacters)
      : ''
  }${content}`
}

export function containsHanText(value: string): boolean {
  return hanPattern.test(value)
}

export function knowledgeRetrievalTerms(
  value: string,
  maximumTerms = Number.POSITIVE_INFINITY
): string[] {
  const normalized = value.normalize('NFKC').trim().toLowerCase()
  const tokens: string[] = [
    ...(normalized.match(latinTokenPattern) ?? [])
  ]
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = [...run]
    if (characters.length === 1) {
      tokens.push(characters[0]!)
      continue
    }
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.push(`${characters[index]}${characters[index + 1]}`)
    }
  }
  return [...new Set(tokens)].slice(0, maximumTerms)
}

export function createCjkSearchText(value: string): string {
  return knowledgeRetrievalTerms(value).join(' ')
}
