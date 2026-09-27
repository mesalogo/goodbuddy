import { createHash } from 'node:crypto'

// Official dsh-mcp-client 0.1.7-rc.2 naming contract; its helper is private.
export function nativeDshMcpToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/gu, '_')
  if (joined === normalized && normalized.length <= 64) return joined
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

export type NativeDshMcpServer = {
  serverName: string
  readOnlyTools?: string[]
} & (
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: 'streamable-http'; url: string; headers?: Record<string, string> }
)

// Loaded by the official Cordis loader, outside Electron and its ASAR bundle.
// The launch mode applies to every session, including delegated agents.
export const nativeDshWebPolicySource = `
export const name = 'goodbuddy-native-mode';
export function apply(ctx, config) {
  const allowed = new Set(['read', 'skill', ...config.readOnlyTools]);
  ctx.on('tools/execute', (exec, next) => {
    if (config.workMode === 'ask' && !allowed.has(exec.name)) {
      throw new Error('GoodBuddy Ask mode does not allow tool: ' + exec.name);
    }
    return next();
  });
}
`

export function nativeDshWebPatch(options: {
  model: string
  api: string
  baseURL: string
  workMode: 'ask' | 'execute'
  policyPath: string
  skillDirectories: string[]
  mcpServers: NativeDshMcpServer[]
  readOnlyTools: string[]
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
    // The launch mode owns permissions. Native Plan remains a planning aid.
    { id: 'ui-permission', disabled: true },
    { insert: [
      { id: 'goodbuddy-native-mode', name: options.policyPath,
        config: { workMode: options.workMode, readOnlyTools: options.readOnlyTools } },
      ...(options.skillDirectories.length ? [{
        id: 'goodbuddy-skills', name: '@deepseek-ai/dsh-skill-filesystem',
        config: { providerName: 'goodbuddy', includeDefaultRoots: false,
          customSkillDirs: options.skillDirectories }
      }] : []),
      ...options.mcpServers.map((server, index) => {
        const config = { ...server, failOnStartupError: true }
        delete config.readOnlyTools
        return { id: `goodbuddy-mcp-${index}`, name: '@deepseek-ai/dsh-mcp-client', config }
      })
    ] }
  ]
}
