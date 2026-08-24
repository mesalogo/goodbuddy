import { describe, expect, it } from 'vitest'
import {
  parseLinuxProcStat,
  parseSerializedLinuxRuntimeProcessIdentity,
  sameLinuxRuntimeProcessIdentity,
  serializeLinuxRuntimeProcessIdentity
} from './runtime-process-identity'

describe('Linux Runtime process identity', () => {
  it('parses proc stat command names containing spaces and parentheses', () => {
    const fields = ['S', '10', '20', '30', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '987654', '0']
    const parsed = parseLinuxProcStat(`123 (bwrap worker (one)) ${fields.join(' ')}`)
    expect(parsed).toMatchObject({
      pid: 123,
      command: 'bwrap worker (one)',
      parentPid: 10,
      processGroupId: 20,
      sessionId: 30,
      startTimeTicks: 987654n
    })
  })

  it('round trips the minimal owner identity and detects PID reuse', () => {
    const identity = {
      bootId: '11111111-1111-1111-1111-111111111111',
      pid: 42,
      startTimeTicks: 100n,
      processGroupId: 42,
      executablePath: '/usr/bin/bwrap'
    }
    expect(
      parseSerializedLinuxRuntimeProcessIdentity(
        serializeLinuxRuntimeProcessIdentity(identity)
      )
    ).toEqual(identity)
    expect(
      sameLinuxRuntimeProcessIdentity(identity, {
        ...identity,
        startTimeTicks: 101n
      })
    ).toBe(false)
  })
})
