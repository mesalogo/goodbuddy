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
  applicationSettingsUpdateSchema,
  type ApplicationSettings
} from '../shared/application-settings-contracts'
import { releaseVersionSchema } from '../shared/release-notes-contracts'
export {
  applicationSettingsSchema,
  applicationSettingsUpdateSchema
} from '../shared/application-settings-contracts'
export type { ApplicationSettings } from '../shared/application-settings-contracts'

const CURRENT_SETTINGS_VERSION = 5

const legacyStoredApplicationSettingsSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    checkUpdatesOnStartup: z.boolean()
  })
  .strict()

const versionTwoStoredApplicationSettingsSchema = z
  .object({
    version: z.literal(2),
    checkUpdatesOnStartup: z.boolean(),
    magicNotesEnabled: z.boolean()
  })
  .strict()

const versionThreeStoredApplicationSettingsSchema = z
  .object({
    version: z.literal(3),
    checkUpdatesOnStartup: z.boolean(),
    magicNotesEnabled: z.boolean(),
    magicNoteCommentMode: applicationSettingsSchema.shape.magicNoteCommentMode
  })
  .strict()

const versionFourStoredApplicationSettingsSchema = applicationSettingsSchema
  .extend({
    version: z.literal(4)
  })
  .strict()

const storedApplicationSettingsSchema = applicationSettingsSchema
  .extend({
    version: z.literal(CURRENT_SETTINGS_VERSION),
    lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
  })
  .strict()

type StoredApplicationSettings = z.infer<
  typeof storedApplicationSettingsSchema
>

export const defaultApplicationSettings: ApplicationSettings = {
  checkUpdatesOnStartup: true,
  magicNotesEnabled: false,
  magicNoteCommentMode: 'immediate',
  magicNoteCommentFormat: 'combined'
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
  private settingsLoad?: Promise<StoredApplicationSettings>
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
    if (!this.settingsLoad) {
      this.settingsLoad = this.readStored().finally(() => {
        this.settingsLoad = undefined
      })
    }
    return this.settingsLoad
  }

  private async readStored(): Promise<StoredApplicationSettings> {
    try {
      const contents = await readFile(this.filePath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(contents) as unknown
      } catch {
        await this.isolateCorruptFile()
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          lastSeenReleaseNotesVersion: null,
          ...defaultApplicationSettings
        }
        return this.settings
      }
      const result = storedApplicationSettingsSchema.safeParse(parsed)
      if (!result.success) {
        const versionFourResult =
          versionFourStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionFourResult.success) {
          this.settings = {
            ...versionFourResult.data,
            version: CURRENT_SETTINGS_VERSION,
            lastSeenReleaseNotesVersion: null
          }
          return this.settings
        }
        const versionThreeResult =
          versionThreeStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionThreeResult.success) {
          this.settings = {
            ...versionThreeResult.data,
            version: CURRENT_SETTINGS_VERSION,
            magicNoteCommentFormat: 'combined',
            lastSeenReleaseNotesVersion: null
          }
          return this.settings
        }
        const versionTwoResult =
          versionTwoStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionTwoResult.success) {
          this.settings = {
            ...versionTwoResult.data,
            version: CURRENT_SETTINGS_VERSION,
            magicNoteCommentMode: 'immediate',
            magicNoteCommentFormat: 'combined',
            lastSeenReleaseNotesVersion: null
          }
          return this.settings
        }
        const legacyResult =
          legacyStoredApplicationSettingsSchema.safeParse(parsed)
        if (legacyResult.success) {
          this.settings = {
            version: CURRENT_SETTINGS_VERSION,
            checkUpdatesOnStartup:
              legacyResult.data.checkUpdatesOnStartup,
            magicNotesEnabled: false,
            magicNoteCommentMode: 'immediate',
            magicNoteCommentFormat: 'combined',
            lastSeenReleaseNotesVersion: null
          }
          return this.settings
        }
        await this.isolateCorruptFile()
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          lastSeenReleaseNotesVersion: null,
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
        lastSeenReleaseNotesVersion: null,
        ...defaultApplicationSettings
      }
    }
    return this.settings
  }

  async get(): Promise<ApplicationSettings> {
    const stored = await this.loadStored()
    return {
      checkUpdatesOnStartup: stored.checkUpdatesOnStartup,
      magicNotesEnabled: stored.magicNotesEnabled,
      magicNoteCommentMode: stored.magicNoteCommentMode,
      magicNoteCommentFormat: stored.magicNoteCommentFormat
    }
  }

  async getLastSeenReleaseNotesVersion(): Promise<string | null> {
    return (await this.loadStored()).lastSeenReleaseNotesVersion
  }

  private async persist(next: StoredApplicationSettings): Promise<void> {
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
  }

  update(input: unknown): Promise<ApplicationSettings> {
    const operation = this.updateQueue.then(async () => {
      const updates = applicationSettingsUpdateSchema.parse(input)
      const current = await this.loadStored()
      const next: StoredApplicationSettings = {
        ...current,
        ...updates,
        version: CURRENT_SETTINGS_VERSION
      }
      await this.persist(next)
      return {
        checkUpdatesOnStartup: next.checkUpdatesOnStartup,
        magicNotesEnabled: next.magicNotesEnabled,
        magicNoteCommentMode: next.magicNoteCommentMode,
        magicNoteCommentFormat: next.magicNoteCommentFormat
      }
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  setLastSeenReleaseNotesVersion(version: unknown): Promise<void> {
    const operation = this.updateQueue.then(async () => {
      const parsedVersion = releaseVersionSchema.parse(version)
      const current = await this.loadStored()
      if (current.lastSeenReleaseNotesVersion === parsedVersion) {
        return
      }
      await this.persist({
        ...current,
        version: CURRENT_SETTINGS_VERSION,
        lastSeenReleaseNotesVersion: parsedVersion
      })
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
