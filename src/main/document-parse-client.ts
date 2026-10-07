import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { KnowledgeChunkingSettings } from '../shared/knowledge-contracts'
import {
  assertDocumentBuffer,
  chunkDocumentAdvanced,
  DocumentTextUnavailableError,
  extractPdfTextPages,
  parseDocument,
  type DocumentChunk,
  type ParsedDocument,
  type PdfTextExtraction,
  type PdfTextExtractionOptions
} from './knowledge/document-parser'
import { extractPptxPages, type PptxPage } from './knowledge/pptx-parser'
import type {
  DocumentParseOperation,
  DocumentParseRequest,
  DocumentParseResponse,
  SerializedDocumentParseError
} from './document-parse-errors'

export type { DocumentParseOperation } from './document-parse-errors'

// PERF-15/16: pure document work (PDF / Office / text parsing, chunking,
// hashing) runs in a single worker thread with a FIFO queue, so Main only
// orchestrates. Database writes stay on the caller's side, in the same order.
// Same fallback rules as readonly-query-reader: if the worker cannot start or
// crashes, the call runs inline (the previous behaviour) and the worker is
// retried after a backoff. Aborting a running task terminates the worker.

/** Worker infrastructure failure; callers fall back to the inline path. */
export class DocumentParseWorkerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DocumentParseWorkerUnavailableError'
  }
}

