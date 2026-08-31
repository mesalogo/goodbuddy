import { describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_LIMITS,
  type TerminalEvent,
  type TerminalSnapshot,
  type TerminalTarget
} from '../../shared/terminal-contracts'
import {
  TerminalSessionManager,
  TerminalSessionManagerError,
  type ManagedTerminalSession,
  type TerminalSessionManagerDependencies
} from './terminal-session-manager'

const projectId = '00000000-0000-4000-8000-000000000601'
const hostId = '00000000-0000-4000-8000-000000000602'

function snapshot(
  sessionId: string,
  target: TerminalTarget,
  workingDirectory = '/home/tester'
): TerminalSnapshot {
  return {
    sessionId,
    target,
    targetLabel: target.type === 'local' ? '本机' : 'Build host',
    title: '终端',
    state: 'running',
    shell: 'bash',
    workingDirectory,
    size: { cols: 80, rows: 24 },
    lastSequence: 1,
    exit: null,
    error: null
  }
}

function fakeSession(
  value: TerminalSnapshot,
  initialEvents: TerminalEvent[] = []
): ManagedTerminalSession & {
  emit(event: TerminalEvent): void
  close: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
} {
  let current = value
  const listeners = new Set<(event: TerminalEvent) => void>()
  return {
    snapshot: () => current,
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    acknowledge: vi.fn(),
    close: vi.fn(async () => {
      current = { ...current, state: 'closing' }
      return current
    }),
    onEvent(listener) {
      listeners.add(listener)
      initialEvents.forEach(listener)
      return () => listeners.delete(listener)
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event)
      }
    }
  }
}

