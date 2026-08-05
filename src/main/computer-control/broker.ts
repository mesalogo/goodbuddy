import { randomUUID } from 'node:crypto'
import {
  computerControlApprovalResultSchema,
  computerControlRuntimeCommandSchema,
  type ComputerControlAction,
  type ComputerControlCommandResult,
  type ComputerControlRisk,
  type ComputerControlRuntimeCommand
} from '../../shared/computer-control-contracts'
import {
  digestComputerControlText,
  type ComputerControlAuditEvent,
  type ComputerControlAuditSink
} from './audit'
import {
  COMPUTER_CONTROL_APPROVAL_DEADLINE_MS,
  type ComputerControlApprovalProvider
} from './approval'
import { runWithDeadline } from './deadline'
import {
  COMPUTER_CONTROL_DRIVER_DEADLINE_MS,
  type ComputerControlDriver,
  type DriverElement,
  type DriverWindowIdentity
} from './driver'
import {
  cancellationFailure,
  ComputerControlFailure
} from './errors'
import {
  ComputerControlLeaseStore,
  type ComputerControlLease,
  type ComputerControlLeaseBinding
} from './lease-store'
import { ComputerControlPerceptionStore } from './perception-store'
import {
  classifyComputerControlAction,
  maximumRisk
} from './risk-policy'

const INVALID_COMMAND_ID = 'invalid_command_000000'
const MAX_CACHED_COMMANDS = 1_000

type BrokerExecutionContext = ComputerControlLeaseBinding

type InFlightCommand = {
  fingerprint: string
  result: Promise<ComputerControlCommandResult>
}

export type ComputerControlBrokerOptions = {
  driver: ComputerControlDriver
  approval: ComputerControlApprovalProvider
  audit: ComputerControlAuditSink
  fallbackAudit?: ComputerControlAuditSink
  leases?: ComputerControlLeaseStore
  perceptions?: ComputerControlPerceptionStore
  driverDeadlineMs?: number
  approvalDeadlineMs?: number
  classify?: (
    action: ComputerControlAction,
    element: DriverElement
  ) => ComputerControlRisk
  now?: () => number
  createId?: () => string
}

export class ComputerControlBroker {
  readonly leases: ComputerControlLeaseStore
  readonly perceptions: ComputerControlPerceptionStore

  private readonly driver: ComputerControlDriver
  private readonly approval: ComputerControlApprovalProvider
  private readonly audit: ComputerControlAuditSink
  private readonly fallbackAudit: ComputerControlAuditSink | undefined
  private readonly driverDeadlineMs: number
  private readonly approvalDeadlineMs: number
  private readonly classify?: ComputerControlBrokerOptions['classify']
  private readonly now: () => number
  private readonly createId: () => string
  private readonly queues = new Map<string, Promise<void>>()
  private readonly completed = new Map<
    string,
    { fingerprint: string; result: ComputerControlCommandResult }
  >()
  private readonly inFlight = new Map<string, InFlightCommand>()

  constructor(options: ComputerControlBrokerOptions) {
    this.driver = options.driver
    this.approval = options.approval
    this.audit = options.audit
    this.fallbackAudit = options.fallbackAudit
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.leases =
      options.leases ??
      new ComputerControlLeaseStore(this.now, this.createId)
    this.perceptions =
      options.perceptions ??
      new ComputerControlPerceptionStore(this.now, this.createId)
    this.driverDeadlineMs =
      options.driverDeadlineMs ?? COMPUTER_CONTROL_DRIVER_DEADLINE_MS
    this.approvalDeadlineMs =
      options.approvalDeadlineMs ??
      COMPUTER_CONTROL_APPROVAL_DEADLINE_MS
    this.classify = options.classify
  }

  createLease(
    binding: ComputerControlLeaseBinding
  ): ComputerControlLease {
    return this.leases.create(binding)
  }

  revoke(leaseId: string): void {
    this.leases.revoke(leaseId)
    this.perceptions.revokeLease(leaseId)
    void this.releaseInjectedInput()
  }

  revokeTask(taskId: string): void {
    const revokedLeaseIds = this.leases.revokeTask(taskId)
    for (const leaseId of revokedLeaseIds) {
      this.perceptions.revokeLease(leaseId)
    }
    void this.releaseInjectedInput()
  }

