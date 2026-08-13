import { randomBytes } from 'node:crypto'
import {
  mkdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SettingsFileOperations {
  rename: typeof rename
  writeFile: typeof writeFile
}

export class UnsupportedSettingsVersionError extends Error {}

const defaultSettingsFileOperations: SettingsFileOperations = {
  rename,
  writeFile
}

function resolveSettingsFileOperations(
  operations?: Partial<SettingsFileOperations>
): SettingsFileOperations {
  return {
    ...defaultSettingsFileOperations,
    ...operations
  }
}

export function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

export function assertSupportedSettingsVersion(
  value: unknown,
  currentVersion: number,
  message: (version: number) => string
): void {
  if (
    value !== null &&
    typeof value === 'object' &&
    'version' in value &&
    typeof value.version === 'number' &&
    value.version > currentVersion
  ) {
    throw new UnsupportedSettingsVersionError(message(value.version))
  }
}

export async function isolateCorruptSettingsFile(
  filePath: string,
  failureMessage: string,
  now: () => number = Date.now,
  operations?: Partial<SettingsFileOperations>
): Promise<void> {
  const fileOperations = resolveSettingsFileOperations(operations)
  const isolatedPath =
    `${filePath}.corrupt-${now()}-` +
    randomBytes(6).toString('hex')
  try {
    await fileOperations.rename(filePath, isolatedPath)
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new Error(failureMessage, { cause: error })
    }
  }
}

export async function writeJsonFileAtomically(
  filePath: string,
  value: unknown,
  operations?: Partial<SettingsFileOperations>
): Promise<void> {
  const fileOperations = resolveSettingsFileOperations(operations)
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath =
    `${filePath}.${process.pid}.` +
    `${randomBytes(6).toString('hex')}.tmp`
  try {
    await fileOperations.writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      }
    )
    await fileOperations.rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
