import { randomBytes } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  documentParsingSettingsSchema,
  documentParsingSettingsUpdateSchema,
  type DocumentParsingSettings
} from '../shared/document-parsing-contracts'

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

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

export class DocumentParsingSettingsStore {
  private settings?: StoredDocumentParsingSettings
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
        throw new Error('文档解析设置损坏且无法隔离', {
          cause: error
        })
      }
    }
  }

  private async loadStored(): Promise<StoredDocumentParsingSettings> {
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
          ...defaultDocumentParsingSettings
        }
        return this.settings
      }
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
        this.settings = {
          version: CURRENT_SETTINGS_VERSION,
          ...defaultDocumentParsingSettings
        }
        return this.settings
      }
      this.settings = result.data
    } catch (error) {
      if (!isMissingFile(error)) {
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

  update(input: unknown): Promise<DocumentParsingSettings> {
    const operation = this.updateQueue.then(async () => {
      const updates = documentParsingSettingsUpdateSchema.parse(input)
      const next: StoredDocumentParsingSettings = {
        version: CURRENT_SETTINGS_VERSION,
        ...updates
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
      return this.get()
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