  async execute(
    untrustedCommand: unknown,
    context: BrokerExecutionContext,
    signal: AbortSignal
  ): Promise<ComputerControlCommandResult> {
    const parsed =
      computerControlRuntimeCommandSchema.safeParse(untrustedCommand)
    if (!parsed.success) {
      return this.errorResult(
        INVALID_COMMAND_ID,
        new ComputerControlFailure(
          'invalid_request',
          'Invalid computer control command'
        )
      )
    }
    const command = parsed.data
    const fingerprint = JSON.stringify({ command, context })

    const cached = this.completed.get(command.commandId)
    if (cached) {
      return cached.fingerprint === fingerprint
        ? cached.result
        : this.errorResult(
            command.commandId,
            new ComputerControlFailure(
              'command_id_conflict',
              'Computer control command ID was reused'
            )
          )
    }
    const active = this.inFlight.get(command.commandId)
    if (active) {
      return active.fingerprint === fingerprint
        ? active.result
        : this.errorResult(
            command.commandId,
            new ComputerControlFailure(
              'command_id_conflict',
              'Computer control command ID was reused'
            )
          )
    }

    const result = this.serialize(context.taskId, () =>
      this.executeSerialized(command, context, signal)
    )
    this.inFlight.set(command.commandId, { fingerprint, result })
    result
      .then((settled) => {
        this.completed.set(command.commandId, {
          fingerprint,
          result: settled
        })
        while (this.completed.size > MAX_CACHED_COMMANDS) {
          const oldest = this.completed.keys().next().value
          if (oldest === undefined) {
            break
          }
          this.completed.delete(oldest)
        }
      })
      .finally(() => {
        this.inFlight.delete(command.commandId)
      })
      .catch(() => {
        // executeSerialized always returns a contract result.
      })
    return result
  }

  private async executeSerialized(
    command: ComputerControlRuntimeCommand,
    context: BrokerExecutionContext,
    signal: AbortSignal
  ): Promise<ComputerControlCommandResult> {
    let injectionStarted = false
    const cancel = (): void => {
      this.revoke(command.leaseId)
    }
    signal.addEventListener('abort', cancel, { once: true })

    try {
      if (signal.aborted) {
        cancel()
        throw cancellationFailure()
      }
      const lease = this.leases.validate(command.leaseId, context)
      if (!this.driver.available) {
        throw new ComputerControlFailure(
          'driver_unavailable',
          'Computer control driver is unavailable'
        )
      }

      if (command.kind === 'observe') {
        const result = await this.observe(command, lease, signal)
        await this.writeAudit({
          ...this.auditBase(command, lease),
          action: 'observe',
          risk: 'observe',
          outcome: 'completed'
        })
        return result
      }

      const result = await this.act(
        command,
        lease,
        signal,
        () => {
          injectionStarted = true
        }
      )
      return result
    } catch (error) {
      const failure =
        signal.aborted && injectionStarted
          ? new ComputerControlFailure(
              'outcome_unknown',
              'Cancellation raced input injection'
            )
          : this.normalizeFailure(error)
      if (command.kind === 'act') {
        await this.writeFailureAudit(command, context, failure)
      }
      return this.errorResult(command.commandId, failure)
    } finally {
      signal.removeEventListener('abort', cancel)
      if (signal.aborted) {
        await this.releaseInjectedInput()
      }
    }
  }

  private async observe(
    command: Extract<ComputerControlRuntimeCommand, { kind: 'observe' }>,
    lease: ComputerControlLease,
    signal: AbortSignal
  ): Promise<ComputerControlCommandResult> {
    const observation = await this.driverCall(
      (driverSignal) => this.driver.observe(driverSignal),
      signal
    )
    this.assertWindowMatches(lease, observation.window)
    const contract = this.perceptions.create(
      lease.leaseId,
      observation,
      (element) =>
        this.classifyRisk(
          {
            kind: 'activate',
            elementRef: 'opaque_identifier_placeholder'
          },
          element
        )
    )
    return {
      status: 'observed',
      commandId: command.commandId,
      observation: contract
    }
  }

