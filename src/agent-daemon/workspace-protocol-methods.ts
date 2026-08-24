import {
  remoteGitDiffRequestSchema,
  remoteGitDiffResultSchema,
  remoteGitStatusRequestSchema,
  remoteGitStatusResultSchema,
  remoteWorkspaceCloseRequestSchema,
  remoteWorkspaceCloseResultSchema,
  remoteWorkspaceListRequestSchema,
  remoteWorkspaceListResultSchema,
  remoteWorkspaceOpenRequestSchema,
  remoteWorkspaceOpenResultSchema,
  remoteWorkspaceReadTextRequestSchema,
  remoteWorkspaceReadTextResultSchema,
  remoteWorkspaceResumeRequestSchema,
  remoteWorkspaceResumeResultSchema,
  remoteWorkspaceSearchRequestSchema,
  remoteWorkspaceSearchResultSchema,
  remoteWorkspaceStatRequestSchema,
  remoteWorkspaceStatResultSchema,
  remoteWorkspaceValidateRequestSchema,
  remoteWorkspaceValidateResultSchema
} from '../shared/remote-agent-contracts'
import type {
  ProtocolMethodContext,
  ProtocolMethodHandler
} from './protocol-server'
import type { WorkspaceGitService } from './workspace-git-service'
import type { WorkspaceRegistry } from './workspace-registry'
import {
  WorkspaceServiceError,
  type WorkspaceIoOptions
} from './workspace-path-access'

const DEFAULT_WORKSPACE_REQUEST_TIMEOUT_MS = 30_000
const MAXIMUM_WORKSPACE_REQUEST_TIMEOUT_MS = 120_000

export const WORKSPACE_PROTOCOL_METHODS = [
  'workspace/validate',
  'workspace/open',
  'workspace/resume',
  'workspace/close',
  'workspace/list',
  'workspace/stat',
  'workspace/readText',
  'workspace/search',
  'git/status',
  'git/diff',
  'workspace/writeTextAtomic',
  'workspace/applyChangeSet',
  'git/operation'
] as const

export type WorkspaceProtocolMethodMap = Readonly<
  Record<(typeof WORKSPACE_PROTOCOL_METHODS)[number], ProtocolMethodHandler>
>

export function createWorkspaceProtocolMethods(options: {
  workspaces: WorkspaceRegistry
  git: WorkspaceGitService
  requestTimeoutMs?: number
}): WorkspaceProtocolMethodMap {
  const timeoutMs = boundedTimeout(
    options.requestTimeoutMs ??
      DEFAULT_WORKSPACE_REQUEST_TIMEOUT_MS
  )
  const boundConnectionSignals = new WeakSet<AbortSignal>()
  const invoke = async <T>(
    context: ProtocolMethodContext,
    action: (io: WorkspaceIoOptions) => Promise<T>
  ): Promise<T> => {
    bindControllerLifetime(
      options.workspaces,
      context,
      boundConnectionSignals
    )
    return await withDeadline(timeoutMs, action, context.signal)
  }

  return {
    'workspace/validate': async (params, context) =>
      await invoke(context, async (io) =>
        remoteWorkspaceValidateResultSchema.parse(
          await options.workspaces.validate(
            remoteWorkspaceValidateRequestSchema.parse(params),
            context.controller,
            io
          )
        )
      ),
    'workspace/open': async (params, context) =>
      await invoke(context, async (io) =>
        remoteWorkspaceOpenResultSchema.parse(
          await options.workspaces.open(
            remoteWorkspaceOpenRequestSchema.parse(params),
            context.controller,
            io
          )
        )
      ),
    'workspace/resume': async (params, context) =>
      await invoke(context, async (io) =>
        remoteWorkspaceResumeResultSchema.parse(
          await options.workspaces.resume(
            remoteWorkspaceResumeRequestSchema.parse(params),
            context.controller,
            io
          )
        )
      ),
    'workspace/close': async (params, context) => {
      const request = remoteWorkspaceCloseRequestSchema.parse(params)
      return await invoke(context, async () =>
        remoteWorkspaceCloseResultSchema.parse(
          await options.workspaces.close(
            request.workspaceId,
            request.generation,
            context.controller
          )
        )
      )
    },
    'workspace/list': async (params, context) => {
      const request = remoteWorkspaceListRequestSchema.parse(params)
      return await invoke(context, async (io) => {
        const workspace = await options.workspaces.get(
          request.workspaceId,
          request.generation,
          context.controller,
          io
        )
        return remoteWorkspaceListResultSchema.parse(
          await workspace.access.list(request, io)
        )
      })
    },
    'workspace/stat': async (params, context) => {
      const request = remoteWorkspaceStatRequestSchema.parse(params)
      return await invoke(context, async (io) => {
        const workspace = await options.workspaces.get(
          request.workspaceId,
          request.generation,
          context.controller,
          io
        )
        return remoteWorkspaceStatResultSchema.parse(
          await workspace.access.stat(request.relativePath, io)
        )
      })
    },
    'workspace/readText': async (params, context) => {
      const request = remoteWorkspaceReadTextRequestSchema.parse(params)
      return await invoke(context, async (io) => {
        const workspace = await options.workspaces.get(
          request.workspaceId,
          request.generation,
          context.controller,
          io
        )
        return remoteWorkspaceReadTextResultSchema.parse(
          await workspace.access.readText(request, io)
        )
      })
    },
    'workspace/search': async (params, context) => {
      const request = remoteWorkspaceSearchRequestSchema.parse(params)
      return await invoke(context, async (io) => {
        const workspace = await options.workspaces.get(
          request.workspaceId,
          request.generation,
          context.controller,
          io
        )
        return remoteWorkspaceSearchResultSchema.parse(
          await workspace.access.search(request, io)
        )
      })
    },
    'git/status': async (params, context) => {
      const request = remoteGitStatusRequestSchema.parse(params)
      return await invoke(context, async (io) => {
        const workspace = await options.workspaces.get(
          request.workspaceId,
          request.generation,
          context.controller,
          io
        )
        assertGitAvailable(workspace.handle.git)
        return remoteGitStatusResultSchema.parse(
          await options.git.status(workspace.access, request, io)
        )
      })
    },
    'git/diff': async (params, context) => {
      const request = remoteGitDiffRequestSchema.parse(params)
      return await invoke(context, async (io) => {
        const workspace = await options.workspaces.get(
          request.workspaceId,
          request.generation,
          context.controller,
          io
        )
        assertGitAvailable(workspace.handle.git)
        return remoteGitDiffResultSchema.parse(
          await options.git.diff(workspace.access, request, io)
        )
      })
    },
    'workspace/writeTextAtomic': readOnlyUnavailable,
    'workspace/applyChangeSet': readOnlyUnavailable,
    'git/operation': readOnlyUnavailable
  }
}

