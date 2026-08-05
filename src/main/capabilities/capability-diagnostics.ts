import { z } from 'zod'
import {
  capabilityDiagnosticCheckSchema,
  capabilityDiagnosticCheckStatusSchema,
  capabilityDiagnosticReportSchema,
  type CapabilityDiagnosticReport,
  type ComputerCapabilityId
} from '../../shared/capability-contracts'
export type { CapabilityDiagnosticReport } from '../../shared/capability-contracts'
import { redactSensitiveText } from '../agent/approval-summary'
import {
  getComputerCapability,
  isComputerCapabilitySupported,
  type ComputerCapabilityImplementationKind
} from './computer-capability-catalog'

const MAX_SUMMARY_LENGTH = 240
const MAX_REMEDY_LENGTH = 400
const diagnosticCheckIdSchema = capabilityDiagnosticCheckSchema.shape.id

export const diagnosticCheckResultSchema = z
  .object({
    status: capabilityDiagnosticCheckStatusSchema,
    summary: z.string().min(1).max(4_096),
    remedy: z.string().max(4_096).optional()
  })
  .strict()

export type DiagnosticCheckResult = z.infer<
  typeof diagnosticCheckResultSchema
>

export type CapabilityDiagnosticCheck = Readonly<{
  id: string
  run: (signal: AbortSignal) => Promise<DiagnosticCheckResult>
}>

export type CapabilityDiagnosticRequest = Readonly<{
  capabilityId: ComputerCapabilityId
  enabled: boolean
  platform: NodeJS.Platform
  architecture: string
  availableImplementationKinds?: ReadonlySet<ComputerCapabilityImplementationKind>
  signal?: AbortSignal
}>

