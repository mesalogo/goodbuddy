import { describe, expect, it } from 'vitest'
import {
  assertValidHeartbeatTimezone,
  computeNextHeartbeatRun
} from './heartbeat-recurrence'

describe('heartbeat recurrence', () => {
  it('keeps daily wall-clock time across daylight-saving changes', () => {
    expect(
      computeNextHeartbeatRun(
        { type: 'daily', localTime: '02:30' },
        'America/New_York',
        new Date('2026-03-07T12:00:00.000Z')
      ).toISOString()
    ).toBe('2026-03-08T07:00:00.000Z')

    expect(
      computeNextHeartbeatRun(
        { type: 'daily', localTime: '01:30' },
        'America/New_York',
        new Date('2026-11-01T05:31:00.000Z')
      ).toISOString()
    ).toBe('2026-11-01T06:30:00.000Z')
  })

  it('computes weekly recurrence using the configured local weekday', () => {
    expect(
      computeNextHeartbeatRun(
        { type: 'weekly', weekday: 1, localTime: '09:15' },
        'Asia/Tokyo',
        new Date('2026-07-31T00:00:00.000Z')
      ).toISOString()
    ).toBe('2026-08-03T00:15:00.000Z')
  })

  it('rejects invalid IANA timezones', () => {
    expect(() =>
      assertValidHeartbeatTimezone('Not/A_Timezone')
    ).toThrow('Invalid heartbeat timezone')
  })
})
