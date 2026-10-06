import { mkdir, mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PagedOutputBackingStore } from '../../src/main/agent/paged-output-store'

export const outputFixtureRoot = resolve('temp/goodbuddy-output-upgrade')

// Real asynchronous file IO for contract tests, not a production storage owner.
export class FileOutputBacking implements PagedOutputBackingStore {
  private directory?: Promise<string>
  private readonly entries = new Map<string, { owner: string; path: string; file?: FileHandle }>()
  writes = 0
  maximumWriteBytes = 0

  async create(owner: string, handle: string): Promise<void> {
    this.directory ??= mkdir(outputFixtureRoot, { recursive: true }).then(() =>
      mkdtemp(join(outputFixtureRoot, 'backing-')))
    const path = join(await this.directory, handle.replace(':', '-'))
    const file = await open(path, 'wx+')
    this.entries.set(handle, { owner, path, file })
  }

  private entry(owner: string, handle: string) {
    const entry = this.entries.get(handle)
    if (!entry || entry.owner !== owner) throw new Error('Unknown output owner')
    return entry
  }

  async append(owner: string, handle: string, bytes: Uint8Array): Promise<void> {
    const { file } = this.entry(owner, handle)
    if (!file) throw new Error('Output already finished')
    this.writes += 1
    this.maximumWriteBytes = Math.max(this.maximumWriteBytes, bytes.byteLength)
    for (let offset = 0; offset < bytes.byteLength;) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset)
      if (!bytesWritten) throw new Error('Output write made no progress')
      offset += bytesWritten
    }
  }

  async finish(owner: string, handle: string, totalBytes: number): Promise<void> {
    const entry = this.entry(owner, handle)
    await entry.file?.close()
    entry.file = undefined
    if ((await stat(entry.path)).size !== totalBytes) throw new Error('Output size mismatch')
  }

  async read(owner: string, handle: string, cursor: number, length: number): Promise<Uint8Array> {
    const file = await open(this.entry(owner, handle).path, 'r')
    try {
      const bytes = Buffer.alloc(length)
      let offset = 0
      while (offset < length) {
        const { bytesRead } = await file.read(bytes, offset, length - offset, cursor + offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      return bytes.subarray(0, offset)
    } finally {
      await file.close()
    }
  }

  async release(owner: string, handle: string): Promise<void> {
    if (!this.entries.has(handle)) return
    const entry = this.entry(owner, handle)
    await entry.file?.close()
    entry.file = undefined
    await rm(entry.path, { force: true })
    this.entries.delete(handle)
  }

  get count(): number { return this.entries.size }
  get createdDirectory(): boolean { return this.directory !== undefined }

  async dispose(): Promise<void> {
    for (const [handle, entry] of this.entries) await this.release(entry.owner, handle)
    if (this.directory) await rm(await this.directory, { recursive: true, force: true })
  }
}
