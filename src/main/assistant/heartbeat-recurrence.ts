import type { HeartbeatRecurrence } from '../../shared/assistant-contracts'

type LocalParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const weekdayIndexes: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
}

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short'
  })
}

function partsAt(
  value: Date,
  localFormatter: Intl.DateTimeFormat
): LocalParts {
  const values = Object.fromEntries(
    localFormatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  )
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdayIndexes[values.weekday!]!
  }
}

function compareLocal(
  left: Omit<LocalParts, 'weekday'>,
  right: Omit<LocalParts, 'weekday'>
): number {
  const leftValue = [
    left.year,
    left.month,
    left.day,
    left.hour,
    left.minute
  ]
  const rightValue = [
    right.year,
    right.month,
    right.day,
    right.hour,
    right.minute
  ]
  for (let index = 0; index < leftValue.length; index += 1) {
    if (leftValue[index] !== rightValue[index]) {
      return leftValue[index]! - rightValue[index]!
    }
  }
  return 0
}

function addLocalDays(
  parts: Pick<LocalParts, 'year' | 'month' | 'day'>,
  days: number
): Pick<LocalParts, 'year' | 'month' | 'day'> {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days)
  )
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  }
}

function resolveWallTime(
  target: Omit<LocalParts, 'weekday'>,
  timezone: string,
  after: Date
): Date | undefined {
  const localFormatter = formatter(timezone)
  const roughUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute
  )
  let firstAfterGap: Date | undefined
  let exactWallTimeExists = false
  for (
    let timestamp = roughUtc - 18 * 60 * 60_000;
    timestamp <= roughUtc + 18 * 60 * 60_000;
    timestamp += 60_000
  ) {
    const candidate = new Date(timestamp)
    const local = partsAt(candidate, localFormatter)
    const comparison = compareLocal(local, target)
    if (comparison === 0) {
      exactWallTimeExists = true
      if (timestamp > after.getTime()) {
        return candidate
      }
    }
    if (
      timestamp > after.getTime() &&
      !firstAfterGap &&
      local.year === target.year &&
      local.month === target.month &&
      local.day === target.day &&
      comparison > 0
    ) {
      firstAfterGap = candidate
    }
  }
  // During a spring-forward gap, run at the first valid local minute
  // after the requested wall time instead of drifting to another day.
  return exactWallTimeExists ? undefined : firstAfterGap
}

export function assertValidHeartbeatTimezone(timezone: string): void {
  try {
    formatter(timezone).format(new Date())
  } catch {
    throw new Error('Invalid heartbeat timezone')
  }
}

export function computeNextHeartbeatRun(
  recurrence: HeartbeatRecurrence,
  timezone: string,
  after: Date
): Date {
  assertValidHeartbeatTimezone(timezone)
  const localFormatter = formatter(timezone)
  const localAfter = partsAt(after, localFormatter)
  const [hour, minute] = recurrence.localTime.split(':').map(Number) as [
    number,
    number
  ]

  for (let offset = 0; offset <= 14; offset += 1) {
    const date = addLocalDays(localAfter, offset)
    if (recurrence.type === 'weekly') {
      const dateAtNoon = resolveWallTime(
        { ...date, hour: 12, minute: 0 },
        timezone,
        new Date(after.getTime() - 24 * 60 * 60_000)
      )
      if (
        !dateAtNoon ||
        partsAt(dateAtNoon, localFormatter).weekday !==
          recurrence.weekday
      ) {
        continue
      }
    }
    const candidate = resolveWallTime(
      { ...date, hour, minute },
      timezone,
      after
    )
    if (candidate) {
      return candidate
    }
  }
  throw new Error('Unable to compute next heartbeat run')
}