function redactText(value: string, maximumLength: number): string {
  let redacted = redactSensitiveText(value)
  const environmentValues = Object.values(process.env)
    .filter((candidate): candidate is string => Boolean(candidate?.length && candidate.length >= 8))
    .sort((left, right) => right.length - left.length)
  for (const environmentValue of environmentValues) {
    redacted = redacted.split(environmentValue).join('[redacted-env]')
  }
  redacted = redacted
    .replace(
      /(?:[a-zA-Z]:\\(?:Users|Documents and Settings)\\|\/(?:Users|home|root|private|var\/folders|tmp)\/)[^\s"'<>]+/gu,
      '[redacted-path]'
    )
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
  return redacted.slice(0, maximumLength)
}

function unavailableCheck(
  id: string,
  summary: string,
  remedy?: string
): CapabilityDiagnosticReport['checks'][number] {
  return {
    id,
    status: 'unavailable',
    summary: redactText(summary, MAX_SUMMARY_LENGTH),
    ...(remedy
      ? { remedy: redactText(remedy, MAX_REMEDY_LENGTH) }
      : {})
  }
}

export class CapabilityDiagnostics {
  private readonly checks: ReadonlyMap<string, CapabilityDiagnosticCheck>
  private readonly timeoutMs: number
  private readonly now: () => Date

  constructor(
    checks: readonly CapabilityDiagnosticCheck[],
    options: Readonly<{ timeoutMs?: number; now?: () => Date }> = {}
  ) {
    const mapped = new Map<string, CapabilityDiagnosticCheck>()
    for (const check of checks) {
      const id = diagnosticCheckIdSchema.parse(check.id)
      if (mapped.has(id)) {
        throw new Error(`Duplicate capability diagnostic check: ${id}`)
      }
      mapped.set(id, Object.freeze({ id, run: check.run }))
    }
    this.checks = mapped
    this.timeoutMs = z
      .number()
      .int()
      .min(10)
      .max(30_000)
      .parse(options.timeoutMs ?? 5_000)
    this.now = options.now ?? (() => new Date())
  }

  private checkedAt(): string {
    const value = this.now()
    if (Number.isNaN(value.getTime())) {
      throw new Error('Diagnostic clock returned an invalid date')
    }
    return value.toISOString()
  }

  private async runCheck(
    id: string,
    parentSignal?: AbortSignal
  ): Promise<CapabilityDiagnosticReport['checks'][number]> {
    const check = this.checks.get(id)
    if (!check) {
      return unavailableCheck(
        id,
        '缺少必需的诊断检查。',
        '请重新安装或修复此能力的受管组件。'
      )
    }
    if (parentSignal?.aborted) {
      return unavailableCheck(id, '诊断检查已取消。', '请重试诊断。')
    }

    const controller = new AbortController()
    let timedOut = false
    let cancelled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutResult = new Promise<'timeout'>((resolveTimeout) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('Diagnostic check timed out'))
        resolveTimeout('timeout')
      }, this.timeoutMs)
    })
    let resolveCancellation: (() => void) | undefined
    const cancellation = new Promise<'cancelled'>((resolveCancelled) => {
      resolveCancellation = () => resolveCancelled('cancelled')
    })
    const abortFromParent = (): void => {
      cancelled = true
      controller.abort(parentSignal?.reason)
      resolveCancellation?.()
    }
    parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    const operation = Promise.resolve()
      .then(() => check.run(controller.signal))
      .then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error })
      )

    try {
      const outcome = await Promise.race([
        operation,
        timeoutResult.then((kind) => ({ kind })),
        cancellation.then((kind) => ({ kind }))
      ])
      if (outcome.kind === 'timeout' || timedOut) {
        return unavailableCheck(
          id,
          '诊断检查超时。',
          '请确认受管组件可响应后重试。'
        )
      }
      if (outcome.kind === 'cancelled' || cancelled) {
        return unavailableCheck(id, '诊断检查已取消。', '请重试诊断。')
      }
      if (outcome.kind === 'error') {
        const message =
          outcome.error instanceof Error
            ? outcome.error.message
            : '未知诊断错误'
        return unavailableCheck(
          id,
          `诊断检查失败：${message}`,
          '请修复本地环境后重试。'
        )
      }
      try {
        const result = diagnosticCheckResultSchema.parse(outcome.result)
        return {
          id,
          status: result.status,
          summary: redactText(result.summary, MAX_SUMMARY_LENGTH),
          ...(result.remedy
            ? { remedy: redactText(result.remedy, MAX_REMEDY_LENGTH) }
            : {})
        }
      } catch {
        return unavailableCheck(
          id,
          '诊断检查返回了无效结果。',
          '请重新安装或修复此能力的受管组件。'
        )
      }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
  }

  async diagnose(
    request: CapabilityDiagnosticRequest
  ): Promise<CapabilityDiagnosticReport> {
    const capability = getComputerCapability(request.capabilityId)
    const checkedAt = this.checkedAt()
    if (!request.enabled) {
      return capabilityDiagnosticReportSchema.parse({
        capabilityId: capability.id,
        status: 'disabled',
        checkedAt,
        checks: []
      })
    }
    if (
      !isComputerCapabilitySupported(
        capability,
        request.platform,
        request.architecture,
        request.availableImplementationKinds
      )
    ) {
      return capabilityDiagnosticReportSchema.parse({
        capabilityId: capability.id,
        status: 'unavailable',
        checkedAt,
        checks: [
          unavailableCheck(
            'platform-support',
            '当前操作系统或处理器架构不受支持。',
            '请在能力目录列出的受支持平台上使用此能力。'
          )
        ]
      })
    }

    const checks = []
    for (const id of capability.requiredDiagnostics) {
      checks.push(await this.runCheck(id, request.signal))
    }
    const status = checks.some((check) => check.status === 'unavailable')
      ? 'unavailable'
      : checks.some((check) => check.status === 'degraded')
        ? 'degraded'
        : 'available'
    return capabilityDiagnosticReportSchema.parse({
      capabilityId: capability.id,
      status,
      checkedAt,
      checks
    })
  }
}
