import { randomUUID } from 'node:crypto'

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
  totalBytes: number
}

// Implement in the existing attachment/storage owner. The handle identifies the
// same content during capture, paging and history adoption; release drops only
// the call's reference, never a reference already adopted by persisted history.
export interface PagedOutputBackingStore {
  create(ownerId: string, handle: string): Promise<void>
  append(ownerId: string, handle: string, bytes: Uint8Array): Promise<void>
  finish(ownerId: string, handle: string, totalBytes: number): Promise<void>
  read(ownerId: string, handle: string, cursor: number, length: number): Promise<Uint8Array>
  release(ownerId: string, handle: string): Promise<void>
}

export type PagedOutputStoreOptions = {
  backingStore?: PagedOutputBackingStore
}

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_OUTPUTS = 4096
const WRITE_BYTES = 64 * 1024
// Shared across process, search and subagent stores, including in-flight writes.
let captureBytes = 0

export class PagedOutputWriter {
  private preview: Buffer
  private previewLength = 0
  private totalBytes = 0
  private failure?: Error
  private closed = false
  private pending = Promise.resolve()
  private pendingCount = 0
  private backed = false
  private released = false
  private finishing?: Promise<{ text: string; truncated: boolean; reference?: PagedOutputReference }>

  constructor(
    private readonly store: PagedOutputStore,
    readonly handle: string,
    readonly ownerId: string,
    private readonly previewBytes: number
  ) {
    if (captureBytes + previewBytes > MAX_CAPTURE_BYTES) throw new Error('Tool output capture is busy')
    this.preview = Buffer.alloc(previewBytes)
    captureBytes += previewBytes
  }

  append(chunk: Buffer | string): Promise<void> {
    if (this.closed || this.failure) {
      throw this.failure ?? new Error('分页输出已经关闭')
    }
    const length = Buffer.byteLength(chunk)
    if (!length) return Promise.resolve()
    const previousLength = this.previewLength
    const spill = this.backed || this.totalBytes + length > this.previewBytes
    if (spill) {
      try {
        void this.store.backing
      } catch (error) {
        this.failure = error as Error
        throw error
      }
    }
    if (spill && (captureBytes + length > MAX_CAPTURE_BYTES || this.pendingCount >= 1024)) {
      this.failure = new Error('Tool output capture is busy; producer must await append')
      throw this.failure
    }
    const value = Buffer.from(chunk)
    this.previewLength += value.copy(this.preview, this.previewLength, 0, this.previewBytes - this.previewLength)
    this.totalBytes += length
    if (!spill) return Promise.resolve()
    const create = !this.backed
    this.backed = true
    captureBytes += length
    this.pendingCount += 1
    const write = this.pending.then(async () => {
      if (this.failure) throw this.failure
      if (create) {
        await this.store.backing.create(this.ownerId, this.handle)
        await this.write(this.preview.subarray(0, previousLength))
      }
      await this.write(value)
    }).finally(() => {
      captureBytes -= length
      this.pendingCount -= 1
    })
    this.pending = write.catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error('无法保存分页输出')
    })
    return write
  }

  private async write(value: Buffer): Promise<void> {
    for (let offset = 0; offset < value.length; offset += WRITE_BYTES) {
      await this.store.backing.append(this.ownerId, this.handle, value.subarray(offset, offset + WRITE_BYTES))
    }
  }

  finish(): Promise<{ text: string; truncated: boolean; reference?: PagedOutputReference }> {
    if (this.closed) return Promise.reject(new Error('分页输出已经关闭'))
    this.finishing = this.finishOnce()
    return this.finishing
  }

  private async finishOnce(): Promise<{
    text: string
    truncated: boolean
    reference?: PagedOutputReference
  }> {
    if (this.closed) {
      throw new Error('分页输出已经关闭')
    }
    this.closed = true
    await this.pending
    if (this.failure) {
      await this.store.discard(this)
      throw new Error('无法保存完整工具输出', { cause: this.failure })
    }
    let previewLength = utf8PrefixLength(this.preview, this.previewLength)
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
    try {
      if (!this.backed) {
        void this.store.backing
        this.backed = true
        await this.store.backing.create(this.ownerId, this.handle)
        await this.write(this.preview.subarray(0, this.previewLength))
      }
      await this.store.backing.finish(this.ownerId, this.handle, this.totalBytes)
      this.store.retain(this, this.totalBytes)
    } catch (error) {
      await this.store.discard(this)
      throw error
    } finally {
      this.releaseMemory()
    }
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
    this.closed = true
    await this.finishing?.catch(() => undefined)
    await this.pending
    await this.store.discard(this)
  }

  releaseMemory(): void {
    captureBytes -= this.preview.byteLength
    this.preview = Buffer.alloc(0)
  }

  async releaseBacking(): Promise<void> {
    this.releaseMemory()
    if (this.backed && !this.released) {
      await this.store.backing.release(this.ownerId, this.handle)
      this.released = true
    }
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
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(
    private readonly handlePrefix: string,
    private readonly options: PagedOutputStoreOptions = {}
  ) {}

  get backing(): PagedOutputBackingStore {
    if (!this.options.backingStore) throw new Error('Full output storage owner is not configured')
    return this.options.backingStore
  }

  async create(
    ownerId: string,
    previewBytes: number
  ): Promise<PagedOutputWriter> {
    if (this.disposed) {
      throw new Error('分页输出存储已关闭')
    }
    if (!Number.isSafeInteger(previewBytes) || previewBytes < 1 || previewBytes > MAX_CAPTURE_BYTES) {
      throw new Error('Invalid output preview size')
    }
    if (this.writers.size + this.entries.size >= MAX_OUTPUTS) throw new Error('Tool output store is busy')
    const id = randomUUID()
    const writer = new PagedOutputWriter(
      this,
      `${this.handlePrefix}:${id}`,
      ownerId,
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
    const buffer = requestedBytes === 0 ? Buffer.alloc(0) : Buffer.from(
      await this.backing.read(ownerId, handle, cursor, requestedBytes)
    )
    const bytesRead = buffer.byteLength
    if (bytesRead !== requestedBytes) throw new Error('Incomplete stored tool output')
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
      await this.backing.release(ownerId, handle)
      this.entries.delete(handle)
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce().catch((error: unknown) => {
      this.disposePromise = undefined
      throw error
    })
    return this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.writers].map((writer) => writer.abort()))
    for (const [handle, entry] of this.entries) {
      await this.backing.release(entry.ownerId, handle)
      this.entries.delete(handle)
    }
  }

  retain(writer: PagedOutputWriter, totalBytes: number): void {
    this.writers.delete(writer)
    this.entries.set(writer.handle, {
      ownerId: writer.ownerId,
      totalBytes
    })
  }

  async discard(writer: PagedOutputWriter): Promise<void> {
    await writer.releaseBacking()
    this.writers.delete(writer)
    this.entries.delete(writer.handle)
  }
}
