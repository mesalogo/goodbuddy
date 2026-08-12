export function stripKnowledgeHighlightTags(value: string): string {
  return value.replace(/<\/?mark\b[^>]*>/giu, '')
}