type Task = {
  id: number
  op: DocumentParseOperation
  args: unknown[]
  transfer: ArrayBuffer[]
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

const RESTART_BACKOFF_MS = 30_000

type PdfExceptionConstructor = new (message: string) => Error
type PdfExceptionClasses = Partial<Record<string, PdfExceptionConstructor>>
const pdfExceptionNames = [
  'AbortException',
  'InvalidPDFException',
  'PasswordException',
  'ResponseException',
  'UnknownErrorException'
] as const

let pdfExceptions: Promise<PdfExceptionClasses> | undefined

/** PDF.js exception classes, loaded only once a PDF error crosses the boundary. */
function loadPdfExceptions(): Promise<PdfExceptionClasses> {
  pdfExceptions ??= import('pdfjs-dist/legacy/build/pdf.mjs').then(
    (pdfjs) => {
      const module = pdfjs as unknown as Record<string, unknown>
      return Object.fromEntries(pdfExceptionNames.flatMap((name) =>
        typeof module[name] === 'function' ? [[name, module[name] as PdfExceptionConstructor]] : []))
    },
    () => ({})
  )
  return pdfExceptions
}

/**
 * Rebuilds an error with the same class, name, message, cause and primitive
 * fields as the one thrown inline (stack traces differ by nature).
 */
export async function deserializeDocumentParseError(error: SerializedDocumentParseError): Promise<Error> {
  let result: Error
  if (error.name === 'DocumentTextUnavailableError') {
    result = new DocumentTextUnavailableError(error.message)
  } else if ((pdfExceptionNames as readonly string[]).includes(error.name)) {
    const Constructor = (await loadPdfExceptions())[error.name]
    result = Constructor ? new Constructor(error.message) : new Error(error.message)
  } else {
    const Constructor = error.name === 'RangeError' ? RangeError
      : error.name === 'TypeError' ? TypeError : Error
    result = new Constructor(error.message)
  }
  if (result.name !== error.name) result.name = error.name
  if (error.cause) {
    Object.defineProperty(result, 'cause', {
      value: await deserializeDocumentParseError(error.cause), writable: true, configurable: true
    })
  }
  for (const [key, value] of Object.entries(error.extra ?? {})) {
    Object.defineProperty(result, key, { value, writable: true, configurable: true, enumerable: true })
  }
  return result
}

export class DocumentParseWorkerClient {
  private worker?: Worker
  private nextId = 0
  private disabledUntil = 0
  private closed = false
  private active?: Task
  private readonly queue: Task[] = []

  constructor(
    private readonly workerPath: string,
    private readonly now: () => number = Date.now
  ) {}

  /** False while closed or backing off after a worker failure. */
  get available(): boolean {
    return !this.closed && this.now() >= this.disabledUntil
  }

  get pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0)
  }

  call<T>(
    op: DocumentParseOperation,
    args: unknown[],
    transfer: ArrayBuffer[] = [],
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed) return Promise.reject(new DocumentParseWorkerUnavailableError('Document parse worker closed'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.now() < this.disabledUntil) {
      return Promise.reject(new DocumentParseWorkerUnavailableError('Document parse worker is backing off'))
    }
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        id: ++this.nextId,
        op,
        args,
        transfer,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        if (this.active === task) {
          // The task is CPU-bound in the worker; stop it by terminating the worker.
          this.active = undefined
          const worker = this.worker
          this.worker = undefined
          if (worker) void worker.terminate()
        } else {
          const index = this.queue.indexOf(task)
          if (index < 0) return
          this.queue.splice(index, 1)
        }
        task.cleanup()
        reject(signal!.reason)
        this.pump()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(task)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || this.closed) return
    const task = this.queue.shift()
    if (!task) {
      this.worker?.unref()
      return
    }
    let worker: Worker
    try {
      worker = this.ensureWorker()
    } catch (error) {
      this.disabledUntil = this.now() + RESTART_BACKOFF_MS
      this.failAll(task, new DocumentParseWorkerUnavailableError('Document parse worker failed to start', { cause: error }))
      return
    }
    this.active = task
    // Keep the process alive only while a task is outstanding.
    worker.ref()
    try {
      worker.postMessage(
        { id: task.id, op: task.op, args: task.args } satisfies DocumentParseRequest,
        task.transfer
      )
    } catch (error) {
      this.active = undefined
      task.cleanup()
      task.reject(new DocumentParseWorkerUnavailableError('Document parse task could not be posted', { cause: error }))
      this.pump()
    }
  }

  private failAll(first: Task | undefined, error: Error): void {
    const tasks = [...(first ? [first] : []), ...this.queue.splice(0)]
    for (const task of tasks) {
      task.cleanup()
      task.reject(error)
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.workerPath)
    this.worker = worker
    worker.on('message', (message: DocumentParseResponse) => {
      const task = this.active
      if (this.worker !== worker || !task || task.id !== message.id) return
      this.active = undefined
      task.cleanup()
      if ('error' in message) {
        void deserializeDocumentParseError(message.error).then(task.reject)
      } else {
        task.resolve(message.result)
      }
      this.pump()
    })
    const failed = (error: Error): void => {
      // Ignore exits of workers that were terminated on purpose (abort, close).
      if (this.worker !== worker) return
      this.worker = undefined
      this.disabledUntil = this.now() + RESTART_BACKOFF_MS
      const active = this.active
      this.active = undefined
      this.failAll(active, new DocumentParseWorkerUnavailableError(error.message, { cause: error }))
      void worker.terminate()
    }
    worker.once('error', failed)
    worker.once('exit', (code) => failed(new Error(`Document parse worker exited (${code})`)))
    worker.unref()
    return worker
  }

  /** Test hook: simulate a crash by terminating the worker. */
  async terminateWorkerForTest(): Promise<void> {
    await this.worker?.terminate()
  }

  /** Test hook: end the post-crash backoff. */
  resetBackoffForTest(): void {
    this.disabledUntil = 0
  }

  close(): void {
    this.closed = true
    const worker = this.worker
    this.worker = undefined
    const active = this.active
    this.active = undefined
    this.failAll(active, new DocumentParseWorkerUnavailableError('Document parse worker closed'))
    if (worker) void worker.terminate()
  }
}

let sharedClient: DocumentParseWorkerClient | undefined

/** Enables the parse worker for this process (Main calls it once at startup). */
export function configureDocumentParseWorker(workerPath: string | undefined): void {
  sharedClient?.close()
  sharedClient = workerPath ? new DocumentParseWorkerClient(workerPath) : undefined
}

export function closeDocumentParseWorker(): void {
  sharedClient?.close()
  sharedClient = undefined
}

