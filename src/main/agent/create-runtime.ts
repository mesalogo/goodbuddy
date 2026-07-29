import { BigtokenAgentRuntime } from './bigtoken-runtime'
import { DemoAgentRuntime } from './demo-runtime'
import { OpenCodeRuntime } from './opencode-runtime'
import type { AgentRuntime } from './runtime'

export function createAgentRuntime(defaultWorkspace: string): AgentRuntime {
  const baseUrl = process.env.GOODBUDDY_OPENCODE_URL
  const embedded = process.env.GOODBUDDY_OPENCODE_EMBEDDED === 'true'

  if (baseUrl || embedded) {
    return new OpenCodeRuntime({
      baseUrl,
      embedded,
      defaultWorkspace
    })
  }

  const bigtokenApiKey = process.env.GOODBUDDY_BIGTOKEN_API_KEY?.trim()
  if (bigtokenApiKey) {
    return new BigtokenAgentRuntime({
      apiKey: bigtokenApiKey,
      baseUrl:
        process.env.GOODBUDDY_BIGTOKEN_BASE_URL ?? 'https://bigtoken.ai',
      model: process.env.GOODBUDDY_BIGTOKEN_MODEL ?? 'sonnet-5'
    })
  }

  return new DemoAgentRuntime()
}