  private async act(
    command: Extract<ComputerControlRuntimeCommand, { kind: 'act' }>,
    lease: ComputerControlLease,
    signal: AbortSignal,
    markInjectionStarted: () => void
  ): Promise<ComputerControlCommandResult> {
    const stored = this.perceptions.resolve(
      lease.leaseId,
      command.observationId,
      command.revision,
      command.action.elementRef
    )
    let resolved = await this.validateTarget(
      lease,
      stored.driverElement,
      stored.nativeIdentity,
      signal
    )
    let risk = this.classifyRisk(command.action, resolved)
    if (risk === 'forbidden') {
      throw new ComputerControlFailure(
        'forbidden',
        'Computer control target is protected'
      )
    }

    if (risk === 'input' || risk === 'commit') {
      await this.requestApproval(command, lease, resolved, risk, signal)
    }

    resolved = await this.validateTarget(
      lease,
      stored.driverElement,
      stored.nativeIdentity,
      signal
    )
    const finalRisk = this.classifyRisk(command.action, resolved)
    if (finalRisk === 'forbidden') {
      throw new ComputerControlFailure(
        'forbidden',
        'Computer control target is protected'
      )
    }
    const elevatedRisk = maximumRisk(risk, finalRisk)
    if (elevatedRisk !== risk) {
      if (elevatedRisk === 'input' || elevatedRisk === 'commit') {
        await this.requestApproval(
          command,
          lease,
          resolved,
          elevatedRisk,
          signal
        )
        resolved = await this.validateTarget(
          lease,
          stored.driverElement,
          stored.nativeIdentity,
          signal
        )
      }
      risk = elevatedRisk
    }
    const injectionRisk = this.classifyRisk(command.action, resolved)
    if (injectionRisk === 'forbidden') {
      throw new ComputerControlFailure(
        'forbidden',
        'Computer control target is protected'
      )
    }
    const finalElevatedRisk = maximumRisk(risk, injectionRisk)
    if (finalElevatedRisk !== risk) {
      throw new ComputerControlFailure(
        'approval_denied',
        'Computer control risk changed after approval'
      )
    }
    risk = finalElevatedRisk

    this.perceptions.consume(command.observationId)
    markInjectionStarted()
    try {
      await this.driverCall(
        (driverSignal) =>
          this.driver.inject(
            stored.nativeIdentity,
            command.action,
            driverSignal
          ),
        signal
      )
    } catch {
      throw new ComputerControlFailure(
        'outcome_unknown',
        signal.aborted
          ? 'Cancellation raced input injection'
          : 'Input injection outcome could not be verified'
      )
    }
    if (signal.aborted) {
      throw new ComputerControlFailure(
        'outcome_unknown',
        'Cancellation raced input injection'
      )
    }

    await this.writeAudit({
      ...this.auditBase(command, lease),
      action: command.action.kind,
      risk,
      outcome: 'completed',
      ...this.redactedTextMetadata(command.action)
    })
    if (risk === 'forbidden') {
      throw new ComputerControlFailure(
        'forbidden',
        'Computer control target is protected'
      )
    }
    return {
      status: 'completed',
      commandId: command.commandId,
      risk
    }
  }

  private async requestApproval(
    command: Extract<ComputerControlRuntimeCommand, { kind: 'act' }>,
    lease: ComputerControlLease,
    element: DriverElement,
    risk: 'input' | 'commit',
    signal: AbortSignal
  ): Promise<void> {
    const approvalId = this.createId()
    const response = await runWithDeadline(
      (approvalSignal) =>
        this.approval.request(
          {
            approvalId,
            leaseId: lease.leaseId,
            commandId: command.commandId,
            risk,
            action:
              command.action.kind === 'scroll'
                ? 'activate'
                : command.action.kind,
            targetName:
              this.boundedDisplayText(element.name, 256) ||
              element.role,
            ...(command.action.kind === 'replace_text'
              ? { textLength: command.action.text.length }
              : {})
          },
          approvalSignal
        ),
      signal,
      this.approvalDeadlineMs,
      'approval_timeout'
    )
    const parsed = computerControlApprovalResultSchema.safeParse(response)
    if (!parsed.success || parsed.data.approvalId !== approvalId) {
      throw new ComputerControlFailure(
        'approval_denied',
        'Computer control approval response was invalid'
      )
    }
    if (parsed.data.decision !== 'approve_once') {
      throw new ComputerControlFailure(
        'approval_denied',
        'Computer control approval was denied'
      )
    }
  }

  private async validateTarget(
    lease: ComputerControlLease,
    original: DriverElement,
    nativeIdentity: DriverElement['nativeIdentity'],
    signal: AbortSignal
  ): Promise<DriverElement> {
    const foreground = await this.driverCall(
      (driverSignal) =>
        this.driver.getForegroundWindow(driverSignal),
      signal
    )
    this.assertWindowMatches(lease, foreground)
    const resolved = await this.driverCall(
      (driverSignal) =>
        this.driver.resolveElement(nativeIdentity, driverSignal),
      signal
    )
    this.assertElementIdentity(original, resolved, nativeIdentity)
    if (!resolved.enabled) {
      throw new ComputerControlFailure(
        'focus_failed',
        'Computer control element is disabled'
      )
    }
    const focused = await this.driverCall(
      (driverSignal) =>
        this.driver.focusElement(nativeIdentity, driverSignal),
      signal
    )
    if (!focused) {
      throw new ComputerControlFailure(
        'focus_failed',
        'Computer control element could not be focused',
        true
      )
    }
    const verified = await this.driverCall(
      (driverSignal) =>
        this.driver.resolveElement(nativeIdentity, driverSignal),
      signal
    )
    this.assertElementIdentity(original, verified, nativeIdentity)
    if (!verified.focused) {
      throw new ComputerControlFailure(
        'focus_failed',
        'Computer control element focus was not verified',
        true
      )
    }
    const foregroundAfterFocus = await this.driverCall(
      (driverSignal) =>
        this.driver.getForegroundWindow(driverSignal),
      signal
    )
    this.assertWindowMatches(lease, foregroundAfterFocus)
    return verified
  }

