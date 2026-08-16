import { Context, type Fiber } from '@deepseek-ai/cordis'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalBash from '@deepseek-ai/dsh-bash-local'
import LocalPwsh from '@deepseek-ai/dsh-pwsh-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAiLlm from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import {
  GoodBuddyHarnessAttachmentStore
} from './agent/goodbuddy-harness-attachment-store'
import {
  GoodBuddyCredentialProvider,
  GoodBuddyHarnessControlPlane,
  createBoundedAcpStream,
  type GoodBuddyHarnessControlConfig
} from './agent/goodbuddy-harness-control-plane'
import {
  loadControlledHarnessExtensions,
  type ControlledHarnessExtensionPackage
} from './agent/deepseek-harness-extension-loader'
import type { Stream } from '@agentclientprotocol/sdk'
import { isDeepSeekHarnessCompatibleBaseUrl } from '../shared/deepseek-harness-compatibility'
import { DEEPSEEK_HARNESS_MAX_FRAME_BYTES } from './agent/deepseek-harness-control-protocol'

const MAX_DIAGNOSTIC_BYTES = 64 * 1024

export type ControlledHarnessHostConfig = Omit<
  GoodBuddyHarnessControlConfig,
  'stream' | 'skills' | 'execution'
> & {
  workspace: string
  baseUrl: string
  api: 'openai-completions'
  maxFrameBytes?: number
  stream?: Stream
  dshHome: string
  skillPackages: readonly {
    id: string
    directory: string
  }[]
  extensionPackages?: readonly ControlledHarnessExtensionPackage[]
}

export type ControlledHarnessHost = {
  readonly context: Context
  readonly controlPlane: GoodBuddyHarnessControlPlane
  readonly failedExtensionIds: readonly string[]
  readonly extensionFailures: readonly {
    id: string
    message: string
  }[]
  dispose(): Promise<void>
}

export type ControlledHarnessHostStartupCode =
  | 'HOST_PLUGIN_GRAPH_FAILED'
  | 'HOST_CONTROL_PLANE_FAILED'

export class ControlledHarnessHostStartupError extends Error {
  constructor(
    readonly code: ControlledHarnessHostStartupCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = 'ControlledHarnessHostStartupError'
  }
}

type PluginSpec = {
  plugin: Parameters<Context['plugin']>[0]
  config?: unknown
}

function validateHostConfig(
  config: ControlledHarnessHostConfig
): void {
  if (
    config.api !== 'openai-completions' ||
    !isDeepSeekHarnessCompatibleBaseUrl(config.baseUrl)
  ) {
    throw new Error(
      'Controlled Harness requires a secure OpenAI-compatible Chat Completions endpoint'
    )
  }
  if (!config.credentialRefs.length) {
    throw new Error(
      'Controlled Harness requires a Main-side credential reference'
    )
  }
  if (!isAbsolute(config.workspace) || !isAbsolute(config.dshHome)) {
    throw new Error(
      'Controlled Harness requires absolute workspace and home paths'
    )
  }
}

async function canonicalizeHostConfig(
  config: ControlledHarnessHostConfig
): Promise<ControlledHarnessHostConfig> {
  const [workspace, dshHome] = await Promise.all([
    realpath(config.workspace),
    realpath(config.dshHome)
  ])
  const [workspaceMetadata, homeMetadata] = await Promise.all([
    stat(workspace),
    stat(dshHome)
  ])
  if (!workspaceMetadata.isDirectory() || !homeMetadata.isDirectory()) {
    throw new Error(
      'Controlled Harness workspace and home must be directories'
    )
  }
  const skillPackages = await Promise.all(
    config.skillPackages.map(async (skill) => {
      const directory = await realpath(skill.directory)
      const metadata = await stat(directory)
      if (!metadata.isDirectory()) {
        throw new Error(
          'Controlled Harness Skill path must be a directory'
        )
      }
      return { ...skill, directory }
    })
  )
  const extensionPackages = await Promise.all(
    (config.extensionPackages ?? []).map(async (extension) => {
      const entrypoint = await realpath(extension.entrypoint)
      const metadata = await stat(entrypoint)
      if (!metadata.isFile()) {
        throw new Error(
          'Controlled Harness extension entrypoint must be a file'
        )
      }
      return { ...extension, entrypoint }
    })
  )
  return {
    ...config,
    workspace,
    dshHome,
    skillPackages,
    extensionPackages
  }
}

