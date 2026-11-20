export function startScheduleRunLimit(minutes: number, onTimeout: () => void): () => void {
  if (!minutes) return () => undefined
  const timer = setTimeout(onTimeout, minutes * 60_000)
  return () => clearTimeout(timer)
}