/** A private copy of the bytes that can be transferred without detaching the caller's buffer. */
function transferableCopy(buffer: Uint8Array): ArrayBuffer {
  return Uint8Array.prototype.slice.call(buffer).buffer as ArrayBuffer
}

/**
 * Runs `op` in the worker when available, otherwise inline. Worker
 * infrastructure failures fall back to the inline path; operation errors and
 * aborts propagate unchanged. An already-aborted signal also runs inline, so
 * validation and abort errors surface in exactly the inline order.
 */
export async function runOffMain<T>(
  client: DocumentParseWorkerClient | undefined,
  op: DocumentParseOperation,
  request: () => { args: unknown[]; transfer?: ArrayBuffer[] },
  signal: AbortSignal | undefined,
  inline: () => T | Promise<T>
): Promise<T> {
  if (!client?.available || signal?.aborted) return inline()
  const { args, transfer } = request()
  try {
    return await client.call<T>(op, args, transfer, signal)
  } catch (error) {
    if (error instanceof DocumentParseWorkerUnavailableError && !signal?.aborted) return inline()
    throw error
  }
}

export function parseDocumentOffMain(
  name: string,
  buffer: Buffer,
  signal?: AbortSignal,
  client: DocumentParseWorkerClient | undefined = sharedClient
): Promise<ParsedDocument> {
  // Cheap size checks stay inline so oversized input is never copied.
  try {
    assertDocumentBuffer(buffer)
  } catch (error) {
    return Promise.reject(error)
  }
  return runOffMain(client, 'parseDocument', () => {
    const bytes = transferableCopy(buffer)
    return { args: [name, bytes], transfer: [bytes] }
  }, signal, () => parseDocument(name, buffer, signal))
}

export function extractPdfTextPagesOffMain(
  buffer: Buffer,
  options: PdfTextExtractionOptions = {},
  client: DocumentParseWorkerClient | undefined = sharedClient
): Promise<PdfTextExtraction> {
  const { signal, ...limits } = options
  return runOffMain(client, 'extractPdfTextPages', () => {
    const bytes = transferableCopy(buffer)
    return { args: [bytes, limits], transfer: [bytes] }
  }, signal, () => extractPdfTextPages(buffer, options))
}

export function extractPptxPagesOffMain(
  buffer: Buffer,
  client: DocumentParseWorkerClient | undefined = sharedClient
): Promise<PptxPage[]> {
  return runOffMain(client, 'extractPptxPages', () => {
    const bytes = transferableCopy(buffer)
    return { args: [bytes], transfer: [bytes] }
  }, undefined, () => extractPptxPages(buffer))
}

/**
 * Not cancellable on purpose: the inline call it replaces was synchronous, so
 * an abort during chunking keeps surfacing at the caller's next checkpoint.
 */
export function chunkDocumentOffMain(
  document: ParsedDocument,
  settings: KnowledgeChunkingSettings,
  client: DocumentParseWorkerClient | undefined = sharedClient
): Promise<DocumentChunk[]> {
  return runOffMain(client, 'chunkDocument', () => ({
    // Only the fields chunking reads; images (Buffers) would otherwise be cloned.
    args: [{ title: document.title, sourceFormat: document.sourceFormat, content: '', sections: document.sections, warnings: [] }, settings]
  }), undefined, () => chunkDocumentAdvanced(document, settings))
}

/** Hex SHA-256 of `buffer`, computed in the worker for large inputs. */
export function sha256OffMain(
  buffer: Uint8Array,
  client: DocumentParseWorkerClient | undefined = sharedClient
): Promise<string> {
  const inline = (): string => createHash('sha256').update(buffer).digest('hex')
  // Small inputs hash faster than a round trip.
  if (buffer.byteLength < 1024 * 1024) return Promise.resolve().then(inline)
  return runOffMain(client, 'sha256', () => {
    const bytes = transferableCopy(buffer)
    return { args: [bytes], transfer: [bytes] }
  }, undefined, inline)
}
