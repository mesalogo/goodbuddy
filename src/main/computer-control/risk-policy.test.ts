import { describe, expect, it } from 'vitest'
import type { DriverElement } from './driver'
import {
  classifyComputerControlAction,
  maximumRisk
} from './risk-policy'

const identity = {}
const element: DriverElement = {
  nativeIdentity: identity,
  role: 'link',
  name: 'Next page',
  enabled: true,
  focused: true,
  targetKind: 'standard'
}

describe('computer control risk policy', () => {
  it('classifies semantic actions and lets classification only raise risk', () => {
    expect(
      classifyComputerControlAction(
        { kind: 'activate', elementRef: 'opaque_identifier_123456' },
        element
      )
    ).toBe('navigate')
    expect(
      maximumRisk('commit', 'observe')
    ).toBe('commit')
    expect(maximumRisk('input', 'commit')).toBe('commit')
  })

  it.each([
    'protected',
    'password',
    'otp',
    'payment',
    'account_security',
    'privilege',
    'os_permission'
  ] as const)('forbids %s targets', (targetKind) => {
    expect(
      classifyComputerControlAction(
        { kind: 'activate', elementRef: 'opaque_identifier_123456' },
        { ...element, targetKind }
      )
    ).toBe('forbidden')
  })
})
