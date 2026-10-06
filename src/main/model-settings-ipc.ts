import { dialog, shell, type BrowserWindow, type ipcMain } from 'electron'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import {
  modelProfileIdSchema,
  runtimeConfigActionInputSchema,
  runtimeCustomizationSettingsSchema,
  runtimeFileSelectionKindSchema,
  runtimeNativeSnapshotInputSchema,
  runtimeNativeSnapshotSchema,
  runtimeSettingsInputSchema,
  type AgentRuntimeDetection,
  type RuntimeSettings
} from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'
import {
  agentRuntimeSelectionSchema,
  type AgentRuntimeSelection
} from '../shared/runtime-selection-contracts'
import {
  bundledContinueVersion,
  bundledDeepSeekHarnessVersion,
  type BundledRuntimePaths
} from './agent/bundled-runtimes'
import { createModelProfileRuntime } from './agent/create-runtime'
import type { AgentRuntime } from './agent/runtime'
import { detectAgentRuntimes } from './agent/runtime-discovery'
import type { SelectedRuntimeResolver } from './agent/selected-runtime-manager'
import type { ExecutionSpaceResolver } from './execution-space'
import type { RuntimeSettingsStore } from './runtime-settings-store'
import { assertTrustedSender } from './trusted-ipc-sender'

const runtimeConfigFileMetadata = {
  opencode: {
    filterName: 'OpenCode 配置',
    filterExtensions: ['json', 'jsonc'],
    allowedExtensions: new Set<string>(['.json', '.jsonc'])
  },
  continue: {
    filterName: 'Continue 配置',
    filterExtensions: ['yaml', 'yml', 'json', 'jsonc'],
    allowedExtensions: new Set<string>([
      '.yaml',
      '.yml',
      '.json',
      '.jsonc'
    ])
  }
} as const

