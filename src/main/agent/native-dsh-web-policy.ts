export type NativeDshMcpServer = {
  serverName: string
} & (
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: 'streamable-http'; url: string; headers?: Record<string, string> }
)

export function nativeDshWebPatch(options: {
  model: string
  api: string
  baseURL: string
  skillDirectories: string[]
  mcpServers: NativeDshMcpServer[]
}): unknown[] {
  return [
    {
      id: 'llm-pi-ai',
      config: { providers: { goodbuddy: {
        displayName: 'GoodBuddy', api: options.api,
        apiKeyEnv: 'GOODBUDDY_DSH_MODEL_KEY', baseURL: options.baseURL,
        models: [{ id: options.model, name: options.model }]
      } } }
    },
    { id: 'agent-default-model', config: { provider: 'goodbuddy', model: options.model } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'ui-permission', disabled: true },
    { insert: [
      ...(options.skillDirectories.length ? [{
        id: 'goodbuddy-skills', name: '@deepseek-ai/dsh-skill-filesystem',
        config: { providerName: 'goodbuddy', includeDefaultRoots: false,
          customSkillDirs: options.skillDirectories }
      }] : []),
      ...options.mcpServers.map((server, index) => {
        const config = { ...server, failOnStartupError: true }
        return { id: `goodbuddy-mcp-${index}`, name: '@deepseek-ai/dsh-mcp-client', config }
      })
    ] }
  ]
}
