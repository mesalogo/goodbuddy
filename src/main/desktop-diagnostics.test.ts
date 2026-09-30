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
  it('gates MCP metadata and discards unknown or unsafe fields', () => {
    const record = { timestamp: '2026-09-30T00:00:00Z', component: 'runtime', stage: 'connect', code: 'runtime.mcp.failed' }
    const mcp = { phase: 'initialize', category: 'http-rejection', elapsedMs: 25, status: 406, correlationId: `sha256:${'a'.repeat(64)}`, token: 'private-token', headers: { authorization: 'private-token' } }
    expect(normalizeDesktopDiagnosticRecord({ ...record, mcp })?.mcp).toEqual({ phase: 'initialize', category: 'http-rejection', elapsedMs: 25, status: 406, correlationId: mcp.correlationId })
    expect(normalizeDesktopDiagnosticRecord({ ...record, code: 'runtime.run.failed', mcp })).not.toHaveProperty('mcp')
    expect(normalizeDesktopDiagnosticRecord({ ...record, component: 'desktop', mcp })).not.toHaveProperty('mcp')
    for (const invalid of [{ phase: 'private-url' }, { category: 'private-body' }, { elapsedMs: -1 }, { elapsedMs: Infinity }, { elapsedMs: 1.5 }]) {
      expect(normalizeDesktopDiagnosticRecord({ ...record, mcp: { ...mcp, ...invalid } })).not.toHaveProperty('mcp')
    }
    expect(normalizeDesktopDiagnosticRecord({ ...record, mcp: { ...mcp, status: 999, correlationId: 'raw-token' } })?.mcp)
      .toEqual({ phase: 'initialize', category: 'http-rejection', elapsedMs: 25 })
  })

  it('renormalizes stored MCP metadata during export after restart', async () => {
    const directory = await temporaryDirectory()
    const diagnostics = new DesktopDiagnostics(directory)
    const mcp = { phase: 'tool-discovery' as const, category: 'handler-failure' as const, elapsedMs: 42, correlationId: `sha256:${'b'.repeat(64)}` }
    await diagnostics.recordFailure({ component: 'runtime', stage: 'connect', code: 'runtime.mcp.failed', error: new Error('private-error'), mcp })
    await diagnostics.dispose()
    const path = join(directory, 'desktop-diagnostics.ndjson')
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.mcp).toEqual(mcp)
    await writeFile(path, JSON.stringify({ ...stored, message: 'private-body', mcp: { ...mcp, token: 'private-token', url: 'private-url', stack: 'private-stack', status: 'private-status' } }) + '\n')
    const restarted = new DesktopDiagnostics(directory)
    try {
      const exported = (await restarted.exportRecent()).toString('utf8')
      expect(JSON.parse(exported).mcp).toEqual(mcp)
      expect(exported).not.toContain('private-')
    } finally { await restarted.dispose() }
  })

  it.each(['connect', 'disconnect'])('allowlists runtime MCP %s attempts', (phase) => {
    const record = { timestamp: '2026-09-30T00:00:00Z', component: 'runtime', stage: phase, code: 'runtime.mcp.failed' }
    const mcp = { phase, category: 'transport-failure', elapsedMs: 1000, attempt: 2, kind: 'custom', correlationId: `sha256:${'c'.repeat(64)}` }
    expect(normalizeDesktopDiagnosticRecord({ ...record, mcp: { ...mcp, error: 'private-error', token: 'private-token' } })?.mcp).toEqual(mcp)
    for (const category of ['initialization-failure', 'cleanup-failure', 'cancelled']) {
      expect(normalizeDesktopDiagnosticRecord({ ...record, mcp: { ...mcp, category } })?.mcp?.category).toBe(category)
    }
    for (const attempt of [0, 3, 1.5, '1']) {
      const normalized = normalizeDesktopDiagnosticRecord({ ...record, mcp: { ...mcp, attempt, kind: 'private-kind' } })?.mcp
      expect(normalized).not.toHaveProperty('attempt')
      expect(normalized).not.toHaveProperty('kind')
      expect(normalized?.correlationId).toBe(mcp.correlationId)
    }
  })

  it('preserves renderer exit details on disk and in exports after restart', async () => {
    const directory = await temporaryDirectory()
    const diagnostics = new DesktopDiagnostics(directory)
    await diagnostics.recordFailure({
      component: 'desktop', stage: 'renderer', code: 'desktop.renderer.gone',
      error: new Error('private renderer details'), reason: 'oom', exitCode: -9
    })
    await diagnostics.dispose()
    const persisted = await readFile(join(directory, 'desktop-diagnostics.ndjson'), 'utf8')
    expect(JSON.parse(persisted)).toMatchObject({ reason: 'oom', exitCode: -9 })
    expect(persisted).not.toContain('private renderer details')
    const restarted = new DesktopDiagnostics(directory)
    try {
      expect(JSON.parse((await restarted.exportRecent()).toString('utf8')))
        .toMatchObject({ reason: 'oom', exitCode: -9 })
    } finally {
      await restarted.dispose()
    }
  })

  it('omits invalid exit details and keeps older records readable', () => {
    const record = {
      timestamp: '2026-09-28T03:19:18.062Z', component: 'desktop',
      stage: 'renderer', code: 'desktop.renderer.gone', errorType: 'Error'
    }
    const normalized = normalizeDesktopDiagnosticRecord(record)
    expect(normalized).toMatchObject({ code: 'desktop.renderer.gone' })
    expect(normalized).not.toHaveProperty('reason')
    expect(normalized).not.toHaveProperty('exitCode')
    expect(normalizeDesktopDiagnosticRecord({
      ...record, reason: 'private error content', exitCode: Infinity
    })).toEqual(normalized)
  })

  it('persists renderer failure codes without storing raw error content', async () => {
    const diagnostics = new DesktopDiagnostics(await temporaryDirectory())
    for (const code of ['desktop.renderer.gone', 'desktop.renderer.load-failed']) {
      await diagnostics.recordFailure({
        component: 'desktop', stage: 'renderer', code,
        error: new Error('private renderer details')
      })
    }
    const records = await diagnostics.readRecent()
    expect(records.map(record => record.code)).toEqual([
      'desktop.renderer.gone', 'desktop.renderer.load-failed'
    ])
    expect(records.every(record => record.message === 'Desktop renderer failed')).toBe(true)
    expect(JSON.stringify(records)).not.toContain('private renderer details')
    await diagnostics.dispose()
  })
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
