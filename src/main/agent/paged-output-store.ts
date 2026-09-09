import { randomUUID } from 'node:crypto'
import {
  closeSync,
  openSync,
  readSync,
  writeSync
} from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PAGED_OUTPUT_DEFAULT_PAGE_BYTES = 32 * 1024
export const PAGED_OUTPUT_MAX_PAGE_BYTES = 32 * 1024

export type PagedOutputReference = {
  handle: string
  nextCursor: number
  totalBytes: number
}

export type PagedOutputPage = {
  handle: string
  content: string
  cursor: number
  nextCursor: number
  totalBytes: number
  eof: boolean
}

type OutputEntry = {
  ownerId: string
  path: string
  totalBytes: number
}

export type PagedOutputStoreOptions = {
  temporaryParentDirectory?: string
}

export class PagedOutputWriter {
  private preview = Buffer.alloc(0)
  private totalBytes = 0
  private failure?: Error
  private closed = false

  constructor(
    private readonly store: PagedOutputStore,
    readonly handle: string,
    readonly ownerId: string,
    readonly path: string,
    private readonly descriptor: number,
    private readonly previewBytes: number
  ) {}

  append(chunk: Buffer | string): void {
    if (this.closed || this.failure) {
      return
    }
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    try {
      let offset = 0
      while (offset < value.byteLength) {
        const written = writeSync(this.descriptor, value, offset)
        if (written === 0) throw new Error('Unable to write tool output')
        offset += written
      }
      this.totalBytes += value.byteLength
      if (this.preview.byteLength < this.previewBytes) {
        const remaining = this.previewBytes - this.preview.byteLength
        this.preview = Buffer.concat([
          this.preview,
          value.subarray(0, remaining)
        ])
      }
    } catch (error) {
      this.failure =
        error instanceof Error ? error : new Error('无法保存分页输出')
    }
  }

  async finish(): Promise<{
    text: string
    truncated: boolean
    reference?: PagedOutputReference
  }> {
    if (this.closed) {
      throw new Error('分页输出已经关闭')
    }
    this.closed = true
    closeSync(this.descriptor)
    if (this.failure) {
      await this.store.discard(this)
      throw new Error('无法保存完整工具输出', { cause: this.failure })
    }
    let previewLength = utf8PrefixLength(this.preview)
    let text = this.preview.subarray(0, previewLength).toString('utf8')
    // Tool results are JSON: escaped control characters also consume context.
    if (Buffer.byteLength(JSON.stringify(text)) - 2 > this.previewBytes) {
      let low = 0
      let high = previewLength
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const candidate = utf8Prefix(this.preview.subarray(0, middle))
        if (Buffer.byteLength(JSON.stringify(candidate)) - 2 <= this.previewBytes) {
          low = middle
        } else {
          high = middle - 1
        }
      }
      previewLength = utf8PrefixLength(this.preview, low)
      text = this.preview.subarray(0, previewLength).toString('utf8')
    }
    if (this.totalBytes <= previewLength) {
      await this.store.discard(this)
      return { text, truncated: false }
    }
    this.store.retain(this, this.totalBytes)
    return {
      text,
      truncated: true,
      reference: {
        handle: this.handle,
        nextCursor: previewLength,
        totalBytes: this.totalBytes
      }
    }
  }

  async abort(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      closeSync(this.descriptor)
    }
    await this.store.discard(this)
  }
}

function utf8PrefixLength(value: Buffer, end = value.byteLength): number {
  if (end === 0) return 0
  let start = end - 1
  while (start > 0 && (value[start]! & 0xc0) === 0x80) start -= 1
  const lead = value[start]!
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return start + width > end ? start : end
}

function utf8Prefix(value: Buffer): string {
  return value.subarray(0, utf8PrefixLength(value)).toString('utf8')
}

export class PagedOutputStore {
  private readonly entries = new Map<string, OutputEntry>()
  private readonly writers = new Set<PagedOutputWriter>()
  private directoryPromise?: Promise<string>
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(
    private readonly handlePrefix: string,
    private readonly options: PagedOutputStoreOptions = {}
  ) {}

