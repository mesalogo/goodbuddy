import { z } from 'zod'
import type { UpdateSource, VersionCheckResult } from './application-settings-contracts'

export const desktopUpdateDownloadSchema = z.object({
  fileName: z.string().min(1).max(255)
}).strict()

export type DesktopUpdateSnapshot = {
  revision: number
  status: 'idle' | 'available' | 'downloading' | 'verifying' | 'cancelling' | 'ready' | 'restarting' | 'error'
  restartAvailable?: boolean
  cacheCleaning?: boolean
  cleanupWarning?: string
  packageHandedOff?: boolean
  result?: VersionCheckResult
  source?: UpdateSource
  suggestedFileName?: string
  fileName?: string
  transferred: number
  error?: string
}

export type DesktopUpdateBridge = {
  getSnapshot: () => Promise<DesktopUpdateSnapshot>
  download: (input: z.infer<typeof desktopUpdateDownloadSchema>) => Promise<void>
  cancel: () => Promise<void>
  openPackage: () => Promise<void>
  restart?: () => Promise<void>
  clearCache?: () => Promise<void>
  onChanged: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void
}
