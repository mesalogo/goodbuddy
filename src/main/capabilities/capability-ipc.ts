import { dialog, type BrowserWindow, type ipcMain } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../shared/ipc-channels'
import {
  browserProfileCreateInputSchema,
  browserProfileRenameInputSchema,
  browserProfileSelectionInputSchema,
  builtinMcpServerAssignmentsInputSchema,
  builtinMcpServerToggleInputSchema,
  computerCapabilityConfigInputSchema,
  computerCapabilityIdSchema,
  computerCapabilityToggleInputSchema,
  mcpServerIdSchema,
  mcpServerInputSchema,
  obsidianSettingsSchema,
  obsidianConnectionTestResultSchema,
  skillAssignmentsInputSchema,
  skillIdSchema,
  skillImportKindSchema,
  skillToggleInputSchema,
  type CapabilitySnapshot,
  type CapabilityDiagnosticReport,
  type McpServerTestResult,
  type WebSearchTestResult
} from '../../shared/capability-contracts'
import {
  runtimeExtensionActionSchema,
  type RuntimeExtensionMarketplaceSnapshot
} from '../../shared/runtime-extension-contracts'
import type { KnowledgeMcpGateway } from '../agent/knowledge-mcp-gateway'
import type { RuntimeExtensionStore } from '../agent/runtime-extension-store'
import type { LocalToolEnvironmentService } from '../local-tool-environment'
import type { ObsidianService } from '../obsidian'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { CapabilityService } from './capability-service'
import { testMcpServer } from './mcp-tester'
import { testWebSearch } from './web-search-tester'

const mcpServerSaveSchema = z
  .object({
    serverId: mcpServerIdSchema.optional(),
    input: mcpServerInputSchema
  })
  .strict()

