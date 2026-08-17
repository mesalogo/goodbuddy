import { Readable } from 'node:stream'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { UtilityProcess } from 'electron'
import { isDeepSeekHarnessCompatibleBaseUrl } from '../../shared/deepseek-harness-compatibility'
import type {
  DeepSeekHarnessChild,
  DeepSeekHarnessLaunchOptions
} from './deepseek-harness-runtime'
import { createDeepSeekHarnessUtilityChild } from './deepseek-harness-utility-transport'
import {
  controlledHarnessHostConfigSchema,
  DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
  DEEPSEEK_HARNESS_CONTROL_VERSION,
  DEEPSEEK_HARNESS_CREDENTIAL_REF,
  DEEPSEEK_HARNESS_HOST_VERSION,
  DEEPSEEK_HARNESS_MAX_FRAME_BYTES,
  deepSeekHarnessStartupBudget,
  parseHarnessControlMessage,
  type DeepSeekHarnessControlMessage as HarnessControlMessage
} from './deepseek-harness-control-protocol'

export {
  controlledHarnessHostConfigSchema,
  DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
  DEEPSEEK_HARNESS_CONTROL_VERSION,
  DEEPSEEK_HARNESS_CREDENTIAL_REF,
  DEEPSEEK_HARNESS_HOST_VERSION,
  DEEPSEEK_HARNESS_MAX_FRAME_BYTES,
  parseHarnessControlMessage
} from './deepseek-harness-control-protocol'
export type {
  ControlledHarnessBootstrapConfig,
  DeepSeekHarnessControlMessage
} from './deepseek-harness-control-protocol'

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
  onExtensionStartupFailures?: (
    extensionIds: readonly string[]
  ) => Promise<void>
  /**
   * Explicit hard Host-handshake deadline. Callers that also set the Runtime
   * initialization timeout must leave enough additional time for startup
   * failure persistence.
   */
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
    const canonicalExtensionPackages = await Promise.all(
      options.extensionPackages.map(async (extension) => {
        const entrypoint = await realpath(extension.entrypoint)
        const metadata = await stat(entrypoint)
        if (!metadata.isFile()) {
          throw new Error(
            'DeepSeek Harness 插件入口必须为文件'
          )
        }
        return {
          ...extension,
          entrypoint
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
      launcherOptions.startupTimeoutMs ??
      deepSeekHarnessStartupBudget(
        canonicalExtensionPackages.length
      ).hostTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
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
          if (settled) {
            return
          }
          settled = true
          cleanup()
          terminate()
          reject(error)
        }
        const succeed = (): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          resolve()
        }
        const onMessage = (message: unknown): void => {
          const control = parseHarnessControlMessage(message)
          if (!control) {
            fail(new Error('DeepSeek Harness Host 启动协议无效'))
            return
          }
          if (control.type === 'ready') {
            utility.removeListener('message', onMessage)
            if (timer) {
              clearTimeout(timer)
              timer = undefined
            }
            void (
              control.failedExtensionIds.length > 0
                ? launcherOptions.onExtensionStartupFailures?.(
                    control.failedExtensionIds
                  ) ?? Promise.resolve()
                : Promise.resolve()
            ).then(succeed, (error: unknown) => {
              fail(
                error instanceof Error
                  ? error
                  : new Error(
                      'DeepSeek Harness 插件失败状态保存失败'
                    )
              )
            })
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
          supportsImageInput: options.supportsImageInput,
          harnessVersion: DEEPSEEK_HARNESS_HOST_VERSION,
          credentialRefs: [DEEPSEEK_HARNESS_CREDENTIAL_REF],
          skillPackages: canonicalSkillPackages,
          extensionPackages: canonicalExtensionPackages,
          maxFrameBytes: DEEPSEEK_HARNESS_MAX_FRAME_BYTES
        })
        utility.postMessage({
          protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
          version: DEEPSEEK_HARNESS_CONTROL_VERSION,
          type: 'start',
          config
        } satisfies HarnessControlMessage)
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