function getRuntimeConfigDirectory(
  runtime: 'opencode' | 'continue'
): string {
  if (runtime === 'continue') {
    return join(homedir(), '.continue')
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
  const configHome =
    xdgConfigHome && isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : join(homedir(), '.config')
  return join(configHome, 'opencode')
}

async function activateOrRollback<T>(input: {
  previous: T
  persistCandidate(): Promise<T>
  activate(): Promise<void>
  persistPrevious(previous: T): Promise<unknown>
}): Promise<T> {
  const saved = await input.persistCandidate()
  try {
    await input.activate()
    return saved
  } catch (activationError) {
    try {
      await input.persistPrevious(input.previous)
      await input.activate()
    } catch (rollbackError) {
      throw new AggregateError(
        [activationError, rollbackError],
        'Runtime 配置激活失败，且回滚未能完成',
        { cause: rollbackError }
      )
    }
    throw activationError
  }
}

export function registerModelSettingsIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow,
  {
    settingsStore,
    runtime,
    selectedRuntimes,
    bundledRuntimePaths,
    enqueueRuntimeSettingsUpdate,
    onRuntimeSettingsChanged,
    repairRuntimeSelections,
    resolveSnapshotExecutionSpace
  }: {
    settingsStore: RuntimeSettingsStore
    runtime: Pick<AgentRuntime, 'testConnection' | 'getStatus'>
    selectedRuntimes?: Pick<SelectedRuntimeResolver, 'getNativeSnapshot' | 'testStatus'>
    bundledRuntimePaths: BundledRuntimePaths
    enqueueRuntimeSettingsUpdate: <T>(transaction: () => Promise<T>) => Promise<T>
    onRuntimeSettingsChanged: () => Promise<void>
    repairRuntimeSelections: (settings: RuntimeSettings) => void | Promise<void>
    resolveSnapshotExecutionSpace: (
      projectId?: string
    ) => Promise<ReturnType<ExecutionSpaceResolver['resolveProject']>>
  }
): void {
  registerHandler(
    ipcChannels.runtimeSettingsGet,
    (event): Promise<RuntimeSettings> => {
      assertTrustedSender(event, window)
      return settingsStore.getPublicSettings()
    }
  )

  registerHandler(
    ipcChannels.runtimeCustomizationGet,
    (event) => {
      assertTrustedSender(event, window)
      return settingsStore.getRuntimeCustomization()
    }
  )

  registerHandler(
    ipcChannels.runtimeCustomizationUpdate,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const settings =
        runtimeCustomizationSettingsSchema.parse(input)
      return enqueueRuntimeSettingsUpdate(async () => {
        const previous =
          await settingsStore.getRuntimeCustomization()
        return activateOrRollback({
          previous,
          persistCandidate: async () => {
            const saved =
              await settingsStore.updateRuntimeCustomization(settings)
            return saved
          },
          activate: onRuntimeSettingsChanged,
          persistPrevious: (previousSettings) =>
            settingsStore.updateRuntimeCustomization(previousSettings)
        })
      })
    }
  )

  registerHandler(
    ipcChannels.runtimeNativeSnapshot,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      if (!selectedRuntimes) {
        throw new Error('Runtime 管理器不可用')
      }
      const request = runtimeNativeSnapshotInputSchema.parse(input)
      const selection: AgentRuntimeSelection = {
        provider: request.provider,
        ...(request.profileId
          ? { profileId: request.profileId }
          : {})
      }
      const executionSpace = await resolveSnapshotExecutionSpace(request.projectId)
      return runtimeNativeSnapshotSchema.parse(
        await selectedRuntimes.getNativeSnapshot(
          selection,
          executionSpace
        )
      )
    }
  )

  registerHandler(
    ipcChannels.runtimeSettingsUpdate,
    async (event, input: unknown): Promise<RuntimeSettings> => {
      assertTrustedSender(event, window)
      const settings = runtimeSettingsInputSchema.parse(input)
      return enqueueRuntimeSettingsUpdate(async () => {
        let workspacePath: string
        try {
          workspacePath = await realpath(settings.workspacePath)
          if (!(await stat(workspacePath)).isDirectory()) {
            throw new Error('Not a directory')
          }
        } catch {
          throw new Error('所选工作区不存在、不可访问或不是文件夹')
        }
        const rollback = await settingsStore.captureRollback()
        const previousSettings = rollback.publicSettings
        const savedSettings = await activateOrRollback({
          previous: previousSettings,
          persistCandidate: async () => {
            const saved = await settingsStore.update({
              ...settings,
              workspacePath
            })
            return saved
          },
          activate: onRuntimeSettingsChanged,
          persistPrevious: () => rollback.restore()
        })
        await repairRuntimeSelections(savedSettings)
        return savedSettings
      })
    }
  )

  registerHandler(
    ipcChannels.runtimeSettingsSelectWorkspace,
    async (event): Promise<string | undefined> => {
      assertTrustedSender(event, window)
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory']
      })
      return result.canceled ? undefined : result.filePaths[0]
    }
  )

  registerHandler(
    ipcChannels.runtimeSettingsDetect,
    async (event): Promise<AgentRuntimeDetection> => {
      assertTrustedSender(event, window)
      const settings = await settingsStore.getResolvedSettings()
      return detectAgentRuntimes({
        opencodeBinaryPath: settings.opencodeBinaryPath,
        continueBinaryPath: settings.continueBinaryPath,
        bundledPaths: bundledRuntimePaths,
        bundledVersions: {
          continue: bundledContinueVersion,
          deepseekHarness: bundledDeepSeekHarnessVersion
        }
      })
    }
  )

  registerHandler(
    ipcChannels.runtimeSettingsSelectFile,
    async (event, input: unknown): Promise<string | undefined> => {
      assertTrustedSender(event, window)
      const kind = runtimeFileSelectionKindSchema.parse(input)
      const binary =
        kind === 'opencodeBinary' ||
        kind === 'continueBinary'
      const configRuntime =
        kind === 'opencodeConfig'
          ? 'opencode'
          : kind === 'continueConfig'
            ? 'continue'
            : undefined
      const configMetadata = configRuntime
        ? runtimeConfigFileMetadata[configRuntime]
        : undefined
      const filters =
        binary && process.platform === 'win32'
          ? [
              {
                name: '可执行文件',
                extensions: ['exe', 'cmd', 'bat', 'com']
              },
              { name: '所有文件', extensions: ['*'] }
            ]
          : configMetadata
            ? [
                {
                  name: configMetadata.filterName,
                  extensions: [...configMetadata.filterExtensions]
                }
              ]
            : undefined
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        title: binary ? '选择可执行文件' : '选择配置文件',
        ...(filters ? { filters } : {})
      })
      if (result.canceled || !result.filePaths[0]) {
        return undefined
      }
      const selectedPath = await realpath(result.filePaths[0])
      if (!(await stat(selectedPath)).isFile()) {
        throw new Error('所选路径不是普通文件')
      }
      return selectedPath
    }
  )

  registerHandler(
    ipcChannels.runtimeSettingsOpenConfig,
    async (event, input: unknown): Promise<void> => {
      assertTrustedSender(event, window)
      const request = runtimeConfigActionInputSchema.parse(input)
      if (request.action === 'open-directory') {
        const directory = getRuntimeConfigDirectory(request.runtime)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const error = await shell.openPath(await realpath(directory))
        if (error) {
          throw new Error('无法打开 Runtime 配置目录')
        }
        return
      }

      const settings = await settingsStore.getPublicSettings()
      const persisted = settings.configured ?? settings
      const configuredPath =
        request.runtime === 'opencode'
          ? persisted.opencodeConfigPath
          : persisted.continueConfigPath
      if (!configuredPath) {
        throw new Error('尚未选择 Runtime 自有配置文件')
      }
      const configPath = await realpath(configuredPath)
      if (!(await stat(configPath)).isFile()) {
        throw new Error('Runtime 配置路径不是普通文件')
      }
      if (request.action === 'show-file') {
        shell.showItemInFolder(configPath)
        return
      }
      if (
        !runtimeConfigFileMetadata[request.runtime].allowedExtensions.has(
          extname(configPath).toLowerCase()
        )
      ) {
        throw new Error('Runtime 配置文件类型不支持直接打开')
      }
      const error = await shell.openPath(configPath)
      if (error) {
        throw new Error('无法打开 Runtime 配置文件')
      }
    }
  )

  registerHandler(
    ipcChannels.runtimeSettingsTestModel,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const profileId = modelProfileIdSchema.parse(input)
      const settings = await settingsStore.getResolvedSettings()
      const profile = settings.modelProfiles.find(
        (candidate) => candidate.id === profileId
      )
      if (!profile) {
        throw new Error('所选模型连接不存在')
      }
      if (profile.authentication === 'api-key' && !profile.apiKey) {
        throw new Error(`模型连接“${profile.name}”未配置 API Key`)
      }
      const modelRuntime = createModelProfileRuntime(
        settings.workspacePath,
        settings,
        profile
      )
      try {
        const status =
          (await modelRuntime.testConnection?.()) ??
          (await modelRuntime.getStatus())
        if (!status.available) {
          throw new Error(status.detail)
        }
        return status
      } finally {
        await modelRuntime.dispose()
      }
    }
  )

  registerHandler(
    ipcChannels.runtimeSettingsTest,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const selection = agentRuntimeSelectionSchema.parse(input)
      const status = selectedRuntimes
        ? await selectedRuntimes.testStatus(selection)
        : ((await runtime.testConnection?.()) ??
          (await runtime.getStatus()))
      if (!status.available) {
        throw new Error(status.detail)
      }
      return status
    }
  )
}
