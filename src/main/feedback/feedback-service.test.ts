import { describe, expect, it, vi } from 'vitest'
import {
  feedbackLimits,
  type FeedbackSubmitInput
} from '../../shared/feedback-contracts'
import { FeedbackIdentityStore } from './feedback-identity-store'
import {
  FeedbackClientError,
  StrictFeedbackHttpClient
} from './feedback-http-client'
import {
  FeedbackService,
  type FeedbackDiagnosticsProvider
} from './feedback-service'

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn()
  }
}))

const input: FeedbackSubmitInput = {
  category: 'feature',
  title: 'Feedback title',
  description: 'A useful feedback description.',
  includeDiagnostics: false,
  contactEmail: 'user@example.com',
  locale: 'en-US',
  clientRequestId: '00000000-0000-4000-8000-000000000401'
}

function service(
  submit: StrictFeedbackHttpClient['submit'],
  clear = vi.fn(async () => undefined),
  readRecent: FeedbackDiagnosticsProvider['readRecent'] =
    vi.fn(async () => [])
) {
  const identityStore = {
    getInstallationId: vi.fn(
      async () => '00000000-0000-4000-8000-000000000402'
    ),
    clear
  }
  const client = {
    submit,
    close: vi.fn(async () => undefined)
  }
  return {
    service: new FeedbackService({
      appVersion: '0.11.0',
      platform: 'win32',
      architecture: 'x64',
      identityStore: identityStore as unknown as FeedbackIdentityStore,
      client: client as unknown as StrictFeedbackHttpClient,
      diagnosticsProvider: { readRecent }
    }),
    identityStore,
    client,
    readRecent
  }
}

