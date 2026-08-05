import { afterEach, describe, expect, it } from 'vitest'
import { capabilityDiagnosticReportSchema } from '../../shared/capability-contracts'
import {
  CapabilityDiagnostics,
  type CapabilityDiagnosticCheck
} from './capability-diagnostics'

const originalDiagnosticSecret = process.env.GOODBUDDY_DIAGNOSTIC_TEST_SECRET

afterEach(() => {
  if (originalDiagnosticSecret === undefined) {
    delete process.env.GOODBUDDY_DIAGNOSTIC_TEST_SECRET
  } else {
    process.env.GOODBUDDY_DIAGNOSTIC_TEST_SECRET = originalDiagnosticSecret
  }
})

function check(
  id: string,
  status: 'available' | 'degraded' | 'unavailable',
  summary = `${id} result`
): CapabilityDiagnosticCheck {
  return {
    id,
    run: async () => ({ status, summary })
  }
}

describe('CapabilityDiagnostics', () => {
  it('aggregates required checks with unavailable taking precedence', async () => {
    const diagnostics = new CapabilityDiagnostics(
      [
        check('browser-executable', 'degraded'),
        check('managed-profile-root', 'unavailable')
      ],
      { now: () => new Date('2026-08-05T12:00:00.000Z') }
    )

    await expect(
      diagnostics.diagnose({
        capabilityId: 'host-browser-control',
        enabled: true,
        platform: 'win32',
        architecture: 'x64'
      })
    ).resolves.toMatchObject({
      status: 'unavailable',
      checkedAt: '2026-08-05T12:00:00.000Z',
      checks: [
        { id: 'browser-executable', status: 'degraded' },
        { id: 'managed-profile-root', status: 'unavailable' }
      ]
    })
  })

  it('reports available, degraded, disabled and unsupported states', async () => {
    const available = new CapabilityDiagnostics([
      check('browser-executable', 'available'),
      check('managed-profile-root', 'available')
    ])
    const degraded = new CapabilityDiagnostics([
      check('browser-executable', 'available'),
      check('managed-profile-root', 'degraded')
    ])
    const request = {
      capabilityId: 'host-browser-control' as const,
      enabled: true,
      platform: 'linux' as const,
      architecture: 'arm64'
    }

    await expect(available.diagnose(request)).resolves.toMatchObject({
      status: 'available'
    })
    await expect(degraded.diagnose(request)).resolves.toMatchObject({
      status: 'degraded'
    })
    await expect(
      available.diagnose({ ...request, enabled: false })
    ).resolves.toMatchObject({ status: 'disabled', checks: [] })
    await expect(
      available.diagnose({
        ...request,
        platform: 'freebsd'
      })
    ).resolves.toMatchObject({
      status: 'unavailable',
      checks: [{ id: 'platform-support', status: 'unavailable' }]
    })
  })

  it('redacts environment values, credentials and sensitive paths', async () => {
    process.env.GOODBUDDY_DIAGNOSTIC_TEST_SECRET =
      'environment-secret-value-12345'
    const diagnostics = new CapabilityDiagnostics([
      {
        id: 'browser-executable',
        run: async () => ({
          status: 'degraded',
          summary:
            'token=top-secret-token Bearer abc.def.ghi environment-secret-value-12345 /home/alice/private/browser',
          remedy:
            'apiKey=sk-abcdefghijklmnop at C:\\Users\\Alice\\AppData\\browser'
        })
      },
      check('managed-profile-root', 'available')
    ])
    const report = await diagnostics.diagnose({
      capabilityId: 'host-browser-control',
      enabled: true,
      platform: 'linux',
      architecture: 'x64'
    })
    const serialized = JSON.stringify(report)

    expect(capabilityDiagnosticReportSchema.parse(report)).toEqual(report)
    expect(serialized).not.toContain('top-secret-token')
    expect(serialized).not.toContain('abc.def.ghi')
    expect(serialized).not.toContain('environment-secret-value-12345')
    expect(serialized).not.toContain('/home/alice')
    expect(serialized).not.toContain('C:\\\\Users\\\\Alice')
    expect(serialized).toContain('[redacted')
  })

  it('fails closed when a check times out', async () => {
    const diagnostics = new CapabilityDiagnostics(
      [
        {
          id: 'browser-executable',
          run: async () => new Promise(() => undefined)
        },
        check('managed-profile-root', 'available')
      ],
      { timeoutMs: 10 }
    )
    const report = await diagnostics.diagnose({
      capabilityId: 'host-browser-control',
      enabled: true,
      platform: 'win32',
      architecture: 'x64'
    })

    expect(report.status).toBe('unavailable')
    expect(report.checks[0]).toMatchObject({
      id: 'browser-executable',
      status: 'unavailable',
      summary: '诊断检查超时。'
    })
  })

  it('fails closed promptly when cancelled', async () => {
    const controller = new AbortController()
    const diagnostics = new CapabilityDiagnostics(
      [
        {
          id: 'browser-executable',
          run: async () => new Promise(() => undefined)
        },
        check('managed-profile-root', 'available')
      ],
      { timeoutMs: 1_000 }
    )
    const pending = diagnostics.diagnose({
      capabilityId: 'host-browser-control',
      enabled: true,
      platform: 'darwin',
      architecture: 'arm64',
      signal: controller.signal
    })
    controller.abort()

    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      checks: [
        {
          id: 'browser-executable',
          status: 'unavailable',
          summary: '诊断检查已取消。'
        },
        {
          id: 'managed-profile-root',
          status: 'unavailable',
          summary: '诊断检查已取消。'
        }
      ]
    })
  })
})
