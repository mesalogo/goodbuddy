import type { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../shared/ipc-channels'
import {
  localToolDiagnoseInputSchema,
  localToolEnvironmentSettingsSchema,
  localToolKindInputSchema
} from '../../shared/local-tool-environment-contracts'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { LocalToolEnvironmentService } from './local-tool-environment-service'

export function registerLocalToolEnvironmentIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow,
  localToolEnvironmentService?: LocalToolEnvironmentService
): void {
  const requireLocalToolEnvironmentService =
    (): LocalToolEnvironmentService => {
      if (!localToolEnvironmentService) {
        throw new Error('本地工具环境服务不可用')
      }
      return localToolEnvironmentService
    }

  registerHandler(
    ipcChannels.localToolEnvironmentGet,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      z.undefined().parse(input)
      return requireLocalToolEnvironmentService().getSnapshot()
    }
  )
  registerHandler(
    ipcChannels.localToolEnvironmentUpdate,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      return requireLocalToolEnvironmentService().updateSettings(
        localToolEnvironmentSettingsSchema.parse(input)
      )
    }
  )
  registerHandler(
    ipcChannels.localToolEnvironmentRefresh,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      z.undefined().parse(input)
      return requireLocalToolEnvironmentService().refreshCandidates()
    }
  )
  registerHandler(
    ipcChannels.localToolEnvironmentSelectExecutable,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { kind } = localToolKindInputSchema.parse(input)
      return requireLocalToolEnvironmentService().selectExecutable(kind)
    }
  )
  registerHandler(
    ipcChannels.localToolEnvironmentDiagnose,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { kind } = localToolDiagnoseInputSchema.parse(input)
      return requireLocalToolEnvironmentService().diagnose(kind)
    }
  )
  registerHandler(
    ipcChannels.localToolEnvironmentInstallPython,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      z.undefined().parse(input)
      return requireLocalToolEnvironmentService().installPython()
    }
  )
  registerHandler(
    ipcChannels.localToolEnvironmentCancelPython,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      z.undefined().parse(input)
      return requireLocalToolEnvironmentService().cancelPython()
    }
  )
  registerHandler(
    ipcChannels.localToolEnvironmentRemovePython,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      z.undefined().parse(input)
      return requireLocalToolEnvironmentService().removePython()
    }
  )
}
