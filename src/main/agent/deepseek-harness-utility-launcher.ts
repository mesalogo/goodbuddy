import { Readable } from 'node:stream'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { UtilityProcess } from 'electron'
import { z } from 'zod'
import { isDeepSeekHarnessCompatibleBaseUrl } from '../../shared/deepseek-harness-compatibility'
import type {
  DeepSeekHarnessChild,
  DeepSeekHarnessLaunchOptions
} from './deepseek-harness-runtime'
import { createDeepSeekHarnessUtilityChild } from './deepseek-harness-utility-transport'

export const DEEPSEEK_HARNESS_CONTROL_PROTOCOL =
  'goodbuddy.deepseek-harness.control'
export const DEEPSEEK_HARNESS_CONTROL_VERSION = 1
export const DEEPSEEK_HARNESS_HOST_VERSION = '0.1.0-rc.6'
export const DEEPSEEK_HARNESS_CREDENTIAL_REF =
  'GOODBUDDY_HARNESS_MODEL_API_KEY'

const skillPackageSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    directory: z.string().min(1).max(32_768).refine(isAbsolute)
  })
  .strict()

export const controlledHarnessHostConfigSchema = z
  .object({
    workspace: z.string().min(1).max(32_768).refine(isAbsolute),
    dshHome: z.string().min(1).max(32_768).refine(isAbsolute),
    baseUrl: z
      .url()
      .max(2_048)
      .refine(isDeepSeekHarnessCompatibleBaseUrl),
    api: z.literal('openai-completions'),
    provider: z.literal('goodbuddy'),
    model: z.string().min(1).max(128),
    harnessVersion: z.literal(DEEPSEEK_HARNESS_HOST_VERSION),
    credentialRefs: z
      .tuple([z.literal(DEEPSEEK_HARNESS_CREDENTIAL_REF)])
      .readonly(),
    skillPackages: z.array(skillPackageSchema).max(64),
    maxFrameBytes: z.literal(1024 * 1024)
  })
  .strict()

export type ControlledHarnessBootstrapConfig = z.infer<
  typeof controlledHarnessHostConfigSchema
>

export type DeepSeekHarnessControlMessage =
  | {
      protocol: typeof DEEPSEEK_HARNESS_CONTROL_PROTOCOL
      version: typeof DEEPSEEK_HARNESS_CONTROL_VERSION
      type: 'start'
      config: ControlledHarnessBootstrapConfig
    }
  | {
      protocol: typeof DEEPSEEK_HARNESS_CONTROL_PROTOCOL
      version: typeof DEEPSEEK_HARNESS_CONTROL_VERSION
      type: 'ready'
    }
  | {
      protocol: typeof DEEPSEEK_HARNESS_CONTROL_PROTOCOL
      version: typeof DEEPSEEK_HARNESS_CONTROL_VERSION
      type: 'fatal'
      code: string
    }

export function parseHarnessControlMessage(
  value: unknown
): DeepSeekHarnessControlMessage | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    record.protocol !== DEEPSEEK_HARNESS_CONTROL_PROTOCOL ||
    record.version !== DEEPSEEK_HARNESS_CONTROL_VERSION
  ) {
    return undefined
  }
  if (record.type === 'ready' && Object.keys(record).length === 3) {
    return record as DeepSeekHarnessControlMessage
  }
  if (
    record.type === 'fatal' &&
    Object.keys(record).length === 4 &&
    typeof record.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(record.code)
  ) {
    return record as DeepSeekHarnessControlMessage
  }
  if (
    record.type === 'start' &&
    Object.keys(record).length === 4
  ) {
    const parsed = controlledHarnessHostConfigSchema.safeParse(
      record.config
    )
    return parsed.success
      ? ({
          protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
          version: DEEPSEEK_HARNESS_CONTROL_VERSION,
          type: 'start',
          config: parsed.data
        } satisfies DeepSeekHarnessControlMessage)
      : undefined
  }
  return undefined
}

export type DeepSeekHarnessFork = (
  modulePath: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    serviceName: string
    stdio: ['ignore', 'ignore', 'pipe']
  }
) => UtilityProcess

export type DeepSeekHarnessUtilityLauncherOptions = {
  bundledHostPath: string
  dshHome: string
  environment: NodeJS.ProcessEnv
  fork: DeepSeekHarnessFork
  terminateProcess?: (utility: UtilityProcess) => void
  startupTimeoutMs?: number
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f)
    ) {
      return true
    }
  }
  return false
}