  private assertElementIdentity(
    original: DriverElement,
    resolved: DriverElement | undefined,
    nativeIdentity: DriverElement['nativeIdentity']
  ): asserts resolved is DriverElement {
    if (
      !resolved ||
      resolved.nativeIdentity !== nativeIdentity ||
      resolved.role !== original.role ||
      resolved.name !== original.name
    ) {
      throw new ComputerControlFailure(
        'element_identity_changed',
        'Computer control element identity changed',
        true
      )
    }
  }

  private assertWindowMatches(
    lease: ComputerControlLease,
    window: DriverWindowIdentity
  ): void {
    if (
      lease.pid !== window.pid ||
      lease.processStartTime !== window.processStartTime ||
      lease.windowIdentity !== window.windowIdentity
    ) {
      this.revoke(lease.leaseId)
      throw new ComputerControlFailure(
        'window_not_foreground',
        'Leased window is not the foreground window',
        true
      )
    }
  }

  private classifyRisk(
    action: ComputerControlAction,
    element: DriverElement
  ): ComputerControlRisk {
    const baseline = classifyComputerControlAction(action, element)
    const additional = this.classify?.(action, element)
    return maximumRisk(baseline, additional)
  }

  private driverCall<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    return runWithDeadline(
      operation,
      signal,
      this.driverDeadlineMs,
      'driver_timeout'
    )
  }

  private serialize<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(key, tail)
    tail.finally(() => {
      if (this.queues.get(key) === tail) {
        this.queues.delete(key)
      }
    })
    return result
  }

  private auditBase(
    command: ComputerControlRuntimeCommand,
    context: BrokerExecutionContext
  ): Pick<
    ComputerControlAuditEvent,
    | 'timestamp'
    | 'taskId'
    | 'conversationId'
    | 'leaseId'
    | 'commandId'
  > {
    return {
      timestamp: this.now(),
      taskId: context.taskId,
      conversationId: context.conversationId,
      leaseId: command.leaseId,
      commandId: command.commandId
    }
  }

  private redactedTextMetadata(
    action: ComputerControlAction
  ): Pick<
    ComputerControlAuditEvent,
    'textLength' | 'textDigest'
  > {
    return action.kind === 'replace_text'
      ? {
          textLength: action.text.length,
          textDigest: digestComputerControlText(action.text)
        }
      : {}
  }

  private async writeFailureAudit(
    command: Extract<ComputerControlRuntimeCommand, { kind: 'act' }>,
    context: BrokerExecutionContext,
    failure: ComputerControlFailure
  ): Promise<void> {
    const risk: ComputerControlRisk =
      failure.code === 'forbidden'
        ? 'forbidden'
        : command.action.kind === 'replace_text' ||
            command.action.kind === 'select_option'
          ? 'input'
          : command.action.kind === 'activate'
            ? 'commit'
            : 'navigate'
    await this.writeAudit({
      ...this.auditBase(command, context),
      action: command.action.kind,
      risk,
      outcome:
        failure.code === 'outcome_unknown'
          ? 'outcome_unknown'
          : failure.code === 'approval_denied' ||
              failure.code === 'approval_timeout'
            ? 'denied'
            : 'failed',
      errorCode: failure.code,
      ...this.redactedTextMetadata(command.action)
    })
  }

  private async writeAudit(event: ComputerControlAuditEvent): Promise<void> {
    try {
      await this.audit.write(event)
      return
    } catch {
      // Audit persistence must not alter the command's cached result.
    }
    if (!this.fallbackAudit || this.fallbackAudit === this.audit) {
      return
    }
    try {
      await this.fallbackAudit.write(event)
    } catch {
      // The fallback is also best effort and isolated from execution.
    }
  }

  private normalizeFailure(error: unknown): ComputerControlFailure {
    if (error instanceof ComputerControlFailure) {
      return error
    }
    return new ComputerControlFailure(
      'internal_error',
      'Computer control failed safely'
    )
  }

  private boundedDisplayText(
    value: string,
    maximumLength: number
  ): string {
    return [...value]
      .filter((character) => {
        const code = character.charCodeAt(0)
        return code > 31 && code !== 127
      })
      .join('')
      .trim()
      .slice(0, maximumLength)
  }

  private errorResult(
    commandId: string,
    failure: ComputerControlFailure
  ): ComputerControlCommandResult {
    return {
      status: 'error',
      commandId,
      error: failure.toContract()
    }
  }

  private async releaseInjectedInput(): Promise<void> {
    try {
      await runWithDeadline(
        (signal) => this.driver.releaseInjectedInput(signal),
        new AbortController().signal,
        this.driverDeadlineMs,
        'driver_timeout'
      )
    } catch {
      // Cancellation cleanup is best effort and must not mask the result.
    }
  }
}
