import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  applicationSettingsSchema,
  applicationSettingsUpdateSchema,
  type ApplicationSettings
} from '../shared/application-settings-contracts'
import { releaseVersionSchema } from '../shared/release-notes-contracts'
import type { SettingsWarning } from '../shared/settings-warning-contracts'
import {
  assertSupportedSettingsVersion,
  isolateCorruptSettingsFile,
  isMissingFileError,
  UnsupportedSettingsVersionError,
  writeJsonFileAtomically
} from './settings-file-utils'
export {
  applicationSettingsSchema,
  applicationSettingsUpdateSchema
} from '../shared/application-settings-contracts'
export type { ApplicationSettings } from '../shared/application-settings-contracts'

const CURRENT_SETTINGS_VERSION = 9

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
  .omit({
    updateSource: true,
    modelDownloadSource: true,
    remoteProjectsEnabled: true,
    magicNotesShowIncompleteTodoCount: true
  })
  .extend({
    version: z.literal(4)
  })
  .strict()

const versionFiveStoredApplicationSettingsSchema = applicationSettingsSchema
  .omit({
    updateSource: true,
    modelDownloadSource: true,
    remoteProjectsEnabled: true,
    magicNotesShowIncompleteTodoCount: true
  })
  .extend({
    version: z.literal(5),
    lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
  })
  .strict()

const versionSixStoredApplicationSettingsSchema = applicationSettingsSchema
  .omit({
    modelDownloadSource: true,
    remoteProjectsEnabled: true,
    magicNotesShowIncompleteTodoCount: true
  })
  .extend({
    version: z.literal(6),
    lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
  })
  .strict()

const versionSevenStoredApplicationSettingsSchema =
  applicationSettingsSchema
    .omit({
      remoteProjectsEnabled: true,
      magicNotesShowIncompleteTodoCount: true
    })
    .extend({
      version: z.literal(7),
      lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
    })
    .strict()

const versionEightStoredApplicationSettingsSchema =
  applicationSettingsSchema
    .omit({ remoteProjectsEnabled: true })
    .extend({
      version: z.literal(8),
      lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
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
  updateSource: 'github',
  modelDownloadSource: 'modelscope',
  remoteProjectsEnabled: false,
  magicNotesEnabled: false,
  magicNotesShowIncompleteTodoCount: true,
  magicNoteCommentMode: 'immediate',
  magicNoteCommentFormat: 'combined'
}

export class ApplicationSettingsStore {
  private settings?: StoredApplicationSettings
  private settingsLoad?: Promise<StoredApplicationSettings>
  private warnings: SettingsWarning[] = []
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private async isolateCorruptFile(): Promise<void> {
    await isolateCorruptSettingsFile(
      this.filePath,
      'Application settings are corrupt and could not be isolated'
    )
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
        this.warnings = [{ code: 'application-settings-recovered' }]
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          lastSeenReleaseNotesVersion: null,
          ...defaultApplicationSettings
        }
        return this.settings
      }
      assertSupportedSettingsVersion(
        parsed,
        CURRENT_SETTINGS_VERSION,
        (version) =>
          `当前 GoodBuddy 不支持应用设置版本 ${version}，请升级应用后重试`
      )
      const result = storedApplicationSettingsSchema.safeParse(parsed)
      if (!result.success) {
        const versionEightResult =
          versionEightStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionEightResult.success) {
          this.settings = {
            ...versionEightResult.data,
            version: CURRENT_SETTINGS_VERSION,
            remoteProjectsEnabled: false
          }
          return this.settings
        }
        const versionSevenResult =
          versionSevenStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionSevenResult.success) {
          this.settings = {
            ...versionSevenResult.data,
            version: CURRENT_SETTINGS_VERSION,
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true
          }
          return this.settings
        }
        const versionSixResult =
          versionSixStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionSixResult.success) {
          this.settings = {
            ...versionSixResult.data,
            version: CURRENT_SETTINGS_VERSION,
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true
          }
          return this.settings
        }
        const versionFiveResult =
          versionFiveStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionFiveResult.success) {
          this.settings = {
            ...versionFiveResult.data,
            version: CURRENT_SETTINGS_VERSION,
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true
          }
          return this.settings
        }
        const versionFourResult =
          versionFourStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionFourResult.success) {
          this.settings = {
            ...versionFourResult.data,
            version: CURRENT_SETTINGS_VERSION,
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true,
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
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true,
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
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true,
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
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesEnabled: false,
            magicNotesShowIncompleteTodoCount: true,
            magicNoteCommentMode: 'immediate',
            magicNoteCommentFormat: 'combined',
            lastSeenReleaseNotesVersion: null
          }
          return this.settings
        }
        await this.isolateCorruptFile()
        this.warnings = [{ code: 'application-settings-recovered' }]
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          lastSeenReleaseNotesVersion: null,
          ...defaultApplicationSettings
        }
        return this.settings
      }
      this.settings = result.data
    } catch (error) {
      if (error instanceof UnsupportedSettingsVersionError) {
        throw error
      }
      if (!isMissingFileError(error)) {
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
      updateSource: stored.updateSource,
      modelDownloadSource: stored.modelDownloadSource,
      remoteProjectsEnabled: stored.remoteProjectsEnabled,
      magicNotesEnabled: stored.magicNotesEnabled,
      magicNotesShowIncompleteTodoCount:
        stored.magicNotesShowIncompleteTodoCount,
      magicNoteCommentMode: stored.magicNoteCommentMode,
      magicNoteCommentFormat: stored.magicNoteCommentFormat,
      ...(this.warnings.length > 0
        ? { warnings: [...this.warnings] }
        : {})
    }
  }

  async getLastSeenReleaseNotesVersion(): Promise<string | null> {
    return (await this.loadStored()).lastSeenReleaseNotesVersion
  }

  private async persist(next: StoredApplicationSettings): Promise<void> {
    await writeJsonFileAtomically(this.filePath, next)
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
      this.warnings = []
      return {
        checkUpdatesOnStartup: next.checkUpdatesOnStartup,
        updateSource: next.updateSource,
        modelDownloadSource: next.modelDownloadSource,
        remoteProjectsEnabled: next.remoteProjectsEnabled,
        magicNotesEnabled: next.magicNotesEnabled,
        magicNotesShowIncompleteTodoCount:
          next.magicNotesShowIncompleteTodoCount,
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