function harness(
  overrides: Partial<TerminalSessionManagerDependencies> = {}
) {
  let nextId = 700
  const delivered: Array<{ ownerId: number; event: TerminalEvent }> = []
  const localSessions: ReturnType<typeof fakeSession>[] = []
  const sshSessions: ReturnType<typeof fakeSession>[] = []
  const createLocalSession = vi.fn(async (options) => {
    const event = {
      sessionId: options.sessionId!,
      sequence: 1,
      type: 'output' as const,
      data: 'prompt'
    }
    const session = fakeSession(
      snapshot(
        options.sessionId!,
        options.target,
        options.projectDirectory ?? '/home/tester'
      ),
      [event]
    )
    localSessions.push(session)
    return session
  })
  const createSshSession = vi.fn(async (_pool, options) => {
    options.onEvent({
      sessionId: options.sessionId,
      sequence: 1,
      type: 'output',
      data: 'remote prompt'
    })
    const session = fakeSession(
      snapshot(
        options.sessionId,
        options.target,
        options.workingDirectory
      )
    )
    sshSessions.push(session)
    return session
  })
  const dependencies = {
    database: {
      getProject: vi.fn(() => ({
        id: projectId,
        name: 'Workspace',
        rootPath: 'legacy',
        executionSpace: { kind: 'local', rootPath: '/authoritative/root' }
      }))
    },
    executionSpaceResolver: {
      resolveProject: vi.fn((project: {
        executionSpace: { kind: 'local'; rootPath: string }
      }) => ({
        kind: 'local' as const,
        rootPath: project.executionSpace.rootPath,
        cacheIdentity: 'local',
        routeIdentity: 'local',
        workspaceAccess: {}
      }))
    },
    targetResolver: {
      resolve: vi.fn(async () => ({
        host: { id: hostId, name: 'Build host' },
        hostRevision: 2,
        hostKeyGeneration: 3
      }))
    },
    sshPool: {} as never,
    remoteEnabled: vi.fn(() => true),
    deliverEvent: vi.fn((ownerId, event) => {
      delivered.push({ ownerId, event })
    }),
    createLocalSession,
    createSshSession,
    createSessionId: () =>
      `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    ...overrides
  } as unknown as TerminalSessionManagerDependencies
  return {
    manager: new TerminalSessionManager(dependencies),
    dependencies,
    delivered,
    localSessions,
    sshSessions,
    createLocalSession,
    createSshSession
  }
}

describe('TerminalSessionManager routing and delivery', () => {
  it('routes Home local and authoritative local project roots', async () => {
    const test = harness()
    const local = await test.manager.create(1, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })
    const project = await test.manager.create(1, {
      target: { type: 'project', projectId },
      cols: 90,
      rows: 30
    })

    expect(local.workingDirectory).toBe('/home/tester')
    expect(project.workingDirectory).toBe('/authoritative/root')
    expect(test.createLocalSession.mock.calls[0]?.[0].projectDirectory)
      .toBeUndefined()
    expect(test.createLocalSession.mock.calls[1]?.[0].projectDirectory)
      .toBe('/authoritative/root')
  })

  it('routes SSH projects to their authoritative remote root', async () => {
    const test = harness()
    vi.mocked(test.dependencies.executionSpaceResolver.resolveProject)
      .mockReturnValue({
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/project',
        cacheIdentity: 'ssh',
        routeIdentity: 'ssh',
        workspaceAccess: {} as never
      })

    const remote = await test.manager.create(1, {
      target: { type: 'project', projectId },
      cols: 80,
      rows: 24
    })

    expect(test.createSshSession.mock.calls[0]?.[1].workingDirectory)
      .toBe('/srv/project')
    expect(remote.workingDirectory).toBe('/srv/project')
    expect(test.dependencies.targetResolver.resolve).toHaveBeenCalledWith(hostId)
  })

  it('gates all remote targets', async () => {
    const test = harness({ remoteEnabled: () => false })
    vi.mocked(test.dependencies.executionSpaceResolver.resolveProject)
      .mockReturnValue({
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/project',
        cacheIdentity: 'ssh',
        routeIdentity: 'ssh',
        workspaceAccess: {} as never
      })
    await expect(test.manager.create(1, {
      target: { type: 'project', projectId },
      cols: 80,
      rows: 24
    })).rejects.toMatchObject({ code: 'target-unavailable' })
    expect(test.createSshSession).not.toHaveBeenCalled()
  })

  it('delays startup events until delivery is explicitly enabled', async () => {
    const test = harness()
    const created = await test.manager.create(7, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })
    expect(test.delivered).toEqual([])

    test.manager.enableEventDelivery(7, created.sessionId)
    expect(test.delivered).toEqual([
      {
        ownerId: 7,
        event: expect.objectContaining({ data: 'prompt', sequence: 1 })
      }
    ])
  })
})

describe('TerminalSessionManager ownership and lifecycle', () => {
  it('revalidates ownership for every session operation', async () => {
    const test = harness()
    const created = await test.manager.create(11, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })
    const calls = [
      () => test.manager.write(12, created.sessionId, 'x'),
      () => test.manager.resize(12, created.sessionId, { cols: 90, rows: 30 }),
      () => test.manager.snapshot(12, created.sessionId),
      () => test.manager.acknowledge(12, created.sessionId, 1),
      () => test.manager.close(12, created.sessionId),
      () => test.manager.enableEventDelivery(12, created.sessionId)
    ]
    for (const call of calls) {
      expect(call).toThrowError(
        expect.objectContaining({ code: 'session-not-found' })
      )
    }
    expect(test.localSessions[0]?.write).not.toHaveBeenCalled()
  })

  it('enforces the per-window limit without affecting another owner', async () => {
    const test = harness()
    for (let index = 0;
      index < TERMINAL_LIMITS.maximumSessionsPerWindow;
      index += 1) {
      await test.manager.create(1, {
        target: { type: 'local' },
        cols: 80,
        rows: 24
      })
    }
    await expect(test.manager.create(1, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })).rejects.toBeInstanceOf(TerminalSessionManagerError)
    await expect(test.manager.create(2, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })).resolves.toBeDefined()
  })

  it('releases closed records and ignores late delivery ACKs', async () => {
    const test = harness()
    const created = await test.manager.create(1, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })
    const first = await test.manager.close(1, created.sessionId)

    expect(first.state).toBe('closing')
    expect(test.localSessions[0]?.close).toHaveBeenCalledTimes(1)
    expect(() =>
      test.manager.acknowledge(1, created.sessionId, 1)
    ).not.toThrow()
    expect(() => test.manager.close(1, created.sessionId))
      .toThrowError(expect.objectContaining({ code: 'session-not-found' }))
    expect(() => test.manager.write(1, created.sessionId, 'late'))
      .toThrowError(expect.objectContaining({ code: 'session-not-found' }))
    expect(() => test.manager.resize(
      1,
      created.sessionId,
      { cols: 100, rows: 40 }
    )).toThrowError(expect.objectContaining({
      code: 'session-not-found'
    }))

    await expect(test.manager.create(1, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })).resolves.toBeDefined()
  })

  it('closes only one owner and disposes all sessions idempotently', async () => {
    const test = harness()
    const first = await test.manager.create(1, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })
    const second = await test.manager.create(2, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })

    await test.manager.closeOwner(1)
    expect(() => test.manager.snapshot(1, first.sessionId))
      .toThrowError(expect.objectContaining({ code: 'session-not-found' }))
    expect(test.manager.snapshot(2, second.sessionId).state).toBe('running')

    await Promise.all([test.manager.dispose(), test.manager.dispose()])
    expect(test.localSessions[0]?.close).toHaveBeenCalledTimes(1)
    expect(test.localSessions[1]?.close).toHaveBeenCalledTimes(1)
    await expect(test.manager.create(2, {
      target: { type: 'local' },
      cols: 80,
      rows: 24
    })).rejects.toMatchObject({ code: 'internal-error' })
  })
})
