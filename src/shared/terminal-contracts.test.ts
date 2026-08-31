import { describe, expect, it } from 'vitest'
import {
  TERMINAL_LIMITS,
  terminalAckRequestSchema,
  terminalCreateRequestSchema,
  terminalEventSchema,
  terminalResizeRequestSchema,
  terminalSnapshotSchema,
  terminalWriteRequestSchema
} from './terminal-contracts'

const sessionId = '00000000-0000-4000-8000-000000000101'
const projectId = '00000000-0000-4000-8000-000000000201'

describe('terminal contracts', () => {
  it('accepts bounded create, write, resize, snapshot, event, and ACK data', () => {
    expect(
      terminalCreateRequestSchema.parse({
        target: { type: 'project', projectId },
        cols: 120,
        rows: 30
      })
    ).toEqual({
      target: { type: 'project', projectId },
      cols: 120,
      rows: 30
    })
    expect(
      terminalWriteRequestSchema.parse({ sessionId, data: '你好\r' })
    ).toEqual({ sessionId, data: '你好\r' })
    expect(
      terminalResizeRequestSchema.parse({
        sessionId,
        cols: 80,
        rows: 24
      })
    ).toBeTruthy()
    expect(
      terminalSnapshotSchema.parse({
        sessionId,
        target: { type: 'project', projectId },
        targetLabel: '构建主机',
        title: '终端 · 构建主机 1',
        state: 'running',
        shell: 'bash',
        workingDirectory: '/home/builder',
        size: { cols: 120, rows: 30 },
        lastSequence: 3,
        exit: null,
        error: null
      })
    ).toBeTruthy()
    expect(
      terminalEventSchema.parse({
        type: 'output',
        sessionId,
        sequence: 4,
        data: '\u001b[32mdone\u001b[0m\r\n'
      })
    ).toBeTruthy()
    expect(
      terminalAckRequestSchema.parse({ sessionId, sequence: 4 })
    ).toEqual({ sessionId, sequence: 4 })
  })

  it('uses UTF-8 byte limits for input and output chunks', () => {
    expect(
      terminalWriteRequestSchema.safeParse({
        sessionId,
        data: '界'.repeat(
          Math.floor(TERMINAL_LIMITS.maximumInputBytes / 3)
        )
      }).success
    ).toBe(true)
    expect(
      terminalWriteRequestSchema.safeParse({
        sessionId,
        data: '界'.repeat(
          Math.floor(TERMINAL_LIMITS.maximumInputBytes / 3) + 1
        )
      }).success
    ).toBe(false)
    expect(
      terminalEventSchema.safeParse({
        type: 'output',
        sessionId,
        sequence: 1,
        data: 'x'.repeat(TERMINAL_LIMITS.maximumEventBytes + 1)
      }).success
    ).toBe(false)
  })

  it('enforces session, sequence, and terminal dimension boundaries', () => {
    for (const size of [
      { cols: TERMINAL_LIMITS.minimumColumns - 1, rows: 24 },
      { cols: TERMINAL_LIMITS.maximumColumns + 1, rows: 24 },
      { cols: 80, rows: TERMINAL_LIMITS.minimumRows - 1 },
      { cols: 80, rows: TERMINAL_LIMITS.maximumRows + 1 },
      { cols: 80.5, rows: 24 }
    ]) {
      expect(
        terminalResizeRequestSchema.safeParse({
          sessionId,
          ...size
        }).success
      ).toBe(false)
    }
    expect(
      terminalWriteRequestSchema.safeParse({
        sessionId: 'renderer-selected-pid-123',
        data: 'pwd\r'
      }).success
    ).toBe(false)
    expect(
      terminalEventSchema.safeParse({
        type: 'state',
        sessionId,
        sequence: 0,
        state: 'running'
      }).success
    ).toBe(false)
    expect(
      terminalAckRequestSchema.safeParse({
        sessionId,
        sequence: -1
      }).success
    ).toBe(false)
  })

  it('strictly rejects shell, path, command, environment, and credentials', () => {
    for (const extra of [
      { shell: 'C:\\custom\\shell.exe' },
      { cwd: 'C:\\private' },
      { command: 'curl example.invalid' },
      { environment: { MODEL_API_KEY: 'secret' } },
      { password: 'secret' },
      { privateKey: 'secret' },
      { pid: 42 }
    ]) {
      expect(
        terminalCreateRequestSchema.safeParse({
          target: { type: 'local' },
          cols: 80,
          rows: 24,
          ...extra
        }).success
      ).toBe(false)
    }
    expect(
      terminalCreateRequestSchema.safeParse({
        target: {
          type: 'project',
          projectId,
          hostname: 'host.internal',
          username: 'builder'
        },
        cols: 80,
        rows: 24
      }).success
    ).toBe(false)
  })

  it('requires coherent exited snapshots and strict event variants', () => {
    const snapshot = {
      sessionId,
      target: { type: 'local' },
      targetLabel: '本机',
      title: '终端 · 本机 1',
      state: 'exited',
      shell: 'PowerShell 7',
      workingDirectory: 'C:\\Users\\tester',
      size: { cols: 80, rows: 24 },
      lastSequence: 2,
      exit: null,
      error: null
    } as const
    expect(terminalSnapshotSchema.safeParse(snapshot).success).toBe(false)
    expect(
      terminalSnapshotSchema.safeParse({
        ...snapshot,
        exit: { exitCode: 0, signal: null }
      }).success
    ).toBe(true)
    expect(
      terminalEventSchema.safeParse({
        type: 'output',
        sessionId,
        sequence: 1,
        data: 'ok',
        state: 'running'
      }).success
    ).toBe(false)
  })
})
