import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  LinuxProcessInspector,
  type LinuxProcFileSystem,
  type LinuxProcessIdentity
} from './linux-process-identity'

describe('Linux process identity', () => {
  it('reads only PID, start time, and canonical executable', () => {
    const executablePath = resolve('fixtures', 'runtime', 'node')
    const inspector = new LinuxProcessInspector({
      procRoot: resolve('fixtures', 'proc'),
      fileSystem: procFileSystem({
        executablePath,
        stat: procStat('98765', 'worker ) name')
      })
    })

    expect(inspector.inspect(4242)).toEqual({
      pid: 4242,
      starttime: '98765',
      executablePath
    })
  })

  it('returns absent only for a missing process and rejects malformed proc data', () => {
    expect(
      new LinuxProcessInspector({
        procRoot: resolve('fixtures', 'proc'),
        fileSystem: procFileSystem({
          executablePath: resolve('fixtures', 'node'),
          missingPid: true
        })
      }).inspect(4242)
    ).toBeUndefined()

    expect(() =>
      new LinuxProcessInspector({
        procRoot: resolve('fixtures', 'proc'),
        fileSystem: procFileSystem({
          executablePath: resolve('fixtures', 'node'),
          stat: '42 malformed'
        })
      }).inspect(4242)
    ).toThrow()
  })

  it.each([
    ['start time', { starttime: '98766' }],
    ['executable', { executablePath: resolve('fixtures', 'other-node') }]
  ])('refuses an identity with mismatched %s', (_label, change) => {
    const { inspector, identity } = fixtureInspector()
    expect(inspector.matches({ ...identity, ...change })).toBe(false)
  })

  it('signals only an exact process identity and handles ESRCH', () => {
    const { inspector, identity, kill } = fixtureInspector()
    expect(inspector.signal(identity, 'SIGTERM')).toBe(true)
    expect(kill).toHaveBeenCalledWith(identity.pid, 'SIGTERM')
    kill.mockClear()

    expect(
      inspector.signal({ ...identity, starttime: '98766' }, 'SIGKILL')
    ).toBe(false)
    expect(kill).not.toHaveBeenCalled()

    const gone = new LinuxProcessInspector({
      procRoot: resolve('fixtures', 'proc'),
      fileSystem: procFileSystem({
        executablePath: identity.executablePath
      }),
      kill: () => {
        throw nodeError('ESRCH')
      }
    })
    expect(gone.signal(identity, 'SIGTERM')).toBe(false)
  })
})

function fixtureInspector(): {
  inspector: LinuxProcessInspector
  identity: LinuxProcessIdentity
  kill: ReturnType<typeof vi.fn<(pid: number, signal: NodeJS.Signals | 0) => void>>
} {
  const executablePath = resolve('fixtures', 'runtime', 'node')
  const kill = vi.fn<(pid: number, signal: NodeJS.Signals | 0) => void>()
  return {
    inspector: new LinuxProcessInspector({
      procRoot: resolve('fixtures', 'proc'),
      fileSystem: procFileSystem({ executablePath }),
      kill
    }),
    identity: {
      pid: 4242,
      starttime: '98765',
      executablePath
    },
    kill
  }
}

function procFileSystem(options: {
  executablePath: string
  stat?: string
  missingPid?: boolean
}): LinuxProcFileSystem {
  return {
    readText(path) {
      if (!path.endsWith('4242\\stat') && !path.endsWith('4242/stat')) {
        throw new Error(`Unexpected proc text read: ${path}`)
      }
      if (options.missingPid) {
        throw nodeError('ENOENT')
      }
      return options.stat ?? procStat('98765')
    },
    readLink(path) {
      if (!path.endsWith('4242\\exe') && !path.endsWith('4242/exe')) {
        throw new Error(`Unexpected proc link read: ${path}`)
      }
      return options.executablePath
    },
    realpath(path) {
      return path
    }
  }
}

function procStat(starttime: string, name = 'agent'): string {
  const fields = ['S']
  while (fields.length < 19) {
    fields.push('0')
  }
  fields.push(starttime, '0')
  return `4242 (${name}) ${fields.join(' ')}\n`
}

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}
