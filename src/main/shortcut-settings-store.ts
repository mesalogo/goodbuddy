import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  defaultGlobalShortcutSettings,
  globalShortcutSettingsSchema,
  type GlobalShortcutSettings
} from '../shared/shortcut'
import {
  assertSupportedSettingsVersion,
  isolateCorruptSettingsFile,
  isMissingFileError,
  UnsupportedSettingsVersionError,
  writeJsonFileAtomically
} from './settings-file-utils'

const CURRENT_SETTINGS_VERSION = 1

const storedShortcutSettingsSchema = globalShortcutSettingsSchema
  .extend({ version: z.literal(CURRENT_SETTINGS_VERSION) })
  .strict()

type StoredShortcutSettings = z.infer<
  typeof storedShortcutSettingsSchema
>

export class ShortcutSettingsStore {
  private settings?: StoredShortcutSettings
  private loadOperation?: Promise<StoredShortcutSettings>
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private async readStored(): Promise<StoredShortcutSettings> {
    try {
      const contents = await readFile(this.filePath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(contents) as unknown
      } catch {
        await isolateCorruptSettingsFile(
          this.filePath,
          'Shortcut settings are corrupt and could not be isolated'
        )
        return {
          version: CURRENT_SETTINGS_VERSION,
          ...defaultGlobalShortcutSettings
        }
      }
      assertSupportedSettingsVersion(
        parsed,
        CURRENT_SETTINGS_VERSION,
        (version) =>
          `当前 GoodBuddy 不支持快捷键设置版本 ${version}，请升级应用后重试`
      )
      const result = storedShortcutSettingsSchema.safeParse(parsed)
      if (!result.success) {
        await isolateCorruptSettingsFile(
          this.filePath,
          'Shortcut settings are corrupt and could not be isolated'
        )
        return {
          version: CURRENT_SETTINGS_VERSION,
          ...defaultGlobalShortcutSettings
        }
      }
      return result.data
    } catch (error) {
      if (error instanceof UnsupportedSettingsVersionError) {
        throw error
      }
      if (!isMissingFileError(error)) {
        throw new Error('Shortcut settings could not be read', {
          cause: error
        })
      }
      return {
        version: CURRENT_SETTINGS_VERSION,
        ...defaultGlobalShortcutSettings
      }
    }
  }

  private async load(): Promise<StoredShortcutSettings> {
    if (this.settings) {
      return this.settings
    }
    if (!this.loadOperation) {
      this.loadOperation = this.readStored()
        .then((settings) => {
          this.settings = settings
          return settings
        })
        .finally(() => {
          this.loadOperation = undefined
        })
    }
    return this.loadOperation
  }

  async get(): Promise<GlobalShortcutSettings> {
    const { enabled, accelerator } = await this.load()
    return { enabled, accelerator }
  }

  update(input: unknown): Promise<GlobalShortcutSettings> {
    const operation = this.updateQueue.then(async () => {
      const settings = globalShortcutSettingsSchema.parse(input)
      const stored: StoredShortcutSettings = {
        version: CURRENT_SETTINGS_VERSION,
        ...settings
      }
      await writeJsonFileAtomically(this.filePath, stored)
      this.settings = stored
      return settings
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
