import { describe, expect, it, vi } from 'vitest'
import type {
  ComputerControlAction,
  ComputerControlApprovalRequest,
  ComputerControlApprovalResult,
  ComputerControlCommandResult,
  ComputerControlObservation
} from '../../shared/computer-control-contracts'
import { InMemoryComputerControlAudit } from './audit'
import type { ComputerControlApprovalProvider } from './approval'
import {
  ComputerControlBroker,
  type ComputerControlBrokerOptions
} from './broker'
import type {
  ComputerControlDriver,
  DriverElement,
  DriverObservation,
  DriverWindowIdentity,
  NativeElementIdentity
} from './driver'
import type { ComputerControlLeaseBinding } from './lease-store'

const binding: ComputerControlLeaseBinding = {
  taskId: 'task-1',
  conversationId: 'conversation-1',
  pid: 42,
  processStartTime: 100,
  windowIdentity: 'window-1'
}

const commandId = (suffix: string): string =>
  `command_identifier_${suffix.padStart(6, '0')}`

class FakeDriver implements ComputerControlDriver {
  readonly available = true
  readonly injections: ComputerControlAction[] = []
  releaseCount = 0
  activeInjections = 0
  maximumActiveInjections = 0
  foreground: DriverWindowIdentity = {
    pid: binding.pid,
    processStartTime: binding.processStartTime,
    windowIdentity: binding.windowIdentity
  }
  injectGate?: Promise<void>
  foregroundGate?: Promise<void>

  constructor(readonly elements: DriverElement[]) {}

  async observe(): Promise<DriverObservation> {
    await this.foregroundGate
    return {
      window: { ...this.foreground },
      windowTitle: 'Test window',
      elements: this.elements.map((element) => ({ ...element }))
    }
  }

  async getForegroundWindow(): Promise<DriverWindowIdentity> {
    await this.foregroundGate
    return { ...this.foreground }
  }

  async resolveElement(
    nativeIdentity: NativeElementIdentity
  ): Promise<DriverElement | undefined> {
    const element = this.elements.find(
      (candidate) => candidate.nativeIdentity === nativeIdentity
    )
    return element ? { ...element } : undefined
  }

  async focusElement(
    nativeIdentity: NativeElementIdentity
  ): Promise<boolean> {
    const element = this.elements.find(
      (candidate) => candidate.nativeIdentity === nativeIdentity
    )
    if (!element || !element.enabled) {
      return false
    }
    element.focused = true
    return true
  }

  async inject(
    nativeIdentity: NativeElementIdentity,
    action: ComputerControlAction
  ): Promise<void> {
    void nativeIdentity
    this.injections.push(action)
    this.activeInjections += 1
    this.maximumActiveInjections = Math.max(
      this.maximumActiveInjections,
      this.activeInjections
    )
    try {
      await this.injectGate
    } finally {
      this.activeInjections -= 1
    }
  }

  async releaseInjectedInput(): Promise<void> {
    this.releaseCount += 1
  }
}

class FakeApproval implements ComputerControlApprovalProvider {
  readonly requests: ComputerControlApprovalRequest[] = []
  handler?: (
    request: ComputerControlApprovalRequest,
    signal: AbortSignal
  ) => Promise<ComputerControlApprovalResult>

  async request(
    request: ComputerControlApprovalRequest,
    signal: AbortSignal
  ): Promise<ComputerControlApprovalResult> {
    this.requests.push(request)
    if (this.handler) {
      return this.handler(request, signal)
    }
    return {
      approvalId: request.approvalId,
      decision: 'approve_once'
    }
  }
}

const makeElement = (
  role: DriverElement['role'],
  targetKind: DriverElement['targetKind'] = 'standard',
  name = 'Target'
): DriverElement => ({
  nativeIdentity: {},
  role,
  name,
  enabled: true,
  focused: false,
  targetKind
})

