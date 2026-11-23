// Keep preload constants independent of Zod: sandboxed preload cannot require packages.
export const officeChannels = {
  context: 'office:context',
  interaction: 'office:interaction',
  resolveClose: 'office:resolve-close',
  capabilities: 'office:capabilities',
  open: 'office:open', save: 'office:save', close: 'office:close', viewport: 'office:viewport',
  ask: 'office:ask', result: 'office:result', apply: 'office:apply'
} as const
