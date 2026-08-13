import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  documentParsingSettingsSchema,
  documentParsingSettingsUpdateSchema,
  type DocumentParsingSettings
} from '../shared/document-parsing-contracts'
import type { SettingsWarning } from '../shared/settings-warning-contracts'
import {
  assertSupportedSettingsVersion,
  isolateCorruptSettingsFile,
  isMissingFileError,
  UnsupportedSettingsVersionError,
  writeJsonFileAtomically
} from './settings-file-utils'

const CURRENT_SETTINGS_VERSION = 3

const storedDocumentParsingSettingsSchema =
  documentParsingSettingsSchema
    .extend({
      version: z.literal(CURRENT_SETTINGS_VERSION)
    })
    .strict()

type StoredDocumentParsingSettings = z.infer<
  typeof storedDocumentParsingSettingsSchema
>

const legacyVersionTwoSettingsSchema = z
  .object({
    version: z.literal(2),
    chatWorkflow: z.enum(['auto', 'fast-text', 'high-fidelity']),
    knowledgeWorkflow: z.enum([
      'complete-index',
      'fast-index',
      'high-fidelity'
    ]),
    pdfOcrMode: z.enum(['auto', 'always', 'disabled']),
    ocrProvider: z.literal('local'),
    localOcrEnabled: z.boolean(),
    localOcrModelId: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    maximumPages: z.number().int().min(1).max(500),
    ocrConcurrency: z.number().int().min(1).max(4),
    pageTimeoutSeconds: z.number().int().min(10).max(300)
  })
  .strict()

const legacyVersionOneSettingsSchema =
  legacyVersionTwoSettingsSchema
    .omit({ version: true, ocrProvider: true })
    .extend({
      version: z.literal(1),
      chatCloudPermission: z.enum(['ask', 'always', 'never']),
      knowledgeCloudPermission: z.enum(['ask', 'always', 'never'])
    })
    .strict()

export const defaultDocumentParsingSettings: DocumentParsingSettings = {
  chatWorkflow: 'auto',
  knowledgeWorkflow: 'complete-index',
  localOcrModelId: 'pp-ocrv6-tiny',
  maximumPages: 100,
  pageTimeoutSeconds: 60
}

type LegacySettings = z.infer<
  typeof legacyVersionTwoSettingsSchema
>

function migrateLegacySettings(
  legacy: LegacySettings
): StoredDocumentParsingSettings {
  const ocrDisabled =
    !legacy.localOcrEnabled || legacy.pdfOcrMode === 'disabled'
  const ocrAlways = legacy.pdfOcrMode === 'always'
  return {
    version: CURRENT_SETTINGS_VERSION,
    chatWorkflow: ocrDisabled
      ? 'fast-text'
      : legacy.chatWorkflow === 'auto' && ocrAlways
        ? 'high-fidelity'
        : legacy.chatWorkflow,
    knowledgeWorkflow: ocrDisabled
      ? 'fast-index'
      : legacy.knowledgeWorkflow === 'complete-index' && ocrAlways
        ? 'high-fidelity'
        : legacy.knowledgeWorkflow,
    localOcrModelId: legacy.localOcrModelId,
    maximumPages: legacy.maximumPages,
    pageTimeoutSeconds: legacy.pageTimeoutSeconds
  }
}

export class DocumentParsingSettingsStore {
  private settings?: StoredDocumentParsingSettings
  private settingsLoad?: Promise<StoredDocumentParsingSettings>
  private warnings: SettingsWarning[] = []
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private async isolateCorruptFile(): Promise<void> {
    await isolateCorruptSettingsFile(
      this.filePath,
      '文档解析设置损坏且无法隔离'
    )
  }

  private loadStored(): Promise<StoredDocumentParsingSettings> {
    if (this.settings) {
      return Promise.resolve(this.settings)
    }
    if (!this.settingsLoad) {
      this.settingsLoad = this.readStored().finally(() => {
        this.settingsLoad = undefined
      })
    }
    return this.settingsLoad
  }

  private async readStored(): Promise<StoredDocumentParsingSettings> {
    try {
      const contents = await readFile(this.filePath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(contents) as unknown
      } catch {
        await this.isolateCorruptFile()
        this.warnings = [{ code: 'document-parsing-settings-recovered' }]
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          ...defaultDocumentParsingSettings
        }
        return this.settings
      }
      assertSupportedSettingsVersion(
        parsed,
        CURRENT_SETTINGS_VERSION,
        (version) =>
          `当前 GoodBuddy 不支持文档解析设置版本 ${version}，请升级应用后重试`
      )
      const result =
        storedDocumentParsingSettingsSchema.safeParse(parsed)
      if (!result.success) {
        const versionTwo =
          legacyVersionTwoSettingsSchema.safeParse(parsed)
        if (versionTwo.success) {
          this.settings = migrateLegacySettings(versionTwo.data)
          return this.settings
        }
        const versionOne =
          legacyVersionOneSettingsSchema.safeParse(parsed)
        if (versionOne.success) {
          const {
            chatCloudPermission: _chatCloudPermission,
            knowledgeCloudPermission: _knowledgeCloudPermission,
            ...legacy
          } = versionOne.data
          void _chatCloudPermission
          void _knowledgeCloudPermission
          this.settings = migrateLegacySettings({
            ...legacy,
            version: 2,
            ocrProvider: 'local',
          })
          return this.settings
        }
        await this.isolateCorruptFile()
        this.warnings = [{ code: 'document-parsing-settings-recovered' }]
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          ...defaultDocumentParsingSettings
        }
        return this.settings
      }
      this.settings = result.data
    } catch (error) {
      if (error instanceof UnsupportedSettingsVersionError) {
        throw error
      }
      if (!isMissingFileError(error)) {
        throw new Error('无法读取文档解析设置', { cause: error })
      }
      this.settings = {
        version: CURRENT_SETTINGS_VERSION,
        ...defaultDocumentParsingSettings
      }
    }
    return this.settings
  }

  async get(): Promise<DocumentParsingSettings> {
    const { version: _version, ...settings } = await this.loadStored()
    void _version
    return documentParsingSettingsSchema.parse(settings)
  }

  getWarnings(): readonly SettingsWarning[] {
    return this.warnings
  }

  update(input: unknown): Promise<DocumentParsingSettings> {
    const operation = this.updateQueue.then(async () => {
      const updates = documentParsingSettingsUpdateSchema.parse(input)
      const next: StoredDocumentParsingSettings = {
        version: CURRENT_SETTINGS_VERSION,
        ...updates
      }
      await writeJsonFileAtomically(this.filePath, next)
      this.settings = next
      this.warnings = []
      return this.get()
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
