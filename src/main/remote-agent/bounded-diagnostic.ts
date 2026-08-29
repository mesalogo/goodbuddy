export function boundedDiagnostic(
  value: string,
  maximumCharacters = 800
): string {
  let printable = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code !== 127)
    ) {
      printable += character
    }
  }
  return printable
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximumCharacters)
}
