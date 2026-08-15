export function formatCompactTokens(tokens: number): string {
  if (tokens < 1_000) {
    return tokens.toLocaleString()
  }
  const value = tokens / 1_000
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}K`
}
