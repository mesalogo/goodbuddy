import { createHash } from 'node:crypto'

// Used by Main and the Agent daemon, never by Renderer contracts.
export function remoteImageToolMcpName(bindingId: string): string {
  return `goodbuddy_image_${createHash('sha256').update(bindingId).digest('hex').slice(0, 24)}`
}
