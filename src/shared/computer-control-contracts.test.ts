import { describe, expect, it } from 'vitest'
import {
  computerControlActionSchema,
  computerControlApprovalResultSchema,
  computerControlObservationSchema,
  computerControlRuntimeCommandSchema
} from './computer-control-contracts'

const id = 'opaque_identifier_123456'

describe('computer control contracts', () => {
  it('accepts only the bounded semantic action vocabulary', () => {
    expect(
      computerControlActionSchema.parse({
        kind: 'replace_text',
        elementRef: id,
        text: 'hello'
      })
    ).toEqual({
      kind: 'replace_text',
      elementRef: id,
      text: 'hello'
    })

    for (const action of [
      { kind: 'click_at', x: 10, y: 20 },
      { kind: 'key_chord', keys: ['CTRL', 'A'] },
      { kind: 'launch_process', command: 'cmd.exe' },
      { kind: 'clipboard_write', text: 'secret' },
      { kind: 'open_file_picker', path: 'C:\\private.txt' }
    ]) {
      expect(computerControlActionSchema.safeParse(action).success).toBe(
        false
      )
    }
  })

  it('rejects unbounded and unknown command fields', () => {
    expect(
      computerControlRuntimeCommandSchema.safeParse({
        kind: 'act',
        commandId: id,
        leaseId: id,
        observationId: id,
        revision: 1,
        action: {
          kind: 'replace_text',
          elementRef: id,
          text: 'x'.repeat(4_097)
        }
      }).success
    ).toBe(false)

    expect(
      computerControlRuntimeCommandSchema.safeParse({
        kind: 'observe',
        commandId: id,
        leaseId: id,
        coordinates: [10, 20]
      }).success
    ).toBe(false)
  })

  it('bounds observations and excludes element values', () => {
    const element = {
      ref: id,
      role: 'textbox',
      name: 'Search',
      enabled: true,
      focused: false,
      risk: 'input',
      blocked: false
    }
    expect(
      computerControlObservationSchema.safeParse({
        observationId: id,
        leaseId: id,
        revision: 1,
        capturedAt: 1,
        windowTitle: 'Window',
        elements: Array.from({ length: 201 }, () => element)
      }).success
    ).toBe(false)
    expect(
      computerControlObservationSchema.safeParse({
        observationId: id,
        leaseId: id,
        revision: 1,
        capturedAt: 1,
        windowTitle: 'Window',
        elements: [{ ...element, value: 'password' }]
      }).success
    ).toBe(false)
  })

  it('allows approvals only once and never as a broad grant', () => {
    expect(
      computerControlApprovalResultSchema.parse({
        approvalId: id,
        decision: 'approve_once'
      }).decision
    ).toBe('approve_once')
    expect(
      computerControlApprovalResultSchema.safeParse({
        approvalId: id,
        decision: 'approve_session'
      }).success
    ).toBe(false)
  })
})
