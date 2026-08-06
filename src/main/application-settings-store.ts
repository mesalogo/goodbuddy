import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  applicationSettingsSchema,
  type ApplicationSettings
} from '../shared/application-settings-contracts'
export { applicationSettingsSchema } from '../shared/application-settings-contracts'
export type { ApplicationSettings } from '../shared/application-settings-contracts'

const CURRENT_SETTINGS_VERSION = 1

const storedApplicationSettingsSchema = applicationSettingsSchema
  .extend({
    version: z.literal(CURRENT_SETTINGS_VERSION)
  })
  .strict()

type StoredApplicationSettings = z.infer<
  typeof storedApplicationSettingsSchema
>

export const defaultApplicationSettings: ApplicationSettings = {
  checkUpdatesOnStartup: true
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

export class ApplicationSettingsStore {
  private settings?: StoredApplicationSettings
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private async isolateCorruptFile(): Promise<void> {
    const isolatedPath =
      `${this.filePath}.corrupt-${Date.now()}-` +
      randomBytes(6).toString('hex')
    try {
      await rename(this.filePath, isolatedPath)
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error(
          'Application settings are corrupt and could not be isolated',
          { cause: error }
        )
      }
    }
  }

  private async loadStored(): Promise<StoredApplicationSettings> {
    if (this.settings) {
      return this.settings
    }
    try {
      const contents = await readFile(this.filePath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(contents) as unknown
      } catch {
        await this.isolateCorruptFile()
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          ...defaultApplicationSettings
        }
        return this.settings
      }
      const result = storedApplicationSettingsSchema.safeParse(parsed)
      if (!result.success) {
        await this.isolateCorruptFile()
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          ...defaultApplicationSettings
        }
        return this.settings
      }
      this.settings = result.data
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error('Application settings could not be read', {
          cause: error
        })
      }
      this.settings = {
        version: CURRENT_SETTINGS_VERSION,
        ...defaultApplicationSettings
      }
    }
    return this.settings
  }

  async get(): Promise<ApplicationSettings> {
    const stored = await this.loadStored()
    return {
      checkUpdatesOnStartup: stored.checkUpdatesOnStartup
    }
  }

  update(input: unknown): Promise<ApplicationSettings> {
    const operation = this.updateQueue.then(async () => {
      const settings = applicationSettingsSchema.parse(input)
      const next: StoredApplicationSettings = {
        version: CURRENT_SETTINGS_VERSION,
        ...settings
      }
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath =
        `${this.filePath}.${process.pid}.` +
        `${randomBytes(6).toString('hex')}.tmp`
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify(next, null, 2)}\n`,
          {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx'
          }
        )
        await rename(temporaryPath, this.filePath)
      } finally {
        await rm(temporaryPath, { force: true })
      }
      this.settings = next
      return {
        checkUpdatesOnStartup: next.checkUpdatesOnStartup
      }
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
