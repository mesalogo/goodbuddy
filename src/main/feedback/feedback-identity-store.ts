import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import {
  isolateCorruptSettingsFile,
  isMissingFileError,
  writeJsonFileAtomically
} from '../settings-file-utils'

const feedbackIdentitySchema = z
  .object({
    version: z.literal(1),
    installationId: z.uuid()
  })
  .strict()

export class FeedbackIdentityStore {
  private installationId?: string
  private loadOperation?: Promise<string>

  constructor(
    private readonly filePath: string,
    private readonly createUuid: () => string = randomUUID
  ) {}

  getInstallationId(): Promise<string> {
    if (this.installationId) {
      return Promise.resolve(this.installationId)
    }
    if (this.loadOperation) {
      return this.loadOperation
    }
    const operation = this.loadOrCreate().then((installationId) => {
      this.installationId = installationId
      return installationId
    })
    this.loadOperation = operation
    void operation.then(
      () => {
        if (this.loadOperation === operation) {
          this.loadOperation = undefined
        }
      },
      () => {
        if (this.loadOperation === operation) {
          this.loadOperation = undefined
        }
      }
    )
    return operation
  }

  async clear(): Promise<void> {
    await this.loadOperation?.catch(() => undefined)
    this.installationId = undefined
    await rm(this.filePath, { force: true })
    const directory = dirname(this.filePath)
    const corruptPrefix = `${basename(this.filePath)}.corrupt-`
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if (isMissingFileError(error)) {
        return
      }
      throw error
    }
    await Promise.all(
      entries
        .filter((name) => name.startsWith(corruptPrefix))
        .map((name) =>
          rm(join(directory, name), { force: true })
        )
    )
  }

  private async loadOrCreate(): Promise<string> {
    let serialized: string
    try {
      serialized = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) {
        return this.create()
      }
      throw error
    }

    try {
      return feedbackIdentitySchema.parse(
        JSON.parse(serialized) as unknown
      ).installationId
    } catch {
      await isolateCorruptSettingsFile(
        this.filePath,
        '无法隔离损坏的反馈安装标识'
      )
      return this.create()
    }
  }

  private async create(): Promise<string> {
    const installationId = z.uuid().parse(this.createUuid())
    await writeJsonFileAtomically(this.filePath, {
      version: 1,
      installationId
    })
    return installationId
  }
}
