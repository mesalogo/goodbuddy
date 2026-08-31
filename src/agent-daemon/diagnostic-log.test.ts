import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_DIAGNOSTIC_DIRECTORY_NAME,
  AgentDiagnosticLog,
  readAgentDiagnostics
} from './diagnostic-log'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Agent diagnostic log', () => {
  it('rotates within fixed file and byte bounds and remains readable after restart', async () => {
    const stateDirectory = temporaryStateDirectory()
    let now = Date.UTC(2026, 7, 31)
    const first = new AgentDiagnosticLog(stateDirectory, {
      maximumFileBytes: 512,
      fileCount: 2,
      now: () => now,
      pid: 42
    })

    for (let index = 0; index < 20; index += 1) {
      first.record('connection.failed', {
        daemonBootId: `boot-${index}`,
        reason: 'socket-error',
        error: Object.assign(new Error(`failure-${index}`), {
          code: 'ECONNRESET'
        })
      })
      now += 1_000
    }
    await first.flush()

    const directory = resolve(
      stateDirectory,
      AGENT_DIAGNOSTIC_DIRECTORY_NAME
    )
    const files = readdirSync(directory)
    expect(files).toHaveLength(2)
    for (const file of files) {
      expect(statSync(resolve(directory, file)).size).toBeLessThanOrEqual(512)
    }

    const restarted = new AgentDiagnosticLog(stateDirectory, {
      maximumFileBytes: 512,
      fileCount: 2,
      pid: 43
    })
    const records = restarted.read()
    expect(records.length).toBeGreaterThan(0)
    expect(records.at(-1)).toMatchObject({
      event: 'connection.failed',
      daemonBootId: 'boot-19',
      error: {
        name: 'Error',
        code: 'ECONNRESET'
      }
    })
    expect(records.some((record) => record.daemonBootId === 'boot-0')).toBe(
      false
    )
  })

  it('persists only allowlisted metadata and never error messages or sensitive payloads', async () => {
    const stateDirectory = temporaryStateDirectory()
    const secretPrompt = 'accepted Prompt: summarize private-file.txt'
    const secretKey = 'sk-private-model-key'
    const secretConfig = '{"providerUrl":"https://private.invalid"}'
    const secretEnvironment = 'GOODBUDDY_SECRET=hidden'
    const secretSsh = 'ssh -i /home/user/private-key user@host'
    const secretOutput = 'MODEL_OUTPUT_PRIVATE'
    const error = Object.assign(
      new Error(
        [
          secretPrompt,
          secretKey,
          secretConfig,
          secretEnvironment,
          secretSsh,
          secretOutput
        ].join(' ')
      ),
      {
        code: secretKey,
        name: secretConfig
      }
    )
    const log = new AgentDiagnosticLog(stateDirectory, {
      pid: 42
    })

    log.record('runtime.start.failed', {
      runtimeId: 'opencode',
      workMode: 'execute',
      error
    })
    await log.flush()

    const raw = readdirSync(
      resolve(stateDirectory, AGENT_DIAGNOSTIC_DIRECTORY_NAME)
    )
      .map((name) =>
        readFileSync(
          resolve(
            stateDirectory,
            AGENT_DIAGNOSTIC_DIRECTORY_NAME,
            name
          ),
          'utf8'
        )
      )
      .join('')
    for (const sensitive of [
      secretPrompt,
      secretKey,
      secretConfig,
      secretEnvironment,
      secretSsh,
      secretOutput
    ]) {
      expect(raw).not.toContain(sensitive)
    }
    expect(JSON.parse(raw)).toEqual({
      formatVersion: 1,
      timestamp: expect.any(String),
      level: 'error',
      event: 'runtime.start.failed',
      pid: 42,
      runtimeId: 'opencode',
      workMode: 'execute',
      error: {
        name: 'Error'
      }
    })
    expect(readAgentDiagnostics(stateDirectory)).toHaveLength(1)
  })

  it('keeps a single-file configuration bounded', async () => {
    const stateDirectory = temporaryStateDirectory()
    const log = new AgentDiagnosticLog(stateDirectory, {
      maximumFileBytes: 512,
      fileCount: 1,
      pid: 42
    })

    for (let index = 0; index < 20; index += 1) {
      log.record('daemon.ready', {
        daemonBootId: `boot-${index}`
      })
    }
    await log.flush()

    const files = readdirSync(
      resolve(stateDirectory, AGENT_DIAGNOSTIC_DIRECTORY_NAME)
    )
    expect(files).toHaveLength(1)
    expect(
      statSync(
        resolve(
          stateDirectory,
          AGENT_DIAGNOSTIC_DIRECTORY_NAME,
          files[0]!
        )
      ).size
    ).toBeLessThanOrEqual(512)
  })

  it('keeps the default three 64 KiB private JSONL files bounded', async () => {
    const stateDirectory = temporaryStateDirectory()
    const log = new AgentDiagnosticLog(stateDirectory, {
      pid: 42
    })

    for (let batch = 0; batch < 50; batch += 1) {
      for (let index = 0; index < 60; index += 1) {
        log.record('connection.failed', {
          daemonBootId: `boot-${batch}-${index}`,
          reason: 'socket-error',
          error: Object.assign(new Error('private failure'), {
            code: 'ECONNRESET'
          })
        })
      }
      await log.flush()
    }

    const directory = resolve(
      stateDirectory,
      AGENT_DIAGNOSTIC_DIRECTORY_NAME
    )
    const files = readdirSync(directory).sort()
    expect(files).toEqual([
      'agent-diagnostics.jsonl',
      'agent-diagnostics.jsonl.1',
      'agent-diagnostics.jsonl.2'
    ])
    for (const file of files) {
      const path = resolve(directory, file)
      expect(statSync(path).size).toBeLessThanOrEqual(64 * 1024)
      for (const line of readFileSync(path, 'utf8').trimEnd().split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
    }
    if (process.platform !== 'win32') {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
    }
  })

  it('drops records beyond the fixed queue bound', async () => {
    const stateDirectory = temporaryStateDirectory()
    const log = new AgentDiagnosticLog(stateDirectory, {
      maximumQueuedRecords: 4,
      pid: 42
    })

    for (let index = 0; index < 20; index += 1) {
      log.tryRecord('daemon.ready', {
        daemonBootId: `boot-${index}`
      })
    }
    await log.flush()

    expect(log.read().map((record) => record.daemonBootId)).toEqual([
      'boot-0',
      'boot-1',
      'boot-2',
      'boot-3'
    ])
  })

  it('serializes independent process writers without a size cache', async () => {
    const stateDirectory = temporaryStateDirectory()
    const daemonLog = new AgentDiagnosticLog(stateDirectory, {
      pid: 42
    })
    const attachLog = new AgentDiagnosticLog(stateDirectory, {
      pid: 43
    })

    daemonLog.tryRecord('daemon.ready', {
      daemonBootId: 'daemon-boot'
    })
    attachLog.tryRecord('detached.spawned')
    await Promise.all([daemonLog.flush(), attachLog.flush()])

    expect(
      readAgentDiagnostics(stateDirectory).map((record) => record.pid).sort()
    ).toEqual([42, 43])
  })

  it('does not touch the disk synchronously from tryRecord', async () => {
    const stateDirectory = temporaryStateDirectory()
    const log = new AgentDiagnosticLog(stateDirectory, {
      pid: 42
    })
    const directory = resolve(
      stateDirectory,
      AGENT_DIAGNOSTIC_DIRECTORY_NAME
    )

    log.tryRecord('connection.attached')

    expect(existsSync(directory)).toBe(false)
    await log.flush()
    expect(existsSync(directory)).toBe(true)
  })

  it('isolates asynchronous write failures from runtime callers', async () => {
    const root = temporaryStateDirectory()
    const unavailableStateDirectory = resolve(root, 'missing-state')
    const log = new AgentDiagnosticLog(unavailableStateDirectory, {
      pid: 42
    })
    let runtimeContinued = false

    expect(() => {
      log.tryRecord('runtime.start.failed', {
        error: new Error('private failure')
      })
      runtimeContinued = true
    }).not.toThrow()
    await expect(log.flush()).resolves.toBeUndefined()

    expect(runtimeContinued).toBe(true)
  })
})

function temporaryStateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-diagnostics-'))
  temporaryPaths.push(root)
  if (process.platform !== 'win32') {
    chmodSync(root, 0o700)
  }
  return root
}
