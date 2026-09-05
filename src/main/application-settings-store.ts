import { readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  applicationSettingsSchema,
  applicationSettingsUpdateSchema,
  type ApplicationSettings
} from '../shared/application-settings-contracts'
import {
  defaultLocalToolEnvironmentSettings,
  localToolExecutablePathSchema,
  type LocalToolEnvironmentSettings
} from '../shared/local-tool-environment-contracts'
import { inspectLocalToolExecutable } from './local-tool-environment/local-tool-environment'
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

const CURRENT_SETTINGS_VERSION = 11

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
    localToolEnvironment: true,
    conversationHtmlRenderingEnabled: true,
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
    localToolEnvironment: true,
    conversationHtmlRenderingEnabled: true,
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
    localToolEnvironment: true,
    conversationHtmlRenderingEnabled: true,
    remoteProjectsEnabled: true,
    magicNotesShowIncompleteTodoCount: true
  })
  .extend({
    version: z.literal(6),
    lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
  })
  .strict()

const versionSevenStoredApplicationSettingsSchema = applicationSettingsSchema
  .omit({
    localToolEnvironment: true,
    conversationHtmlRenderingEnabled: true,
    remoteProjectsEnabled: true,
    magicNotesShowIncompleteTodoCount: true
  })
  .extend({
    version: z.literal(7),
    lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
  })
  .strict()

const versionEightStoredApplicationSettingsSchema = applicationSettingsSchema
  .omit({
    localToolEnvironment: true,
    conversationHtmlRenderingEnabled: true,
    remoteProjectsEnabled: true
  })
  .extend({
    version: z.literal(8),
    lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
  })
  .strict()

const versionNineStoredApplicationSettingsSchema = applicationSettingsSchema
  .omit({
    localToolEnvironment: true,
    conversationHtmlRenderingEnabled: true
  })
  .extend({
    version: z.literal(9),
    lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
  })
  .strict()

const versionTenStoredApplicationSettingsSchema =
  applicationSettingsSchema
    .omit({ conversationHtmlRenderingEnabled: true })
    .extend({
      version: z.literal(10),
      lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
    })
    .strict()

const storedApplicationSettingsSchema = applicationSettingsSchema
  .extend({
    version: z.literal(CURRENT_SETTINGS_VERSION),
    lastSeenReleaseNotesVersion: releaseVersionSchema.nullable()
  })
  .strict()

type StoredApplicationSettings = z.infer<typeof storedApplicationSettingsSchema>

export type LegacyLocalToolEnvironmentPaths = {
  nodeExecutablePath?: string
  pythonExecutablePath?: string
}

export type LegacyLocalToolEnvironmentResolver =
  () => Promise<LegacyLocalToolEnvironmentPaths>

async function resolveExecutable(
  kind: 'node' | 'python',
  binaryNames: readonly string[]
): Promise<string | undefined> {
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension))
      : ['']
  const directories = (
    process.env.PATH ??
    process.env.Path ??
    process.env.path ??
    ''
  )
    .split(delimiter)
    .map((directory) => directory.trim())
    .filter(isAbsolute)

  for (const directory of directories) {
    for (const binaryName of binaryNames) {
      const names =
        process.platform === 'win32' && !extname(binaryName)
          ? extensions.map((extension) => `${binaryName}${extension}`)
          : [binaryName]
      for (const name of names) {
        try {
          const executablePath = await realpath(join(directory, name))
          const metadata = await stat(executablePath)
          if (
            metadata.isFile() &&
            localToolExecutablePathSchema.safeParse(executablePath).success
          ) {
            const candidate = await inspectLocalToolExecutable(
              kind,
              executablePath,
              { baseEnvironment: process.env }
            )
            if (candidate) {
              return candidate.executablePath
            }
          }
        } catch {
          // Continue through PATH candidates.
        }
      }
    }
  }
  return undefined
}

export const resolveLegacyLocalToolEnvironmentPaths: LegacyLocalToolEnvironmentResolver =
  async () => {
    const [nodeExecutablePath, pythonExecutablePath] = await Promise.all([
      resolveExecutable('node', ['node']),
      resolveExecutable(
        'python',
        process.platform === 'win32'
          ? ['python', 'python3']
          : ['python3', 'python']
      )
    ])
    return {
      ...(nodeExecutablePath ? { nodeExecutablePath } : {}),
      ...(pythonExecutablePath ? { pythonExecutablePath } : {})
    }
  }

