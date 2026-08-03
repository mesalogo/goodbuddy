import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const portableMarkerName = '.goodbuddy-portable.json'

export function resolvePortableUserDataPath(input: {
  packaged: boolean
  platform: NodeJS.Platform
  executablePath: string
}): string | undefined {
  if (!input.packaged || input.platform !== 'win32') {
    return undefined
  }
  const executableDirectory = dirname(resolve(input.executablePath))
  const markerPath = join(executableDirectory, portableMarkerName)
  try {
    const markerFile = statSync(markerPath)
    if (!markerFile.isFile() || markerFile.size > 4_096) {
      return undefined
    }
    const marker = JSON.parse(
      readFileSync(markerPath, 'utf8')
    ) as Record<string, unknown>
    if (
      marker.formatVersion !== 1 ||
      marker.productName !== 'GoodBuddy'
    ) {
      return undefined
    }
    return join(executableDirectory, 'data')
  } catch {
    return undefined
  }
}