function bindControllerLifetime(
  workspaces: WorkspaceRegistry,
  context: ProtocolMethodContext,
  boundSignals: WeakSet<AbortSignal>
): void {
  const signal = context.signal
  if (signal === undefined || boundSignals.has(signal)) {
    return
  }
  boundSignals.add(signal)
  const closeController = (): void => {
    workspaces.closeController(context.controller)
  }
  if (signal.aborted) {
    closeController()
  } else {
    signal.addEventListener('abort', closeController, { once: true })
  }
}

async function readOnlyUnavailable(): Promise<never> {
  throw new WorkspaceServiceError(
    'Remote workspace mutation is unavailable in this read-only service',
    'read-only'
  )
}

function assertGitAvailable(
  availability: 'available' | 'not-a-repository' | 'unavailable'
): void {
  if (availability !== 'available') {
    throw new WorkspaceServiceError(
      availability === 'not-a-repository'
        ? 'Workspace is not a Git repository'
        : 'Git read service is unavailable',
      'git-unavailable'
    )
  }
}

async function withDeadline<T>(
  timeoutMs: number,
  action: (options: WorkspaceIoOptions) => Promise<T>,
  upstreamSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  const abortFromUpstream = (): void => {
    controller.abort(
      new WorkspaceServiceError(
        'Workspace operation was aborted',
        'aborted'
      )
    )
  }
  if (upstreamSignal?.aborted === true) {
    abortFromUpstream()
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, {
      once: true
    })
  }
  const deadlineAt = Date.now() + timeoutMs
  const timer = setTimeout(() => {
    controller.abort(
      new WorkspaceServiceError(
        'Workspace operation deadline exceeded',
        'deadline-exceeded'
      )
    )
  }, timeoutMs)
  timer.unref()
  try {
    const result = await action({
      signal: controller.signal,
      deadlineAt
    })
    if (controller.signal.aborted) {
      throw controller.signal.reason
    }
    return result
  } finally {
    clearTimeout(timer)
    upstreamSignal?.removeEventListener('abort', abortFromUpstream)
  }
}

function boundedTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAXIMUM_WORKSPACE_REQUEST_TIMEOUT_MS
  ) {
    throw new RangeError('Invalid workspace request timeout')
  }
  return value
}