async function loadControlledSkills(
  skillPackages: ControlledHarnessHostConfig['skillPackages']
): Promise<GoodBuddyHarnessControlConfig['skills']> {
  return Promise.all(
    skillPackages.map(async (skill) => {
      const manifest = await readFile(
        join(skill.directory, 'SKILL.md'),
        'utf8'
      )
      if (Buffer.byteLength(manifest, 'utf8') > 2 * 1024 * 1024) {
        throw new Error('Controlled Harness Skill is too large')
      }
      const match =
        /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(
          manifest
        )
      if (!match?.[1] || !match[2]?.trim()) {
        throw new Error('Controlled Harness Skill manifest is invalid')
      }
      const metadata = parseYaml(match[1]) as Record<string, unknown>
      const name =
        typeof metadata.id === 'string'
          ? metadata.id
          : metadata.name
      const description = metadata.description
      if (
        name !== skill.id ||
        typeof name !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
        typeof description !== 'string'
      ) {
        throw new Error('Controlled Harness Skill metadata is invalid')
      }
      return {
        name,
        description: description
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 500),
        content: match[2].trim(),
        directory: skill.directory
      }
    })
  )
}

/**
 * Boots a fixed, programmatic Cordis graph. It never imports app-boot, a
 * profile loader, settings-file, local credentials, persistence, telemetry,
 * web, HMR, marketplace discovery, direct MCP clients, jobs, subagents,
 * hooks, or workflow packages. When the selected model declares image input,
 * the graph adds only a bounded process-local attachment store. The control
 * plane registers Main-selected Skill snapshots, Main-mediated MCP tool
 * proxies, and explicitly enabled extension entrypoints.
 */
export async function startControlledDeepSeekHarnessHost(
  input: ControlledHarnessHostConfig
): Promise<ControlledHarnessHost> {
  validateHostConfig(input)
  const config = await canonicalizeHostConfig(input)
  const skills = await loadControlledSkills(config.skillPackages)
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const ctx = new Context()
  const specs: PluginSpec[] = [
    { plugin: LlmRuntime },
    { plugin: SessionStore },
    ...(config.supportsImageInput
      ? [{ plugin: GoodBuddyHarnessAttachmentStore }]
      : []),
    { plugin: SkillRegistry },
    {
      plugin: SystemPrompt,
      config: {
        persona: '',
        includeHarnessIdentity: false,
        includeRuntimeContext: true
      }
    },
    { plugin: ToolRuntime, config: { mode: 'native' } },
    { plugin: AgentRegistry },
    {
      plugin: GoodBuddyCredentialProvider,
      config: new Set(config.credentialRefs)
    },
    {
      plugin: PiAiLlm,
      config: {
        providers: {
          [config.provider]: {
            apiKeyEnv: config.credentialRefs[0],
            api: config.api,
            baseURL: config.baseUrl,
            models: [
              {
                id: config.model,
                input: config.supportsImageInput
                  ? ['text', 'image']
                  : ['text']
              }
            ]
          }
        }
      }
    },
    { plugin: LocalSubprocess },
    { plugin: LocalFileSystem, config: { cwd: config.workspace } },
    { plugin: ShellEnv, config: { dshHome: config.dshHome } },
    {
      plugin:
        process.platform === 'win32'
          ? LocalPwsh
          : LocalBash,
      config: {
        cwd: config.workspace,
        timeoutMs: 60_000
      }
    },
    { plugin: ToolFs },
    {
      plugin:
        process.platform === 'win32' ? ToolPwsh : ToolBash,
      config: { enableRunInBackground: false }
    },
    { plugin: TokenMeter, config: {} },
    {
      plugin: AgentLoop,
      config: { agents: [], maxParallelToolCalls: 10 }
    }
  ]
  const fibers: Fiber[] = []
  let startupCode: ControlledHarnessHostStartupCode =
    'HOST_PLUGIN_GRAPH_FAILED'
  try {
    for (const spec of specs) {
      fibers.push(
        ctx.plugin(
          spec.plugin,
          ...(spec.config === undefined ? [] : [spec.config])
        )
      )
    }
    await Promise.all(fibers)
    const trustedAskToolDefinitions = new Map(
      ['read']
        .map(
          (name) =>
            [name, ctx.tools.get(name)] as const
        )
        .filter(
          (
            entry
          ): entry is readonly [
            string,
            NonNullable<(typeof entry)[1]>
          ] => entry[1] !== undefined
        )
    )
    const extensions = await loadControlledHarnessExtensions(
      ctx,
      config.extensionPackages ?? []
    )
    const credentialProvider = ctx.credentials
    if (!(credentialProvider instanceof GoodBuddyCredentialProvider)) {
      throw new Error(
        'Controlled Harness credential provider failed to start'
      )
    }
    const attachmentStore = ctx.get('attachments')
    if (
      config.supportsImageInput &&
      !(attachmentStore instanceof GoodBuddyHarnessAttachmentStore)
    ) {
      throw new Error(
        'Controlled Harness attachment store failed to start'
      )
    }
    startupCode = 'HOST_CONTROL_PLANE_FAILED'
    const rawStream =
      config.stream ??
      createBoundedNdJsonStream(
        stdoutStream(),
        stdinStream(),
        config.maxFrameBytes ?? DEEPSEEK_HARNESS_MAX_FRAME_BYTES
      )
    const controlPlane = new GoodBuddyHarnessControlPlane(ctx, {
      ...config,
      skills,
      trustedAskToolDefinitions,
      execution: { mode: 'host' },
      stream: createBoundedAcpStream(
        rawStream,
        config.maxFrameBytes ?? DEEPSEEK_HARNESS_MAX_FRAME_BYTES
      )
    })
    controlPlane.bindCredentialProvider(credentialProvider)
    controlPlane.start()
    return {
      context: ctx,
      controlPlane,
      failedExtensionIds: extensions.failedIds,
      extensionFailures: extensions.failures,
      async dispose() {
        await controlPlane.dispose()
        if (attachmentStore instanceof GoodBuddyHarnessAttachmentStore) {
          attachmentStore.clear()
        }
        await ctx.fiber.dispose()
      }
    }
  } catch (error) {
    await ctx.fiber.dispose().catch(() => undefined)
    if (error instanceof ControlledHarnessHostStartupError) {
      throw error
    }
    throw new ControlledHarnessHostStartupError(startupCode, {
      cause: error
    })
  }
}