describe('FeedbackService', () => {
  it('adds trusted environment and installation values', async () => {
    const submit = vi.fn<StrictFeedbackHttpClient['submit']>(
      async () => ({
        reference: 'GOODBUDDY-000003',
        duplicate: false
      })
    )
    const fixture = service(submit)
    await expect(fixture.service.submit(input)).resolves.toEqual({
      ok: true,
      reference: 'GOODBUDDY-000003',
      duplicate: false
    })
    expect(submit).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        productKey: 'goodbuddy',
        category: input.category,
        title: input.title,
        description: input.description,
        contactEmail: input.contactEmail,
        installationId:
          '00000000-0000-4000-8000-000000000402',
        clientRequestId: input.clientRequestId,
        environment: {
          appVersion: '0.11.0',
          platform: 'windows',
          architecture: 'x64',
          locale: 'en-US'
        }
      },
      undefined,
      expect.any(AbortSignal)
    )
    expect(fixture.readRecent).not.toHaveBeenCalled()
  })

  it('appends bounded desktop diagnostics without changing public fields', async () => {
    const submit = vi.fn<StrictFeedbackHttpClient['submit']>(
      async () => ({
        reference: 'GOODBUDDY-000013',
        duplicate: false
      })
    )
    const readRecent = vi.fn(async () => [
      {
        timestamp: '2026-08-25T01:02:03.000Z',
        component: 'runtime' as const,
        stage: 'run',
        code: 'runtime.run.failed',
        errorType: 'TimeoutError',
        message: 'password=hunter2'
      }
    ])
    const fixture = service(
      submit,
      vi.fn(async () => undefined),
      readRecent
    )
    await expect(
      fixture.service.submit({
        ...input,
        includeDiagnostics: true
      })
    ).resolves.toMatchObject({ ok: true })
    expect(readRecent).toHaveBeenCalledWith(
      feedbackLimits.maximumDiagnosticRecords
    )
    const payload = submit.mock.calls[0]![0]
    expect(payload).toMatchObject({
      schemaVersion: 1,
      productKey: 'goodbuddy',
      category: input.category,
      title: input.title,
      contactEmail: input.contactEmail
    })
    expect(payload).not.toHaveProperty('includeDiagnostics')
    expect(payload.description).toContain(input.description)
    expect(payload.description).toContain(
      '[GOODBUDDY_DESKTOP_DIAGNOSTICS_V1_BEGIN]\n'
    )
    expect(payload.description).toContain(
      '{"timestamp":"2026-08-25T01:02:03.000Z","component":"runtime","stage":"run","code":"runtime.run.failed","errorType":"TimeoutError","message":"Runtime request failed"}'
    )
    expect(payload.description).not.toContain('hunter2')
    expect(payload.description).toMatch(
      /\n\[GOODBUDDY_DESKTOP_DIAGNOSTICS_V1_END\]$/u
    )
    expect(payload.description.length).toBeLessThanOrEqual(
      feedbackLimits.maximumDescriptionCharacters
    )
  })

  it('states when no recent desktop diagnostics exist', async () => {
    const submit = vi.fn<StrictFeedbackHttpClient['submit']>(
      async () => ({
        reference: 'GOODBUDDY-000014',
        duplicate: false
      })
    )
    const fixture = service(submit)
    await fixture.service.submit({
      ...input,
      includeDiagnostics: true
    })
    expect(submit.mock.calls[0]![0].description).toContain(
      '{"status":"no-recent-diagnostics"}'
    )
  })

  it('keeps a bounded summary on complete diagnostic lines', async () => {
    const submit = vi.fn<StrictFeedbackHttpClient['submit']>(
      async () => ({
        reference: 'GOODBUDDY-000017',
        duplicate: false
      })
    )
    const records = Array.from({ length: 20 }, (_, index) => ({
      timestamp: new Date(
        Date.UTC(2026, 7, 25, 1, index)
      ).toISOString(),
      component: 'runtime' as const,
      stage: 'run',
      code: 'runtime.run.failed',
      errorType: 'TimeoutError',
      message: 'Runtime request failed'
    }))
    const fixture = service(
      submit,
      vi.fn(async () => undefined),
      vi.fn(async () => records)
    )
    await fixture.service.submit({
      ...input,
      includeDiagnostics: true
    })
    const summary = submit.mock.calls[0]![0].description.split(
      '\n\n'
    )[1]!
    expect(summary.length).toBeLessThanOrEqual(
      feedbackLimits.maximumDiagnosticsSummaryCharacters
    )
    const lines = summary.split('\n')
    expect(lines[0]).toBe(
      '[GOODBUDDY_DESKTOP_DIAGNOSTICS_V1_BEGIN]'
    )
    expect(lines.at(-1)).toBe(
      '[GOODBUDDY_DESKTOP_DIAGNOSTICS_V1_END]'
    )
    const included = lines
      .slice(1, -1)
      .map((line) => JSON.parse(line) as { timestamp: string })
    expect(included.length).toBeGreaterThan(0)
    expect(included.length).toBeLessThan(records.length)
    expect(included.at(-1)?.timestamp).toBe(
      records.at(-1)?.timestamp
    )
  })

  it('does not send when selected diagnostics cannot be read', async () => {
    const submit = vi.fn<StrictFeedbackHttpClient['submit']>(
      async () => ({
        reference: 'GOODBUDDY-000015',
        duplicate: false
      })
    )
    const readRecent = vi.fn(async () => {
      throw new Error('read failed')
    })
    const fixture = service(
      submit,
      vi.fn(async () => undefined),
      readRecent
    )
    await expect(
      fixture.service.submit({
        ...input,
        includeDiagnostics: true
      })
    ).resolves.toEqual({
      ok: false,
      error: 'diagnostics-unavailable'
    })
    expect(submit).not.toHaveBeenCalled()
  })

  it('coalesces concurrent submissions with the same client request ID', async () => {
    let resolve!: (value: {
      reference: string
      duplicate: boolean
    }) => void
    const submit = vi.fn<StrictFeedbackHttpClient['submit']>(
      () =>
        new Promise((complete) => {
          resolve = complete
        })
    )
    const fixture = service(submit)
    const first = fixture.service.submit(input)
    const second = fixture.service.submit(input)
    expect(second).toBe(first)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    await expect(
      fixture.service.submit({
        ...input,
        clientRequestId:
          '00000000-0000-4000-8000-000000000403'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'busy'
    })
    resolve({
      reference: 'GOODBUDDY-000004',
      duplicate: false
    })
    await expect(first).resolves.toMatchObject({ ok: true })
  })

  it('returns bounded error codes and clears the separate identity', async () => {
    const submit = vi.fn<StrictFeedbackHttpClient['submit']>(
      async () => {
        throw new FeedbackClientError('rate-limited')
      }
    )
    const clear = vi.fn(async () => undefined)
    const fixture = service(submit, clear)
    await expect(fixture.service.submit(input)).resolves.toEqual({
      ok: false,
      error: 'rate-limited'
    })
    await fixture.service.clear()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('blocks new submissions while local feedback data is clearing', async () => {
    const submit = vi.fn<StrictFeedbackHttpClient['submit']>(
      async (_payload, _screenshot, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new FeedbackClientError('network')),
            { once: true }
          )
        })
    )
    const fixture = service(submit)
    const inFlight = fixture.service.submit(input)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())

    const clearing = fixture.service.clear()
    await expect(
      fixture.service.submit({
        ...input,
        clientRequestId:
          '00000000-0000-4000-8000-000000000404'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'unavailable'
    })
    await expect(inFlight).resolves.toEqual({
      ok: false,
      error: 'network'
    })
    await clearing
    expect(fixture.identityStore.clear).toHaveBeenCalledOnce()
  })
})
