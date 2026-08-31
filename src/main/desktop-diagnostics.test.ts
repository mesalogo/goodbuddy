import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DesktopDiagnostics,
  MAXIMUM_PENDING_DESKTOP_DIAGNOSTIC_WRITES,
  normalizeDesktopDiagnosticRecord
} from './desktop-diagnostics'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-desktop-diagnostics-')
  )
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('DesktopDiagnostics', () => {
  it('rotates within fixed file and byte bounds', async () => {
    const directory = await temporaryDirectory()
    let sequence = 0
    const diagnostics = new DesktopDiagnostics(directory, {
      maximumFileBytes: 420,
      maximumFiles: 3,
      now: () => new Date(sequence++ * 1_000)
    })

    for (let index = 0; index < 12; index += 1) {
      await diagnostics.recordFailure({
        component: 'runtime',
        stage: 'run',
        code: 'runtime.run.failed',
        error: new Error(`failure ${index}`)
      })
    }
    await diagnostics.dispose()

    const files = await readdir(directory)
    expect(files).toHaveLength(3)
    for (const file of files) {
      expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(
        420
      )
    }

    const reopened = new DesktopDiagnostics(directory, {
      maximumFileBytes: 420,
      maximumFiles: 3
    })
    const records = await reopened.readRecent()
    expect(records.length).toBeGreaterThan(0)
    expect(records.length).toBeLessThan(12)
    expect(records.at(-1)).toMatchObject({
      component: 'runtime',
      stage: 'run',
      code: 'runtime.run.failed',
      message: 'Runtime request failed'
    })
    await reopened.dispose()
  })

  it('reads bounded recent records after restart', async () => {
    const directory = await temporaryDirectory()
    const first = new DesktopDiagnostics(directory, {
      maximumRecords: 2
    })
    await first.recordFailure({
      component: 'desktop',
      stage: 'startup',
      code: 'desktop.startup.failed',
      error: new TypeError('first')
    })
    await first.recordFailure({
      component: 'remote-agent',
      stage: 'connect',
      code: 'remote.connection.network',
      error: new Error('second')
    })
    await first.recordFailure({
      component: 'runtime',
      stage: 'status',
      code: 'runtime.operation.failed',
      error: new Error('third')
    })
    await first.dispose()

    const restarted = new DesktopDiagnostics(directory, {
      maximumRecords: 2
    })
    await expect(restarted.readRecent(100)).resolves.toMatchObject([
      { code: 'remote.connection.network' },
      { code: 'runtime.operation.failed' }
    ])
    const exported = await restarted.exportRecent()
    expect(exported.toString('utf8').trim().split('\n')).toHaveLength(2)
    await restarted.dispose()
  })

  it('never persists raw error content or unknown error names', async () => {
    const directory = await temporaryDirectory()
    const diagnostics = new DesktopDiagnostics(directory)
    const secret =
      'Prompt body password=hunter2 API_KEY=abc https://provider.test/path?token=raw-response'
    const error = new Error(secret)
    error.name = `Credential-${secret}`

    await diagnostics.recordFailure({
      component: 'runtime',
      stage: secret,
      code: secret,
      error
    })
    const exported = await diagnostics.exportRecent()
    await diagnostics.dispose()

    expect(exported.toString('utf8')).not.toContain(secret)
    expect(exported.toString('utf8')).not.toContain('hunter2')
    expect(exported.toString('utf8')).not.toContain('provider.test')
    expect(JSON.parse(exported.toString('utf8'))).toMatchObject({
      errorType: 'Error',
      stage: 'unknown',
      code: 'diagnostic.failure',
      message: 'Runtime operation failed'
    })
    const persisted = await readFile(
      join(directory, 'desktop-diagnostics.ndjson'),
      'utf8'
    )
    expect(persisted).not.toContain('API_KEY')
  })

  it('uses one safe normalizer for externally damaged records', async () => {
    const directory = await temporaryDirectory()
    const damaged = {
      timestamp: '2026-08-25T01:02:03+00:00',
      component: 'remote-agent',
      stage: 'disconnect',
      code: 'remote.connection.lost',
      errorType: 'SensitiveProviderError',
      message: 'password=hunter2'
    }
    expect(normalizeDesktopDiagnosticRecord(damaged)).toEqual({
      timestamp: '2026-08-25T01:02:03.000Z',
      component: 'remote-agent',
      stage: 'disconnect',
      code: 'remote.connection.lost',
      errorType: 'Error',
      message: 'Remote connection was lost'
    })
    await writeFile(
      join(directory, 'desktop-diagnostics.ndjson'),
      `${JSON.stringify(damaged)}\n`,
      'utf8'
    )

    const diagnostics = new DesktopDiagnostics(directory)
    const records = await diagnostics.readRecent()
    await diagnostics.dispose()

    expect(records).toEqual([
      {
        timestamp: '2026-08-25T01:02:03.000Z',
        component: 'remote-agent',
        stage: 'disconnect',
        code: 'remote.connection.lost',
        errorType: 'Error',
        message: 'Remote connection was lost'
      }
    ])
    expect(JSON.stringify(records)).not.toContain('hunter2')
  })

  it('normalizes errors immediately and bounds pending writes', async () => {
    const directory = await temporaryDirectory()
    const diagnostics = new DesktopDiagnostics(directory)
    let errorNameReads = 0
    const writes = Array.from(
      {
        length:
          MAXIMUM_PENDING_DESKTOP_DIAGNOSTIC_WRITES + 8
      },
      () => {
        const error = new Error('raw provider failure')
        Object.defineProperty(error, 'name', {
          get: () => {
            errorNameReads += 1
            return 'TypeError'
          }
        })
        return diagnostics.recordFailure({
          component: 'runtime',
          stage: 'run',
          code: 'runtime.run.failed',
          error
        })
      }
    )

    expect(errorNameReads).toBe(writes.length)
    expect(diagnostics.pendingWriteCount).toBe(
      MAXIMUM_PENDING_DESKTOP_DIAGNOSTIC_WRITES
    )
    await Promise.all(writes)
    expect(diagnostics.pendingWriteCount).toBe(0)
    await expect(diagnostics.readRecent()).resolves.toHaveLength(
      MAXIMUM_PENDING_DESKTOP_DIAGNOSTIC_WRITES
    )
    await diagnostics.dispose()
  })
})