export function createBoundedNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  maxFrameBytes: number
): Stream {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  return {
    readable: new ReadableStream({
      async start(controller) {
        const reader = input.getReader()
        let pending = ''
        const emitCompleteFrames = (): void => {
          let newline = pending.indexOf('\n')
          while (newline >= 0) {
            const line = pending.slice(0, newline).trim()
            pending = pending.slice(newline + 1)
            if (
              line &&
              Buffer.byteLength(line, 'utf8') > maxFrameBytes
            ) {
              throw new Error('ACP input frame exceeds safety limit')
            }
            if (line) {
              controller.enqueue(JSON.parse(line))
            }
            newline = pending.indexOf('\n')
          }
          if (Buffer.byteLength(pending, 'utf8') > maxFrameBytes) {
            throw new Error('ACP input frame exceeds safety limit')
          }
        }
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) {
              pending += decoder.decode()
              emitCompleteFrames()
              break
            }
            pending += decoder.decode(value, { stream: true })
            emitCompleteFrames()
          }
          const line = pending.trim()
          if (line) {
            if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
              throw new Error('ACP input frame exceeds safety limit')
            }
            controller.enqueue(JSON.parse(line))
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        } finally {
          reader.releaseLock()
        }
      }
    }),
    writable: new WritableStream({
      async write(message) {
        const serialized = JSON.stringify(message)
        if (
          Buffer.byteLength(serialized, 'utf8') >
          maxFrameBytes
        ) {
          throw new Error('ACP output frame exceeds safety limit')
        }
        const bytes = encoder.encode(`${serialized}\n`)
        const writer = output.getWriter()
        try {
          await writer.write(bytes)
        } finally {
          writer.releaseLock()
        }
      },
      async close() {
        const writer = output.getWriter()
        try {
          await writer.close()
        } finally {
          writer.releaseLock()
        }
      },
      async abort(reason) {
        await output.abort(reason)
      }
    })
  }
}

function stdoutStream(): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (error) =>
          error ? reject(error) : resolve()
        )
      })
    }
  })
}

function stdinStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer) =>
        controller.enqueue(new Uint8Array(chunk))
      )
      process.stdin.once('end', () => controller.close())
      process.stdin.once('error', (error) =>
        controller.error(error)
      )
    }
  })
}

/**
 * Keep diagnostics bounded and protocol-free. Call this in the utility entry
 * before Cordis plugins start; no user content or secret is forwarded.
 */
export function installHarnessDiagnosticGuard(): () => void {
  let bytes = 0
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  }
  const diagnostic = (): void => {
    const line = 'DeepSeek Harness diagnostic suppressed\n'
    const size = Buffer.byteLength(line)
    if (bytes + size <= MAX_DIAGNOSTIC_BYTES) {
      bytes += size
      process.stderr.write(line)
    }
  }
  console.log = diagnostic
  console.info = diagnostic
  console.warn = diagnostic
  console.error = diagnostic
  console.debug = diagnostic
  return () => {
    console.log = original.log
    console.info = original.info
    console.warn = original.warn
    console.error = original.error
    console.debug = original.debug
  }
}
