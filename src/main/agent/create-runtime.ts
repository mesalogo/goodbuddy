import { BigtokenAgentRuntime } from './bigtoken-runtime'
import { ContinueAgentRuntime } from './continue-runtime'
import { DemoAgentRuntime } from './demo-runtime'
import { OpenCodeRuntime } from './opencode-runtime'
import type { AgentRuntime } from './runtime'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { defaultRuntimeSettings } from '../../shared/contracts'

export function createAgentRuntime(
  defaultWorkspace: string,
  settings?: ResolvedRuntimeSettings
): AgentRuntime {
  const baseUrl = process.env.GOODBUDDY_OPENCODE_URL
  const embedded = process.env.GOODBUDDY_OPENCODE_EMBEDDED === 'true'
  const provider = settings?.provider ?? 'auto'

  if (provider === 'continue') {
    return new ContinueAgentRuntime({
      command: process.env.GOODBUDDY_CONTINUE_COMMAND ?? 'cn',
      defaultWorkspace
    })
  }

  if (provider === 'opencode' || (provider === 'auto' && (baseUrl || embedded))) {
    return new OpenCodeRuntime({
      baseUrl,
      embedded,
      defaultWorkspace
    })
  }

  const bigtokenApiKey =
    settings?.apiKey ?? process.env.GOODBUDDY_BIGTOKEN_API_KEY?.trim()
  if (provider === 'bigtoken' || (provider === 'auto' && bigtokenApiKey)) {
    return new BigtokenAgentRuntime({
      apiKey: bigtokenApiKey ?? '',
      baseUrl:
        settings?.bigtokenBaseUrl ?? defaultRuntimeSettings.bigtokenBaseUrl,
      model: settings?.bigtokenModel ?? defaultRuntimeSettings.bigtokenModel
    })
  }

  return new DemoAgentRuntime()
}