  async create(
    ownerId: string,
    previewBytes: number
  ): Promise<PagedOutputWriter> {
    if (this.disposed) {
      throw new Error('分页输出存储已关闭')
    }
    const directory = await this.getDirectory()
    if (this.disposed) throw new Error('分页输出存储已关闭')
    const id = randomUUID()
    const path = join(directory, id)
    const descriptor = openSync(path, 'wx')
    const writer = new PagedOutputWriter(
      this,
      `${this.handlePrefix}:${id}`,
      ownerId,
      path,
      descriptor,
      previewBytes
    )
    this.writers.add(writer)
    return writer
  }

  async read(
    ownerId: string,
    handle: string,
    cursor = 0,
    limitBytes = PAGED_OUTPUT_DEFAULT_PAGE_BYTES
  ): Promise<PagedOutputPage> {
    const entry = this.entries.get(handle)
    if (!entry || entry.ownerId !== ownerId) {
      throw new Error('分页输出句柄不存在或不属于当前会话')
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entry.totalBytes) {
      throw new Error('分页输出 cursor 无效')
    }
    if (
      !Number.isSafeInteger(limitBytes) ||
      limitBytes < 1 ||
      limitBytes > PAGED_OUTPUT_MAX_PAGE_BYTES
    ) {
      throw new Error(`分页输出每次最多读取 ${PAGED_OUTPUT_MAX_PAGE_BYTES} 字节`)
    }

    const requestedBytes = Math.min(limitBytes + 3, entry.totalBytes - cursor)
    const buffer = Buffer.alloc(requestedBytes)
    const descriptor = openSync(entry.path, 'r')
    let bytesRead: number
    try {
      bytesRead = readSync(descriptor, buffer, 0, requestedBytes, cursor)
    } finally {
      closeSync(descriptor)
    }
    if (bytesRead && (buffer[0]! & 0xc0) === 0x80) {
      throw new Error('分页输出 cursor 必须位于 UTF-8 字符边界')
    }
    let consumedBytes = utf8PrefixLength(buffer, Math.min(limitBytes, bytesRead))
    // A tiny page still consumes one complete character (at most four bytes).
    if (consumedBytes === 0 && bytesRead > 0) {
      consumedBytes = utf8PrefixLength(buffer, Math.min(4, bytesRead))
    }
    // Preserve forward progress even for an incomplete final UTF-8 sequence.
    if (consumedBytes === 0) consumedBytes = bytesRead
    const content = buffer.subarray(0, consumedBytes).toString('utf8')
    const nextCursor = cursor + consumedBytes
    return {
      handle,
      content,
      cursor,
      nextCursor,
      totalBytes: entry.totalBytes,
      eof: nextCursor >= entry.totalBytes
    }
  }

  async releaseOwner(ownerId: string): Promise<void> {
    await Promise.all([...this.writers]
      .filter((writer) => writer.ownerId === ownerId)
      .map((writer) => writer.abort()))
    const owned = [...this.entries].filter(
      ([, entry]) => entry.ownerId === ownerId
    )
    for (const [handle] of owned) {
      this.entries.delete(handle)
    }
    await Promise.allSettled(
      owned.map(([, entry]) => rm(entry.path, { force: true }))
    )
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce()
    return this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.writers].map((writer) => writer.abort()))
    this.entries.clear()
    if (this.directoryPromise) {
      const directory = await this.directoryPromise.catch(() => undefined)
      if (directory) {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }

  retain(writer: PagedOutputWriter, totalBytes: number): void {
    this.writers.delete(writer)
    this.entries.set(writer.handle, {
      ownerId: writer.ownerId,
      path: writer.path,
      totalBytes
    })
  }

  async discard(writer: PagedOutputWriter): Promise<void> {
    this.writers.delete(writer)
    this.entries.delete(writer.handle)
    await rm(writer.path, { force: true })
  }

  private getDirectory(): Promise<string> {
    this.directoryPromise ??= this.createDirectory()
    return this.directoryPromise
  }

  private async createDirectory(): Promise<string> {
    const parent = this.options.temporaryParentDirectory ?? tmpdir()
    await mkdir(parent, { recursive: true })
    return await mkdtemp(join(parent, `goodbuddy-${this.handlePrefix}-`))
  }
}
