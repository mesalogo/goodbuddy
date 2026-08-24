import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControllerRegistry } from './controller-registry'
import { WorkspaceGitService } from './workspace-git-service'
import { createWorkspaceProtocolMethods } from './workspace-protocol-methods'
import { WorkspaceRegistry } from './workspace-registry'

const temporaryPaths: string[] = []
const linuxIt = process.platform === 'linux' ? it : it.skip

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('workspace protocol methods', () => {
  linuxIt('registers typed reads and typed read-only failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-methods-'))
    temporaryPaths.push(root)
    writeFileSync(join(root, 'hello.txt'), 'hello')
    const controllers = new ControllerRegistry()
    const controller = controllers.attach('controller-test')
    const git = new WorkspaceGitService({
      gitExecutable: '/bin/false'
    })
    const workspaces = new WorkspaceRegistry({
      controllers,
      inspectGit: async () => 'not-a-repository'
    })
    const methods = createWorkspaceProtocolMethods({
      workspaces,
      git,
      requestTimeoutMs: 1_000
    })
    const context = { controller, channelId: 'channel-test' }
    const validated = (await methods['workspace/validate'](
      {
        remoteRootPath: root,
        requestedAccess: 'read-only',
        requiredCapabilities: ['read-text']
      },
      context
    )) as {
      handle: {
        workspaceId: string
        generation: number
      }
    }
    await expect(
      methods['workspace/readText'](
        {
          workspaceId: validated.handle.workspaceId,
          generation: validated.handle.generation,
          relativePath: 'hello.txt',
          offsetBytes: 0,
          maximumBytes: 100
        },
        context
      )
    ).resolves.toMatchObject({ content: 'hello' })
    await expect(
      methods['workspace/writeTextAtomic']({}, context)
    ).rejects.toMatchObject({ code: 'read-only' })
    await expect(
      methods['git/operation']({}, context)
    ).rejects.toMatchObject({ code: 'read-only' })
  })

  linuxIt('revokes all connection grants when the connection closes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-methods-'))
    temporaryPaths.push(root)
    writeFileSync(join(root, 'hello.txt'), 'hello')
    const controllers = new ControllerRegistry()
    const controller = controllers.attach('controller-test')
    const workspaces = new WorkspaceRegistry({
      controllers,
      inspectGit: async () => 'not-a-repository'
    })
    const methods = createWorkspaceProtocolMethods({
      workspaces,
      git: new WorkspaceGitService({ gitExecutable: '/bin/false' })
    })
    const connection = new AbortController()
    const context = {
      controller,
      channelId: 'channel-test',
      signal: connection.signal
    }
    const validated = (await methods['workspace/validate'](
      {
        remoteRootPath: root,
        requestedAccess: 'read-only',
        requiredCapabilities: []
      },
      context
    )) as {
      handle: {
        workspaceId: string
        workspaceIdentity: string
        generation: number
      }
    }
    const opened = (await methods['workspace/open'](
      {
        workspaceIdentity: validated.handle.workspaceIdentity,
        requestedAccess: 'read-only'
      },
      context
    )) as {
      workspaceId: string
      generation: number
    }
    expect(workspaces.activeHandleCount()).toBe(2)

    connection.abort()

    expect(workspaces.activeHandleCount()).toBe(0)
    await expect(
      workspaces.get(
        opened.workspaceId,
        opened.generation,
        controller
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
  })
})