export function createDeepSeekHarnessUtilityLauncher(
  launcherOptions: DeepSeekHarnessUtilityLauncherOptions
): (options: DeepSeekHarnessLaunchOptions) => Promise<DeepSeekHarnessChild> {
  return async (options) => {
    options.signal.throwIfAborted()
    const hostPath = launcherOptions.bundledHostPath
    if (!isAbsolute(hostPath)) {
      throw new Error('DeepSeek Harness Host 路径必须为绝对路径')
    }
    if (!isAbsolute(options.cwd) || !isAbsolute(launcherOptions.dshHome)) {
      throw new Error(
        'DeepSeek Harness 工作区和隔离目录必须为绝对路径'
      )
    }
    if (
      options.model.length === 0 ||
      options.model.length > 128 ||
      hasControlCharacter(options.model)
    ) {
      throw new Error('DeepSeek Harness 模型名称无效')
    }
    const canonicalSkillPackages = await Promise.all(
      options.skillPackages.map(async (skill) => {
        const directory = await realpath(skill.directory)
        const metadata = await stat(directory)
        if (!metadata.isDirectory()) {
          throw new Error(
            'DeepSeek Harness Skill 路径必须为目录'
          )
        }
        return {
          id: skill.id,
          directory
        }
      })
    )
    const [canonicalHostPath, canonicalWorkspace, canonicalDshHome] =
      await Promise.all([
        realpath(hostPath),
        realpath(options.cwd),
        realpath(launcherOptions.dshHome)
      ])
    const [hostMetadata, workspaceMetadata, homeMetadata] =
      await Promise.all([
        stat(canonicalHostPath),
        stat(canonicalWorkspace),
        stat(canonicalDshHome)
      ])
    if (
      !hostMetadata.isFile() ||
      !workspaceMetadata.isDirectory() ||
      !homeMetadata.isDirectory()
    ) {
      throw new Error(
        'DeepSeek Harness Host、工作区或隔离目录类型无效'
      )
    }
    if (!isDeepSeekHarnessCompatibleBaseUrl(options.baseUrl)) {
      throw new Error(
        'DeepSeek Harness 模型地址必须使用 HTTPS 或本机回环 HTTP，且不得包含凭据、查询参数或片段'
      )
    }
    if (
      options.credentialRefs.length !== 1 ||
      options.credentialRefs[0] !==
        DEEPSEEK_HARNESS_CREDENTIAL_REF
    ) {
      throw new Error('DeepSeek Harness 凭据引用不受信任')
    }
    options.signal.throwIfAborted()
    const utility = launcherOptions.fork(canonicalHostPath, [], {
      cwd: canonicalWorkspace,
      env: launcherOptions.environment,
      serviceName: 'GoodBuddy DeepSeek Harness Host',
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let terminated = false
    const terminate = (): void => {
      if (terminated) {
        return
      }
      terminated = true
      if (launcherOptions.terminateProcess) {
        launcherOptions.terminateProcess(utility)
      } else {
        utility.kill()
      }
    }
    const startupTimeoutMs =
      launcherOptions.startupTimeoutMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          if (timer) {
            clearTimeout(timer)
          }
          if (onAbort) {
            options.signal.removeEventListener('abort', onAbort)
          }
          utility.removeListener('message', onMessage)
          utility.removeListener('exit', onExit)
        }
        const fail = (error: Error): void => {
          cleanup()
          terminate()
          reject(error)
        }
        const onMessage = (message: unknown): void => {
          const control = parseHarnessControlMessage(message)
          if (!control) {
            fail(new Error('DeepSeek Harness Host 启动协议无效'))
            return
          }
          if (control.type === 'ready') {
            cleanup()
            resolve()
          } else if (control.type === 'fatal') {
            fail(
              new Error(
                `DeepSeek Harness Host 启动失败（${control.code}）`
              )
            )
          }
        }
        const onExit = (exitCode: number): void => {
          fail(
            new Error(
              `DeepSeek Harness Host 启动前退出（code ${exitCode}）`
            )
          )
        }
        onAbort = () => {
          fail(
            options.signal.reason instanceof Error
              ? options.signal.reason
              : new Error('DeepSeek Harness Host 启动已取消')
          )
        }
        utility.on('message', onMessage)
        utility.on('exit', onExit)
        options.signal.addEventListener('abort', onAbort, {
          once: true
        })
        timer = setTimeout(
          () =>
            fail(new Error('DeepSeek Harness Host 启动握手超时')),
          startupTimeoutMs
        )
        const config = controlledHarnessHostConfigSchema.parse({
          workspace: canonicalWorkspace,
          dshHome: canonicalDshHome,
          baseUrl: options.baseUrl,
          api: 'openai-completions',
          provider: 'goodbuddy',
          model: options.model,
          harnessVersion: DEEPSEEK_HARNESS_HOST_VERSION,
          credentialRefs: [DEEPSEEK_HARNESS_CREDENTIAL_REF],
          skillPackages: canonicalSkillPackages,
          maxFrameBytes: 1024 * 1024
        })
        utility.postMessage({
          protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
          version: DEEPSEEK_HARNESS_CONTROL_VERSION,
          type: 'start',
          config
        } satisfies DeepSeekHarnessControlMessage)
      })
      return createDeepSeekHarnessUtilityChild(utility, {
        stderrToWeb: (stderr) =>
          Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
        terminateProcess: terminate
      })
    } catch (error) {
      terminate()
      throw error
    }
  }
}