export function registerCapabilityIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow,
  {
    capabilityService,
    refreshCapabilities,
    onRuntimeSettingsChanged,
    runtimeExtensionStore,
    knowledgeGateway,
    obsidianService,
    localToolEnvironmentService
  }: {
    capabilityService: CapabilityService
    refreshCapabilities: (
      operation: Promise<CapabilitySnapshot>,
      reconfigureRuntime?: boolean
    ) => Promise<CapabilitySnapshot>
    onRuntimeSettingsChanged: () => Promise<void>
    runtimeExtensionStore?: RuntimeExtensionStore
    knowledgeGateway?: Pick<KnowledgeMcpGateway, 'revokeObsidianCapabilities'>
    obsidianService?: Pick<ObsidianService, 'testConnection'>
    localToolEnvironmentService?: Pick<LocalToolEnvironmentService, 'launchEnvironmentProvider' | 'whenReady'>
  }
): void {
  registerHandler(
    ipcChannels.capabilitiesSnapshot,
    (event): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      return capabilityService.getSnapshot()
    }
  )

  registerHandler(
    ipcChannels.runtimeExtensionsSnapshot,
    (event): Promise<RuntimeExtensionMarketplaceSnapshot> => {
      assertTrustedSender(event, window)
      if (!runtimeExtensionStore) {
        throw new Error('DSH 插件市场不可用')
      }
      return runtimeExtensionStore.getSnapshot()
    }
  )

  registerHandler(
    ipcChannels.runtimeExtensionsApply,
    async (
      event,
      input: unknown
    ): Promise<RuntimeExtensionMarketplaceSnapshot> => {
      assertTrustedSender(event, window)
      if (!runtimeExtensionStore) {
        throw new Error('DSH 插件市场不可用')
      }
      const action = runtimeExtensionActionSchema.parse(input)
      const result =
        await runtimeExtensionStore.applyWithResult(action)
      if (
        result.changed &&
        action.type !== 'set-marketplace-enabled'
      ) {
        await onRuntimeSettingsChanged()
      }
      return result.snapshot
    }
  )

  registerHandler(
    ipcChannels.capabilitiesImportSkill,
    async (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const kind = skillImportKindSchema.parse(input)
      const result = await dialog.showOpenDialog(
        window,
        kind === 'zip'
          ? {
              title: '选择 Skill ZIP 文件',
              properties: ['openFile'],
              filters: [{ name: 'Skill ZIP', extensions: ['zip'] }]
            }
          : {
              title: '选择包含 SKILL.md 的目录',
              properties: ['openDirectory']
            }
      )
      if (result.canceled || !result.filePaths[0]) {
        return capabilityService.getSnapshot()
      }
      return refreshCapabilities(
        capabilityService.importSkill(result.filePaths[0])
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesRemoveSkill,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      return refreshCapabilities(
        capabilityService.removeSkill(skillIdSchema.parse(input))
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesToggleSkill,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = skillToggleInputSchema.parse(input)
      return refreshCapabilities(
        capabilityService.setSkillEnabled(
          value.skillId,
          value.enabled
        )
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesAssignSkill,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = skillAssignmentsInputSchema.parse(input)
      return refreshCapabilities(
        capabilityService.setSkillAssignments(
          value.skillId,
          value.assignments
        )
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesUpdateObsidianSettings,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const settings = obsidianSettingsSchema.parse(input)
      knowledgeGateway?.revokeObsidianCapabilities()
      return refreshCapabilities(
        capabilityService.updateObsidianSettings(settings)
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesTestObsidianConnection,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const settings = obsidianSettingsSchema.parse(input)
      if (!obsidianService) throw new Error('Obsidian 服务不可用')
      return obsidianConnectionTestResultSchema.parse(
        await obsidianService.testConnection(settings)
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesSelectObsidianVault,
    async (event): Promise<string | null> => {
      assertTrustedSender(event, window)
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory']
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    }
  )

  registerHandler(
    ipcChannels.capabilitiesToggleBuiltinMcp,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = builtinMcpServerToggleInputSchema.parse(input)
      if (value.serverId === 'obsidian') knowledgeGateway?.revokeObsidianCapabilities()
      return refreshCapabilities(
        capabilityService.setBuiltinMcpServerEnabled(
          value.serverId,
          value.enabled
        )
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesAssignBuiltinMcp,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = builtinMcpServerAssignmentsInputSchema.parse(input)
      if (value.serverId === 'obsidian') knowledgeGateway?.revokeObsidianCapabilities()
      return refreshCapabilities(
        capabilityService.setBuiltinMcpServerAssignments(
          value.serverId,
          value.assignments
        )
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesSaveMcp,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = mcpServerSaveSchema.parse(input)
      return refreshCapabilities(
        capabilityService.saveMcpServer(value.serverId, value.input)
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesRemoveMcp,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      return refreshCapabilities(
        capabilityService.removeMcpServer(
          mcpServerIdSchema.parse(input)
        )
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesTestMcp,
    async (event, input: unknown): Promise<McpServerTestResult> => {
      assertTrustedSender(event, window)
      // A stdio MCP test must launch with the prepared tool PATH.
      await localToolEnvironmentService?.whenReady()
      return testMcpServer(
        await capabilityService.getResolvedMcpServer(
          mcpServerIdSchema.parse(input)
        ),
        undefined,
        localToolEnvironmentService?.launchEnvironmentProvider
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesToggleWebSearch,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      return refreshCapabilities(
        capabilityService.setWebSearchEnabled(z.boolean().parse(input))
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesTestWebSearch,
    (event): Promise<WebSearchTestResult> => {
      assertTrustedSender(event, window)
      return testWebSearch()
    }
  )

  registerHandler(
    ipcChannels.capabilitiesToggleComputer,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = computerCapabilityToggleInputSchema.parse(input)
      return refreshCapabilities(
        capabilityService.setComputerCapabilityEnabled(
          value.capabilityId,
          value.enabled
        )
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesConfigureComputer,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = computerCapabilityConfigInputSchema.parse(input)
      return refreshCapabilities(
        capabilityService.setComputerCapabilityBrowserProfile(
          value.capabilityId,
          value.browserProfileId
        )
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesDiagnoseComputer,
    (event, input: unknown): Promise<CapabilityDiagnosticReport> => {
      assertTrustedSender(event, window)
      return capabilityService.diagnoseComputerCapability(
        computerCapabilityIdSchema.parse(input)
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesCreateBrowserProfile,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = browserProfileCreateInputSchema.parse(input)
      return refreshCapabilities(
        capabilityService.createBrowserProfile(value.name),
        false
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesRenameBrowserProfile,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = browserProfileRenameInputSchema.parse(input)
      return refreshCapabilities(
        capabilityService.renameBrowserProfile(value.profileId, value.name),
        false
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesDefaultBrowserProfile,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = browserProfileSelectionInputSchema.parse(input)
      return refreshCapabilities(
        capabilityService.setDefaultBrowserProfile(value.profileId),
        false
      )
    }
  )

  registerHandler(
    ipcChannels.capabilitiesRemoveBrowserProfile,
    (event, input: unknown): Promise<CapabilitySnapshot> => {
      assertTrustedSender(event, window)
      const value = browserProfileSelectionInputSchema.parse(input)
      return refreshCapabilities(
        capabilityService.removeBrowserProfile(value.profileId),
        false
      )
    }
  )
}
