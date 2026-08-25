import { describe, expect, it, vi } from 'vitest'
import type { FeedbackSubmitInput } from '../../shared/feedback-contracts'
import { FeedbackIdentityStore } from './feedback-identity-store'
import {
  FeedbackClientError,
  StrictFeedbackHttpClient
} from './feedback-http-client'
import { FeedbackService } from './feedback-service'

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn()
  }
}))

const input: FeedbackSubmitInput = {
  category: 'feature',
  title: 'Feedback title',
  description: 'A useful feedback description.',
  contactEmail: 'user@example.com',
  locale: 'en-US',
  clientRequestId: '00000000-0000-4000-8000-000000000401'
}

function service(
  submit: StrictFeedbackHttpClient['submit'],
  clear = vi.fn(async () => undefined)
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
      client: client as unknown as StrictFeedbackHttpClient
    }),
    identityStore,
    client
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
      expect.objectContaining({
        schemaVersion: 1,
        productKey: 'goodbuddy',
        installationId:
          '00000000-0000-4000-8000-000000000402',
        environment: {
          appVersion: '0.11.0',
          platform: 'windows',
          architecture: 'x64',
          locale: 'en-US'
        }
      }),
      undefined,
      expect.any(AbortSignal)
    )
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