const makeHarness = (
  elements: DriverElement[],
  options: {
    now?: () => number
    driverDeadlineMs?: number
    approvalDeadlineMs?: number
    audit?: ComputerControlBrokerOptions['audit']
    fallbackAudit?: ComputerControlBrokerOptions['fallbackAudit']
  } = {}
) => {
  let idSequence = 0
  const driver = new FakeDriver(elements)
  const approval = new FakeApproval()
  const audit = new InMemoryComputerControlAudit()
  const broker = new ComputerControlBroker({
    driver,
    approval,
    audit: options.audit ?? audit,
    fallbackAudit: options.fallbackAudit,
    now: options.now,
    driverDeadlineMs: options.driverDeadlineMs,
    approvalDeadlineMs: options.approvalDeadlineMs,
    createId: () =>
      `generated_identifier_${String(++idSequence).padStart(6, '0')}`
  })
  return { broker, driver, approval, audit }
}

const observe = async (
  broker: ComputerControlBroker,
  leaseId: string,
  suffix: string,
  context = binding
): Promise<ComputerControlObservation> => {
  const result = await broker.execute(
    {
      kind: 'observe',
      commandId: commandId(suffix),
      leaseId
    },
    context,
    new AbortController().signal
  )
  if (result.status !== 'observed') {
    throw new Error(`Observation failed: ${JSON.stringify(result)}`)
  }
  return result.observation
}

const expectErrorCode = (
  result: ComputerControlCommandResult,
  code: string
): void => {
  expect(result).toMatchObject({
    status: 'error',
    error: { code }
  })
}

