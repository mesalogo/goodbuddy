export function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (
      (error as { code?: unknown }).code === 2 ||
      (error as { code?: unknown }).code === 'ENOENT'
    )
  )
}
