import {
  feedbackLimits,
  feedbackPublicPayloadSchema,
  feedbackSubmitInputSchema,
  type FeedbackPublicPayload,
  type FeedbackSubmitInput,
  type FeedbackSubmitResult
} from '../../shared/feedback-contracts'
import {
  normalizeDesktopDiagnosticRecord,
  type DesktopDiagnosticRecord
} from '../desktop-diagnostics'
import { FeedbackIdentityStore } from './feedback-identity-store'
import {
  FeedbackClientError,
  StrictFeedbackHttpClient
} from './feedback-http-client'
import {
  FeedbackScreenshotError,
  normalizeFeedbackScreenshot
} from './feedback-screenshot'

const diagnosticsBeginMarker =
  '[GOODBUDDY_DESKTOP_DIAGNOSTICS_V1_BEGIN]'
const diagnosticsEndMarker =
  '[GOODBUDDY_DESKTOP_DIAGNOSTICS_V1_END]'
export type FeedbackDiagnosticsProvider = {
  readRecent: (
    limit: number
  ) => Promise<readonly DesktopDiagnosticRecord[]>
}

function formatDiagnosticsSummary(
  records: readonly DesktopDiagnosticRecord[]
): string {
  const lines = records
    .map(normalizeDesktopDiagnosticRecord)
    .filter(
      (record): record is DesktopDiagnosticRecord =>
        record !== undefined
    )
    .map((record) => JSON.stringify(record))
  if (lines.length === 0) {
    return [
      diagnosticsBeginMarker,
      JSON.stringify({ status: 'no-recent-diagnostics' }),
      diagnosticsEndMarker
    ].join('\n')
  }

  const included: string[] = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = [lines[index]!, ...included]
    const summary = [
      diagnosticsBeginMarker,
      ...candidate,
      diagnosticsEndMarker
    ].join('\n')
    if (
      summary.length >
      feedbackLimits.maximumDiagnosticsSummaryCharacters
    ) {
      break
    }
    included.unshift(lines[index]!)
  }
  return [
    diagnosticsBeginMarker,
    ...included,
    diagnosticsEndMarker
  ].join('\n')
}

function mapPlatform(
  platform: NodeJS.Platform
): FeedbackPublicPayload['environment']['platform'] {
  switch (platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    case 'linux':
      return 'linux'
    default:
      return 'unknown'
  }
}

function mapArchitecture(
  architecture: string
): FeedbackPublicPayload['environment']['architecture'] {
  return architecture === 'x64' || architecture === 'arm64'
    ? architecture
    : 'unknown'
}

export class FeedbackService {
  private readonly active = new Map<
    string,
    {
      controller: AbortController
      operation: Promise<FeedbackSubmitResult>
    }
  >()
  private state: 'ready' | 'clearing' | 'disposed' = 'ready'
  private clearOperation?: Promise<void>

  constructor(
    private readonly options: {
      appVersion: string
      platform: NodeJS.Platform
      architecture: string
      identityStore: FeedbackIdentityStore
      client: StrictFeedbackHttpClient
      diagnosticsProvider: FeedbackDiagnosticsProvider
    }
  ) {}

  submit(input: FeedbackSubmitInput): Promise<FeedbackSubmitResult> {
    if (this.state !== 'ready') {
      return Promise.resolve({
        ok: false,
        error: 'unavailable'
      })
    }
    const parsed = feedbackSubmitInputSchema.parse(input)
    const existing = this.active.get(parsed.clientRequestId)
    if (existing) {
      return existing.operation
    }
    if (this.active.size > 0) {
      return Promise.resolve({
        ok: false,
        error: 'busy'
      })
    }
    const controller = new AbortController()
    const operation = this.performSubmit(parsed, controller.signal)
    const entry = { controller, operation }
    this.active.set(parsed.clientRequestId, entry)
    void operation.then(
      () => {
        if (this.active.get(parsed.clientRequestId) === entry) {
          this.active.delete(parsed.clientRequestId)
        }
      },
      () => {
        if (this.active.get(parsed.clientRequestId) === entry) {
          this.active.delete(parsed.clientRequestId)
        }
      }
    )
    return operation
  }

  clear(): Promise<void> {
    if (this.state === 'disposed') {
      return Promise.resolve()
    }
    if (this.clearOperation) {
      return this.clearOperation
    }
    this.state = 'clearing'
    const operation = (async () => {
      this.abortActive('Feedback data is being cleared')
      await Promise.allSettled(
        [...this.active.values()].map(({ operation }) => operation)
      )
      await this.options.identityStore.clear()
    })()
    const tracked = operation.finally(() => {
      if (this.clearOperation === tracked) {
        this.clearOperation = undefined
      }
      if (this.state === 'clearing') {
        this.state = 'ready'
      }
    })
    this.clearOperation = tracked
    return tracked
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') {
      return
    }
    this.state = 'disposed'
    this.abortActive('Feedback service is shutting down')
    await Promise.allSettled(
      [
        this.clearOperation,
        ...[...this.active.values()].map(({ operation }) => operation)
      ]
    )
    await this.options.client.close()
  }

  private async performSubmit(
    input: FeedbackSubmitInput,
    signal: AbortSignal
  ): Promise<FeedbackSubmitResult> {
    try {
      let description = input.description
      if (input.includeDiagnostics) {
        try {
          const records =
            await this.options.diagnosticsProvider.readRecent(
              feedbackLimits.maximumDiagnosticRecords
            )
          description = `${description}\n\n${formatDiagnosticsSummary(
            records
          )}`
        } catch {
          return {
            ok: false,
            error: 'diagnostics-unavailable'
          }
        }
      }
      const installationId =
        await this.options.identityStore.getInstallationId()
      const payload = feedbackPublicPayloadSchema.parse({
        schemaVersion: 1,
        productKey: 'goodbuddy',
        category: input.category,
        title: input.title,
        description,
        ...(input.contactEmail
          ? { contactEmail: input.contactEmail }
          : {}),
        environment: {
          appVersion: this.options.appVersion,
          platform: mapPlatform(this.options.platform),
          architecture: mapArchitecture(
            this.options.architecture
          ),
          locale: input.locale
        },
        installationId,
        clientRequestId: input.clientRequestId
      })
      const screenshot = input.screenshot
        ? normalizeFeedbackScreenshot(input.screenshot).data
        : undefined
      const result = await this.options.client.submit(
        payload,
        screenshot,
        signal
      )
      return {
        ok: true,
        reference: result.reference,
        duplicate: result.duplicate
      }
    } catch (error) {
      if (error instanceof FeedbackClientError) {
        return {
          ok: false,
          error: error.code
        }
      }
      if (error instanceof FeedbackScreenshotError) {
        return {
          ok: false,
          error: error.code
        }
      }
      return {
        ok: false,
        error: 'unavailable'
      }
    }
  }

  private abortActive(reason: string): void {
    for (const { controller } of this.active.values()) {
      controller.abort(new Error(reason))
    }
  }
}