describe('ComputerControlBroker', () => {
  it('rejects stale and consumed refs while preserving command idempotency', async () => {
    let now = 1_000
    const { broker, driver } = makeHarness([makeElement('link')], {
      now: () => now
    })
    const lease = broker.createLease(binding)
    const staleObservation = await observe(
      broker,
      lease.leaseId,
      'stale-observe'
    )
    now += 3_000
    const stale = await broker.execute(
      {
        kind: 'act',
        commandId: commandId('stale-act'),
        leaseId: lease.leaseId,
        observationId: staleObservation.observationId,
        revision: staleObservation.revision,
        action: {
          kind: 'activate',
          elementRef: staleObservation.elements[0]?.ref
        }
      },
      binding,
      new AbortController().signal
    )
    expectErrorCode(stale, 'observation_stale')

    const fresh = await observe(
      broker,
      lease.leaseId,
      'fresh-observe'
    )
    const action = {
      kind: 'act' as const,
      commandId: commandId('fresh-act'),
      leaseId: lease.leaseId,
      observationId: fresh.observationId,
      revision: fresh.revision,
      action: {
        kind: 'activate' as const,
        elementRef: fresh.elements[0]?.ref
      }
    }
    const first = await broker.execute(
      action,
      binding,
      new AbortController().signal
    )
    expect(first.status).toBe('completed')
    await expect(
      broker.execute(
        action,
        binding,
        new AbortController().signal
      )
    ).resolves.toEqual(first)
    expect(driver.injections).toHaveLength(1)

    const consumed = await broker.execute(
      { ...action, commandId: commandId('consumed') },
      binding,
      new AbortController().signal
    )
    expectErrorCode(consumed, 'observation_consumed')
  })

  it('rejects command ID reuse with different content', async () => {
    const { broker } = makeHarness([makeElement('link')])
    const lease = broker.createLease(binding)
    await observe(broker, lease.leaseId, 'same-id')
    const conflict = await broker.execute(
      {
        kind: 'observe',
        commandId: commandId('same-id'),
        leaseId: 'different_lease_identifier'
      },
      binding,
      new AbortController().signal
    )
    expectErrorCode(conflict, 'command_id_conflict')
  })

  it.each([
    'protected',
    'password',
    'otp',
    'payment',
    'account_security',
    'privilege',
    'os_permission'
  ] as const)('forbids %s targets before approval or injection', async (targetKind) => {
    const { broker, driver, approval } = makeHarness([
      makeElement('textbox', targetKind)
    ])
    const lease = broker.createLease(binding)
    const observation = await observe(
      broker,
      lease.leaseId,
      `forbidden-${targetKind}`
    )
    expect(observation.elements[0]).toMatchObject({
      risk: 'forbidden',
      blocked: true
    })
    const result = await broker.execute(
      {
        kind: 'act',
        commandId: commandId(`act-${targetKind}`),
        leaseId: lease.leaseId,
        observationId: observation.observationId,
        revision: observation.revision,
        action: {
          kind: 'replace_text',
          elementRef: observation.elements[0]?.ref,
          text: 'never injected'
        }
      },
      binding,
      new AbortController().signal
    )
    expectErrorCode(result, 'forbidden')
    expect(approval.requests).toHaveLength(0)
    expect(driver.injections).toHaveLength(0)
  })

  it('requires a distinct once approval for every input and commit', async () => {
    const { broker, approval } = makeHarness([
      makeElement('textbox', 'standard', 'Editor'),
      makeElement('button', 'standard', 'Submit')
    ])
    const lease = broker.createLease(binding)
    const inputObservation = await observe(
      broker,
      lease.leaseId,
      'input-observe'
    )
    const input = await broker.execute(
      {
        kind: 'act',
        commandId: commandId('input-act'),
        leaseId: lease.leaseId,
        observationId: inputObservation.observationId,
        revision: inputObservation.revision,
        action: {
          kind: 'replace_text',
          elementRef: inputObservation.elements[0]?.ref,
          text: 'hello'
        }
      },
      binding,
      new AbortController().signal
    )
    expect(input).toMatchObject({ status: 'completed', risk: 'input' })

    const commitObservation = await observe(
      broker,
      lease.leaseId,
      'commit-observe'
    )
    const commit = await broker.execute(
      {
        kind: 'act',
        commandId: commandId('commit-act'),
        leaseId: lease.leaseId,
        observationId: commitObservation.observationId,
        revision: commitObservation.revision,
        action: {
          kind: 'activate',
          elementRef: commitObservation.elements[1]?.ref
        }
      },
      binding,
      new AbortController().signal
    )
    expect(commit).toMatchObject({
      status: 'completed',
      risk: 'commit'
    })
    expect(approval.requests.map((request) => request.risk)).toEqual([
      'input',
      'commit'
    ])
    expect(
      approval.requests.every(
        (request) => !('text' in request)
      )
    ).toBe(true)
  })

  it('handles approval denial, timeout, and cancellation fail-closed', async () => {
    vi.useFakeTimers()
    try {
      const deniedHarness = makeHarness([makeElement('textbox')])
      deniedHarness.approval.handler = async (request) => ({
        approvalId: request.approvalId,
        decision: 'deny'
      })
      const deniedLease = deniedHarness.broker.createLease(binding)
      const deniedObservation = await observe(
        deniedHarness.broker,
        deniedLease.leaseId,
        'denied-observe'
      )
      const denied = await deniedHarness.broker.execute(
        {
          kind: 'act',
          commandId: commandId('denied-act'),
          leaseId: deniedLease.leaseId,
          observationId: deniedObservation.observationId,
          revision: deniedObservation.revision,
          action: {
            kind: 'replace_text',
            elementRef: deniedObservation.elements[0]?.ref,
            text: 'denied'
          }
        },
        binding,
        new AbortController().signal
      )
      expectErrorCode(denied, 'approval_denied')

      const timeoutHarness = makeHarness([makeElement('textbox')], {
        approvalDeadlineMs: 20
      })
      timeoutHarness.approval.handler = () =>
        new Promise(() => undefined)
      const timeoutLease = timeoutHarness.broker.createLease(binding)
      const timeoutObservation = await observe(
        timeoutHarness.broker,
        timeoutLease.leaseId,
        'timeout-observe'
      )
      const timeoutPromise = timeoutHarness.broker.execute(
        {
          kind: 'act',
          commandId: commandId('timeout-act'),
          leaseId: timeoutLease.leaseId,
          observationId: timeoutObservation.observationId,
          revision: timeoutObservation.revision,
          action: {
            kind: 'replace_text',
            elementRef: timeoutObservation.elements[0]?.ref,
            text: 'timeout'
          }
        },
        binding,
        new AbortController().signal
      )
      await vi.advanceTimersByTimeAsync(20)
      expectErrorCode(await timeoutPromise, 'approval_timeout')

      const cancelledHarness = makeHarness([makeElement('textbox')])
      cancelledHarness.approval.handler = () =>
        new Promise(() => undefined)
      const cancelledLease =
        cancelledHarness.broker.createLease(binding)
      const cancelledObservation = await observe(
        cancelledHarness.broker,
        cancelledLease.leaseId,
        'cancel-observe'
      )
      const controller = new AbortController()
      const cancelledPromise = cancelledHarness.broker.execute(
        {
          kind: 'act',
          commandId: commandId('cancel-act'),
          leaseId: cancelledLease.leaseId,
          observationId: cancelledObservation.observationId,
          revision: cancelledObservation.revision,
          action: {
            kind: 'replace_text',
            elementRef: cancelledObservation.elements[0]?.ref,
            text: 'cancelled'
          }
        },
        binding,
        controller.signal
      )
      await vi.waitFor(() => {
        expect(cancelledHarness.approval.requests).toHaveLength(1)
      })
      controller.abort()
      expectErrorCode(await cancelledPromise, 'cancelled')
      expect(
        cancelledHarness.broker.leases.peek(cancelledLease.leaseId)
      ).toBeUndefined()
      expect(cancelledHarness.driver.releaseCount).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports outcome_unknown when cancellation races injection', async () => {
    let releaseInjection: (() => void) | undefined
    const { broker, driver } = makeHarness([makeElement('link')])
    driver.injectGate = new Promise<void>((resolve) => {
      releaseInjection = resolve
    })
    const lease = broker.createLease(binding)
    const observation = await observe(
      broker,
      lease.leaseId,
      'race-observe'
    )
    const controller = new AbortController()
    const resultPromise = broker.execute(
      {
        kind: 'act',
        commandId: commandId('race-act'),
        leaseId: lease.leaseId,
        observationId: observation.observationId,
        revision: observation.revision,
        action: {
          kind: 'activate',
          elementRef: observation.elements[0]?.ref
        }
      },
      binding,
      controller.signal
    )
    await vi.waitFor(() => {
      expect(driver.injections).toHaveLength(1)
    })
    controller.abort()
    expectErrorCode(await resultPromise, 'outcome_unknown')
    releaseInjection?.()
    expect(driver.releaseCount).toBeGreaterThan(0)
  })

  it('caches outcome_unknown when injection times out before late completion', async () => {
    vi.useFakeTimers()
    try {
      let releaseInjection: (() => void) | undefined
      const { broker, driver, audit } = makeHarness(
        [makeElement('link')],
        { driverDeadlineMs: 20 }
      )
      const lease = broker.createLease(binding)
      const observation = await observe(
        broker,
        lease.leaseId,
        'injection-timeout-observe'
      )
      driver.injectGate = new Promise<void>((resolve) => {
        releaseInjection = resolve
      })
      const command = {
        kind: 'act' as const,
        commandId: commandId('injection-timeout-act'),
        leaseId: lease.leaseId,
        observationId: observation.observationId,
        revision: observation.revision,
        action: {
          kind: 'activate' as const,
          elementRef: observation.elements[0]?.ref
        }
      }

      const firstPromise = broker.execute(
        command,
        binding,
        new AbortController().signal
      )
      await vi.waitFor(() => {
        expect(driver.injections).toHaveLength(1)
      })
      await vi.advanceTimersByTimeAsync(20)
      const first = await firstPromise
      expectErrorCode(first, 'outcome_unknown')

      await expect(
        broker.execute(
          command,
          binding,
          new AbortController().signal
        )
      ).resolves.toEqual(first)
      expect(driver.injections).toHaveLength(1)
      expect(audit.entries().at(-1)).toMatchObject({
        outcome: 'outcome_unknown',
        errorCode: 'outcome_unknown'
      })

      releaseInjection?.()
      await Promise.resolve()
      expect(driver.injections).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats an uncertain injection driver failure as outcome_unknown', async () => {
    const { broker, driver, audit } = makeHarness([makeElement('link')])
    const lease = broker.createLease(binding)
    const observation = await observe(
      broker,
      lease.leaseId,
      'injection-failure-observe'
    )
    driver.inject = vi.fn(async () => {
      throw new Error('driver disconnected during injection')
    })
    const command = {
      kind: 'act' as const,
      commandId: commandId('injection-failure-act'),
      leaseId: lease.leaseId,
      observationId: observation.observationId,
      revision: observation.revision,
      action: {
        kind: 'activate' as const,
        elementRef: observation.elements[0]?.ref
      }
    }

    const first = await broker.execute(
      command,
      binding,
      new AbortController().signal
    )
    expectErrorCode(first, 'outcome_unknown')
    await expect(
      broker.execute(
        command,
        binding,
        new AbortController().signal
      )
    ).resolves.toEqual(first)
    expect(driver.inject).toHaveBeenCalledOnce()
    expect(audit.entries().at(-1)).toMatchObject({
      outcome: 'outcome_unknown',
      errorCode: 'outcome_unknown'
    })
  })

  it('isolates throwing primary and fallback audit sinks from cached results', async () => {
    const primaryWrite = vi.fn(async () => {
      throw new Error('primary audit unavailable')
    })
    const fallbackWrite = vi.fn(async () => {
      throw new Error('fallback audit unavailable')
    })
    const { broker, driver } = makeHarness([makeElement('link')], {
      audit: { write: primaryWrite },
      fallbackAudit: { write: fallbackWrite }
    })
    const lease = broker.createLease(binding)
    const observation = await observe(
      broker,
      lease.leaseId,
      'throwing-audit-observe'
    )
    const command = {
      kind: 'act' as const,
      commandId: commandId('throwing-audit-act'),
      leaseId: lease.leaseId,
      observationId: observation.observationId,
      revision: observation.revision,
      action: {
        kind: 'activate' as const,
        elementRef: observation.elements[0]?.ref
      }
    }

    const first = await broker.execute(
      command,
      binding,
      new AbortController().signal
    )
    expect(first).toMatchObject({ status: 'completed' })
    await expect(
      broker.execute(
        command,
        binding,
        new AbortController().signal
      )
    ).resolves.toEqual(first)
    expect(driver.injections).toHaveLength(1)
    expect(primaryWrite).toHaveBeenCalledTimes(2)
    expect(fallbackWrite).toHaveBeenCalledTimes(2)
  })

  it('isolates throwing audit sinks while caching a failed result', async () => {
    const primaryWrite = vi.fn(async () => {
      throw new Error('primary audit unavailable')
    })
    const fallbackWrite = vi.fn(async () => {
      throw new Error('fallback audit unavailable')
    })
    const { broker, driver } = makeHarness(
      [makeElement('textbox', 'protected')],
      {
        audit: { write: primaryWrite },
        fallbackAudit: { write: fallbackWrite }
      }
    )
    const lease = broker.createLease(binding)
    const observation = await observe(
      broker,
      lease.leaseId,
      'throwing-failure-audit-observe'
    )
    const command = {
      kind: 'act' as const,
      commandId: commandId('throwing-failure-audit-act'),
      leaseId: lease.leaseId,
      observationId: observation.observationId,
      revision: observation.revision,
      action: {
        kind: 'replace_text' as const,
        elementRef: observation.elements[0]?.ref,
        text: 'not injected'
      }
    }

    const first = await broker.execute(
      command,
      binding,
      new AbortController().signal
    )
    expectErrorCode(first, 'forbidden')
    await expect(
      broker.execute(
        command,
        binding,
        new AbortController().signal
      )
    ).resolves.toEqual(first)
    expect(driver.injections).toHaveLength(0)
    expect(primaryWrite).toHaveBeenCalledTimes(2)
    expect(fallbackWrite).toHaveBeenCalledTimes(2)
  })

  it('serializes actions for leases belonging to the same task', async () => {
    let releaseFirst: (() => void) | undefined
    const { broker, driver } = makeHarness([makeElement('link')])
    driver.injectGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstLease = broker.createLease(binding)
    const secondLease = broker.createLease(binding)
    const firstObservation = await observe(
      broker,
      firstLease.leaseId,
      'serial-observe-1'
    )
    const secondObservation = await observe(
      broker,
      secondLease.leaseId,
      'serial-observe-2'
    )
    const actionFor = (
      leaseId: string,
      observation: ComputerControlObservation,
      suffix: string
    ) =>
      broker.execute(
        {
          kind: 'act',
          commandId: commandId(suffix),
          leaseId,
          observationId: observation.observationId,
          revision: observation.revision,
          action: {
            kind: 'activate',
            elementRef: observation.elements[0]?.ref
          }
        },
        binding,
        new AbortController().signal
      )
    const first = actionFor(
      firstLease.leaseId,
      firstObservation,
      'serial-act-1'
    )
    await vi.waitFor(() => {
      expect(driver.injections).toHaveLength(1)
    })
    const second = actionFor(
      secondLease.leaseId,
      secondObservation,
      'serial-act-2'
    )
    await Promise.resolve()
    expect(driver.injections).toHaveLength(1)
    releaseFirst?.()
    driver.injectGate = undefined
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'completed' })
    ])
    expect(driver.maximumActiveInjections).toBe(1)
  })

  it('revokes on foreground identity mismatch and enforces driver deadlines', async () => {
    vi.useFakeTimers()
    try {
      const mismatchHarness = makeHarness([makeElement('link')])
      const mismatchLease =
        mismatchHarness.broker.createLease(binding)
      const observation = await observe(
        mismatchHarness.broker,
        mismatchLease.leaseId,
        'mismatch-observe'
      )
      mismatchHarness.driver.foreground = {
        ...mismatchHarness.driver.foreground,
        pid: 99
      }
      const mismatch = await mismatchHarness.broker.execute(
        {
          kind: 'act',
          commandId: commandId('mismatch-act'),
          leaseId: mismatchLease.leaseId,
          observationId: observation.observationId,
          revision: observation.revision,
          action: {
            kind: 'activate',
            elementRef: observation.elements[0]?.ref
          }
        },
        binding,
        new AbortController().signal
      )
      expectErrorCode(mismatch, 'window_not_foreground')
      expect(
        mismatchHarness.broker.leases.peek(mismatchLease.leaseId)
      ).toBeUndefined()

      const timeoutHarness = makeHarness([makeElement('link')], {
        driverDeadlineMs: 20
      })
      timeoutHarness.driver.foregroundGate = new Promise(
        () => undefined
      )
      const timeoutLease = timeoutHarness.broker.createLease(binding)
      const timeoutPromise = timeoutHarness.broker.execute(
        {
          kind: 'observe',
          commandId: commandId('driver-timeout'),
          leaseId: timeoutLease.leaseId
        },
        binding,
        new AbortController().signal
      )
      await vi.advanceTimersByTimeAsync(20)
      expectErrorCode(await timeoutPromise, 'driver_timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('audits typed text only as length and digest', async () => {
    const { broker, approval, audit } = makeHarness([
      makeElement('textbox', 'standard', 'Editor')
    ])
    const lease = broker.createLease(binding)
    const observation = await observe(
      broker,
      lease.leaseId,
      'audit-observe'
    )
    const secretText = 'private typed content'
    const result = await broker.execute(
      {
        kind: 'act',
        commandId: commandId('audit-act'),
        leaseId: lease.leaseId,
        observationId: observation.observationId,
        revision: observation.revision,
        action: {
          kind: 'replace_text',
          elementRef: observation.elements[0]?.ref,
          text: secretText
        }
      },
      binding,
      new AbortController().signal
    )
    expect(result.status).toBe('completed')
    const entry = audit.entries().at(-1)
    expect(entry).toMatchObject({
      action: 'replace_text',
      textLength: secretText.length
    })
    expect(entry?.textDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(audit.entries())).not.toContain(secretText)
    expect(JSON.stringify(approval.requests)).not.toContain(secretText)
  })
})
