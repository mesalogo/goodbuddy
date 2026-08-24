import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControllerRegistry } from './controller-registry'
import { WorkspaceRegistry } from './workspace-registry'

const temporaryPaths: string[] = []
const linuxIt = process.platform === 'linux' ? it : it.skip

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('WorkspaceRegistry', () => {
  linuxIt('binds ephemeral handles to owner and connection generation', async () => {
    const root = temporaryDirectory()
    const controllers = new ControllerRegistry()
    const owner = controllers.attach('controller-owner')
    const other = controllers.attach('controller-other')
    const registry = workspaceRegistry(controllers)
    const validated = await validate(registry, root, owner)

    await expect(
      registry.get(
        validated.handle.workspaceId,
        validated.handle.generation,
        other
      )
    ).rejects.toMatchObject({ code: 'not-owner' })

    controllers.disconnect(owner.controllerId, owner.generation)
    const replacement = controllers.attach(owner.controllerId)
    await expect(
      registry.resume(
        {
          workspaceId: validated.handle.workspaceId,
          generation: validated.handle.generation,
          workspaceIdentity: validated.handle.workspaceIdentity
        },
        replacement
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
    await expect(
      registry.open(
        {
          workspaceIdentity: validated.handle.workspaceIdentity,
          requestedAccess: 'read-only'
        },
        replacement
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
  })

  linuxIt('resolves only a current Workspace lease owned by the controller', async () => {
    const root = temporaryDirectory()
    const controllers = new ControllerRegistry()
    const owner = controllers.attach('controller-owner')
    const other = controllers.attach('controller-other')
    const registry = workspaceRegistry(controllers)
    const validated = await validate(registry, root, owner)

    await expect(
      registry.getCurrentByIdentity(
        validated.handle.workspaceIdentity,
        owner
      )
    ).resolves.toMatchObject({
      controllerId: owner.controllerId,
      controllerGeneration: owner.generation,
      handle: {
        workspaceIdentity: validated.handle.workspaceIdentity
      }
    })
    await expect(
      registry.getCurrentByIdentity(
        validated.handle.workspaceIdentity,
        other
      )
    ).rejects.toMatchObject({ code: 'not-owner' })

    controllers.disconnect(owner.controllerId, owner.generation)
    const replacement = controllers.attach(owner.controllerId)
    await expect(
      registry.getCurrentByIdentity(
        validated.handle.workspaceIdentity,
        replacement
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
  })

  linuxIt('revokes a validation grant and all handles opened from it', async () => {
    const root = temporaryDirectory()
    const controllers = new ControllerRegistry()
    const controller = controllers.attach('controller-owner')
    const registry = workspaceRegistry(controllers)
    const validated = await validate(registry, root, controller)
    const opened = await registry.open(
      {
        workspaceIdentity: validated.handle.workspaceIdentity,
        requestedAccess: 'read-only'
      },
      controller
    )

    await expect(
      registry.close(
        validated.handle.workspaceId,
        validated.handle.generation,
        controller
      )
    ).resolves.toMatchObject({ closed: true })
    expect(registry.activeHandleCount()).toBe(0)
    await expect(
      registry.get(opened.workspaceId, opened.generation, controller)
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
    await expect(
      registry.open(
        {
          workspaceIdentity: validated.handle.workspaceIdentity,
          requestedAccess: 'read-only'
        },
        controller
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
  })

  linuxIt('enforces read-only policy, caps, and symlink-root rejection', async () => {
    const root = temporaryDirectory()
    const linked = join(tmpdir(), `goodbuddy-linked-${Date.now()}`)
    symlinkSync(root, linked, 'dir')
    temporaryPaths.push(linked)
    const controllers = new ControllerRegistry()
    const controller = controllers.attach('controller-owner')
    const registry = new WorkspaceRegistry({
      controllers,
      maximumControllerHandles: 1,
      inspectGit: async () => 'not-a-repository'
    })
    await expect(
      registry.validate(
        {
          remoteRootPath: root,
          requestedAccess: 'read-write',
          requiredCapabilities: []
        },
        controller
      )
    ).rejects.toMatchObject({ code: 'read-only' })
    await expect(
      registry.validate(
        {
          remoteRootPath: linked,
          requestedAccess: 'read-only',
          requiredCapabilities: []
        },
        controller
      )
    ).rejects.toMatchObject({ code: 'symlink-rejected' })

    const validated = await validate(registry, root, controller)
    await expect(
      registry.open(
        {
          workspaceIdentity: validated.handle.workspaceIdentity,
          requestedAccess: 'read-only'
        },
        controller
      )
    ).rejects.toMatchObject({ code: 'capacity-exceeded' })
  })

  linuxIt('does not mutate workspace or registry storage during validation', async () => {
    const state = temporaryDirectory()
    const root = join(state, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'existing.txt'), 'unchanged')
    const before = readdirSync(root)
    const storagePath = join(state, 'workspaces.json')
    const controllers = new ControllerRegistry()
    const controller = controllers.attach('controller-owner')
    const registry = new WorkspaceRegistry({
      controllers,
      storagePath,
      inspectGit: async () => 'not-a-repository'
    })

    const validated = await validate(registry, root, controller)
    expect(existsSync(storagePath)).toBe(false)
    expect(readdirSync(root)).toEqual(before)
    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe(
      'unchanged'
    )

    await registry.close(
      validated.handle.workspaceId,
      validated.handle.generation,
      controller
    )
    expect(existsSync(storagePath)).toBe(false)
  })

  linuxIt('leaves no grant when validation is cancelled', async () => {
    const state = temporaryDirectory()
    const root = join(state, 'workspace')
    mkdirSync(root)
    const storagePath = join(state, 'workspaces.json')
    const controllers = new ControllerRegistry()
    const controller = controllers.attach('controller-owner')
    const abort = new AbortController()
    let releaseInspection: ((value: 'not-a-repository') => void) | undefined
    let markInspectionStarted: (() => void) | undefined
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve
    })
    const registry = new WorkspaceRegistry({
      controllers,
      storagePath,
      inspectGit: async () => {
        markInspectionStarted?.()
        return await new Promise<'not-a-repository'>((resolve) => {
          releaseInspection = resolve
        })
      }
    })

    const pending = validate(registry, root, controller, {
      signal: abort.signal
    })
    await inspectionStarted
    abort.abort(new Error('cancelled'))
    releaseInspection?.('not-a-repository')

    await expect(pending).rejects.toThrow('cancelled')
    expect(registry.activeHandleCount()).toBe(0)
    expect(existsSync(storagePath)).toBe(false)
  })

  linuxIt('requires path revalidation after daemon restart', async () => {
    const state = temporaryDirectory()
    const root = join(state, 'workspace')
    mkdirSync(root)
    const storagePath = join(state, 'workspaces.json')
    const firstControllers = new ControllerRegistry()
    const firstController = firstControllers.attach('controller-owner')
    const firstRegistry = new WorkspaceRegistry({
      controllers: firstControllers,
      storagePath,
      inspectGit: async () => 'not-a-repository'
    })
    const first = await validate(firstRegistry, root, firstController)
    firstRegistry.closeAll()

    const replacementControllers = new ControllerRegistry()
    const replacement = replacementControllers.attach('controller-owner')
    const replacementRegistry = new WorkspaceRegistry({
      controllers: replacementControllers,
      storagePath,
      inspectGit: async () => 'not-a-repository'
    })
    await expect(
      replacementRegistry.resume(
        {
          workspaceId: first.handle.workspaceId,
          generation: first.handle.generation,
          workspaceIdentity: first.handle.workspaceIdentity
        },
        replacement
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
    await expect(
      replacementRegistry.open(
        {
          workspaceIdentity: first.handle.workspaceIdentity,
          requestedAccess: 'read-only'
        },
        replacement
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })

    const revalidated = await validate(
      replacementRegistry,
      root,
      replacement
    )
    expect(revalidated.handle.workspaceIdentity).toBe(
      first.handle.workspaceIdentity
    )
    expect(revalidated.handle.workspaceId).not.toBe(
      first.handle.workspaceId
    )
  })

  it('clears legacy persisted roots and never authorizes them', async () => {
    const state = temporaryDirectory()
    const root = join(state, 'workspace')
    mkdirSync(root)
    const storagePath = join(state, 'workspaces.json')
    writeFileSync(
      storagePath,
      JSON.stringify({
        version: 1,
        roots: [
          {
            canonicalPath: root,
            device: '1',
            inode: '2',
            workspaceIdentity: 'workspace-legacy',
            git: 'not-a-repository',
            trustAttestationRevision: 1,
            authorizedControllers: ['controller-owner']
          }
        ],
        leases: [
          {
            handle: {
              workspaceId: 'workspace-legacy-handle',
              workspaceIdentity: 'workspace-legacy',
              canonicalDisplayPath: root,
              access: 'read-only',
              git: 'not-a-repository',
              capabilities: ['list', 'stat', 'read-text', 'search'],
              generation: 1
            },
            controllerId: 'controller-owner',
            controllerGeneration: controllerGenerationForLegacyFixture
          }
        ]
      }),
      { mode: 0o600 }
    )
    const controllers = new ControllerRegistry()
    const controller = controllers.attach('controller-owner')
    const registry = new WorkspaceRegistry({
      controllers,
      storagePath,
      inspectGit: async () => 'not-a-repository'
    })

    expect(JSON.parse(readFileSync(storagePath, 'utf8'))).toEqual({
      version: 2,
      authorization: 'ephemeral'
    })
    await expect(
      registry.open(
        {
          workspaceIdentity: 'workspace-legacy',
          requestedAccess: 'read-only'
        },
        controller
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
    await expect(
      registry.resume(
        {
          workspaceId: 'workspace-legacy-handle',
          workspaceIdentity: 'workspace-legacy',
          generation: 1
        },
        controller
      )
    ).rejects.toMatchObject({ code: 'workspace-not-found' })
    expect(registry.activeHandleCount()).toBe(0)
  })
})

function workspaceRegistry(
  controllers: ControllerRegistry
): WorkspaceRegistry {
  return new WorkspaceRegistry({
    controllers,
    inspectGit: async () => 'not-a-repository'
  })
}

const controllerGenerationForLegacyFixture = 1

async function validate(
  registry: WorkspaceRegistry,
  root: string,
  controller: ReturnType<ControllerRegistry['attach']>,
  options: { signal?: AbortSignal } = {}
) {
  return await registry.validate(
    {
      remoteRootPath: root,
      requestedAccess: 'read-only',
      requiredCapabilities: []
    },
    controller,
    options
  )
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-registry-'))
  temporaryPaths.push(path)
  return path
}
