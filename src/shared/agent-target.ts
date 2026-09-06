import { z } from 'zod'

export const agentPlatformSchema = z.enum(['linux', 'darwin'])
export type AgentPlatform = z.infer<typeof agentPlatformSchema>

export const AGENT_TARGETS = [
  { platform: 'linux', architecture: 'x64' },
  { platform: 'linux', architecture: 'arm64' },
  { platform: 'darwin', architecture: 'arm64' }
] as const

export type AgentTarget = (typeof AGENT_TARGETS)[number]
export type AgentTargetKey = 'linux-x64' | 'linux-arm64' | 'darwin-arm64'

export function agentTargetKey(target: {
  platform: string
  architecture: string
}): AgentTargetKey {
  if (!AGENT_TARGETS.some(entry =>
    entry.platform === target.platform && entry.architecture === target.architecture
  )) throw new Error(`Unsupported Agent target: ${target.platform}-${target.architecture}`)
  return `${target.platform}-${target.architecture}` as AgentTargetKey
}

export function currentAgentPlatform(): AgentPlatform {
  const platform = agentPlatformSchema.parse(process.platform)
  agentTargetKey({ platform, architecture: process.arch })
  return platform
}
