import { performance } from 'node:perf_hooks'

// PERF-01 startup phase marks. Inactive unless GB_PERF_STARTUP_MARKS=1 (set by
// build/run-startup-perf.cjs); when inactive each call is one boolean check.
// Marks hold only fixed phase names and process-relative times, never user
// content. The startup harness reads them from the global below.
const enabled = process.env.GB_PERF_STARTUP_MARKS === '1'
type StartupMark = { name: string; at: number }
const marks: StartupMark[] | undefined = enabled ? [] : undefined
if (marks) {
  ;(globalThis as { __goodbuddyStartupMarks?: StartupMark[] }).__goodbuddyStartupMarks = marks
}

export function startupMark(name: string): void {
  if (marks) marks.push({ name, at: performance.now() })
}

// Takes a thunk so the span also covers the synchronous part of the operation
// (everything before its first await).
export function startupSpan<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!marks) return operation()
  startupMark(`${name}:start`)
  let started: Promise<T>
  try {
    started = operation()
  } catch (error) {
    startupMark(`${name}:end`)
    throw error
  }
  startupMark(`${name}:sync-end`)
  return started.finally(() => startupMark(`${name}:end`))
}