export const defaultApplicationSettings: ApplicationSettings = {
  checkUpdatesOnStartup: true,
  updateSource: 'github',
  modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings,
  conversationHtmlRenderingEnabled: true,
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

  constructor(
    private readonly filePath: string,
    private readonly legacyLocalToolEnvironmentResolver: LegacyLocalToolEnvironmentResolver = resolveLegacyLocalToolEnvironmentPaths
  ) {}

  private async migrateLegacy(
    settings: Omit<
      StoredApplicationSettings,
      | 'conversationHtmlRenderingEnabled'
      | 'localToolEnvironment'
      | 'version'
    > & {
      conversationHtmlRenderingEnabled?: boolean
      version: number
    }
  ): Promise<StoredApplicationSettings> {
    const resolved = await this.legacyLocalToolEnvironmentResolver()
    const selection = (
      executablePath: string | undefined
    ): LocalToolEnvironmentSettings['node'] =>
      executablePath &&
      localToolExecutablePathSchema.safeParse(executablePath).success
        ? { source: 'custom', executablePath }
        : { source: 'managed' }
    const next: StoredApplicationSettings = {
      ...settings,
      conversationHtmlRenderingEnabled:
        settings.conversationHtmlRenderingEnabled ?? true,
      version: CURRENT_SETTINGS_VERSION,
      localToolEnvironment: {
        node: selection(resolved.nodeExecutablePath),
        python: selection(resolved.pythonExecutablePath),
        artifactDownloadSource: 'native'
      }
    }
    await this.persist(next)
    return next
  }

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
        const versionTenResult =
          versionTenStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionTenResult.success) {
          const next: StoredApplicationSettings = {
            ...versionTenResult.data,
            version: CURRENT_SETTINGS_VERSION,
            conversationHtmlRenderingEnabled: true
          }
          await this.persist(next)
          return next
        }
        const versionNineResult =
          versionNineStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionNineResult.success) {
          return this.migrateLegacy(versionNineResult.data)
        }
        const versionEightResult =
          versionEightStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionEightResult.success) {
          return this.migrateLegacy({
            ...versionEightResult.data,
            version: CURRENT_SETTINGS_VERSION,
            remoteProjectsEnabled: false
          })
        }
        const versionSevenResult =
          versionSevenStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionSevenResult.success) {
          return this.migrateLegacy({
            ...versionSevenResult.data,
            version: CURRENT_SETTINGS_VERSION,
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true
          })
        }
        const versionSixResult =
          versionSixStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionSixResult.success) {
          return this.migrateLegacy({
            ...versionSixResult.data,
            version: CURRENT_SETTINGS_VERSION,
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true
          })
        }
        const versionFiveResult =
          versionFiveStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionFiveResult.success) {
          return this.migrateLegacy({
            ...versionFiveResult.data,
            version: CURRENT_SETTINGS_VERSION,
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true
          })
        }
        const versionFourResult =
          versionFourStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionFourResult.success) {
          return this.migrateLegacy({
            ...versionFourResult.data,
            version: CURRENT_SETTINGS_VERSION,
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true,
            lastSeenReleaseNotesVersion: null
          })
        }
        const versionThreeResult =
          versionThreeStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionThreeResult.success) {
          return this.migrateLegacy({
            ...versionThreeResult.data,
            version: CURRENT_SETTINGS_VERSION,
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true,
            magicNoteCommentFormat: 'combined',
            lastSeenReleaseNotesVersion: null
          })
        }
        const versionTwoResult =
          versionTwoStoredApplicationSettingsSchema.safeParse(parsed)
        if (versionTwoResult.success) {
          return this.migrateLegacy({
            ...versionTwoResult.data,
            version: CURRENT_SETTINGS_VERSION,
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesShowIncompleteTodoCount: true,
            magicNoteCommentMode: 'immediate',
            magicNoteCommentFormat: 'combined',
            lastSeenReleaseNotesVersion: null
          })
        }
        const legacyResult =
          legacyStoredApplicationSettingsSchema.safeParse(parsed)
        if (legacyResult.success) {
          return this.migrateLegacy({
            version: CURRENT_SETTINGS_VERSION,
            checkUpdatesOnStartup: legacyResult.data.checkUpdatesOnStartup,
            updateSource: 'github',
            modelDownloadSource: 'modelscope',
            remoteProjectsEnabled: false,
            magicNotesEnabled: false,
            magicNotesShowIncompleteTodoCount: true,
            magicNoteCommentMode: 'immediate',
            magicNoteCommentFormat: 'combined',
            lastSeenReleaseNotesVersion: null
          })
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
      localToolEnvironment: stored.localToolEnvironment,
      conversationHtmlRenderingEnabled:
        stored.conversationHtmlRenderingEnabled,
      remoteProjectsEnabled: stored.remoteProjectsEnabled,
      magicNotesEnabled: stored.magicNotesEnabled,
      magicNotesShowIncompleteTodoCount:
        stored.magicNotesShowIncompleteTodoCount,
      magicNoteCommentMode: stored.magicNoteCommentMode,
      magicNoteCommentFormat: stored.magicNoteCommentFormat,
      ...(this.warnings.length > 0 ? { warnings: [...this.warnings] } : {})
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
        localToolEnvironment: next.localToolEnvironment,
        conversationHtmlRenderingEnabled:
          next.conversationHtmlRenderingEnabled,
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
