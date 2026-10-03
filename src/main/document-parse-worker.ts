import { createHash } from 'node:crypto'
import { parentPort } from 'node:worker_threads'
import type { KnowledgeChunkingSettings } from '../shared/knowledge-contracts'
import {
  chunkDocumentAdvanced,
  extractPdfTextPages,
  parseDocument,
  type ParsedDocument
} from './knowledge/document-parser'
import { extractPptxPages } from './knowledge/pptx-parser'
import {
  documentParseErrorExtraKeys,
  type DocumentParseRequest,
  type DocumentParseResponse,
  type SerializedDocumentParseError
} from './document-parse-errors'

// PERF-15/16: CPU-heavy, pure document work (PDF / Office / text parsing,
// chunking, hashing) runs here so Main only orchestrates. Every handler calls
// the same production function as the inline path, so results are identical.
// No database access and no file system access happen in this worker.

type Handler = (args: unknown[]) => Promise<unknown> | unknown

const asBuffer = (value: unknown): Buffer => {
  const bytes = value as ArrayBuffer
  return Buffer.from(bytes, 0, bytes.byteLength)
}

const handlers: Record<string, Handler> = {
  parseDocument: ([name, bytes]) => parseDocument(name as string, asBuffer(bytes)),
  extractPdfTextPages: ([bytes, options]) => extractPdfTextPages(
    asBuffer(bytes),
    options as { maximumPages?: number; maximumCharacters?: number }
  ),
  extractPptxPages: ([bytes]) => extractPptxPages(asBuffer(bytes)),
  chunkDocument: ([document, settings]) => chunkDocumentAdvanced(
    document as ParsedDocument,
    settings as KnowledgeChunkingSettings
  ),
  sha256: ([bytes]) => createHash('sha256').update(asBuffer(bytes)).digest('hex')
}

/** ArrayBuffers backing typed arrays in the result (PPTX images); transferred, not copied. */
function transferables(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  if (Array.isArray(value)) {
    for (const page of value as Array<{ images?: Array<{ data?: unknown }> }>) {
      for (const image of page?.images ?? []) {
        const data = image?.data
        if (
          data instanceof Uint8Array &&
          data.buffer instanceof ArrayBuffer &&
          data.byteOffset === 0 &&
          data.byteLength === data.buffer.byteLength
        ) {
          buffers.add(data.buffer)
        }
      }
    }
  }
  return [...buffers]
}

function serializeError(error: unknown, depth = 0): SerializedDocumentParseError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const extra: Record<string, unknown> = {}
  for (const key of documentParseErrorExtraKeys) {
    const value = (error as unknown as Record<string, unknown>)[key]
    if (value !== undefined && (typeof value !== 'object' || value === null)) extra[key] = value
  }
  return {
    name: error.name,
    message: error.message,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
    ...(error.cause !== undefined && depth < 3 ? { cause: serializeError(error.cause, depth + 1) } : {})
  }
}

// PDF.js can leave a stray rejection ("Controller is already closed") after a
// text stream is cancelled at the character limit. Unhandled, it would kill
// this thread and push the next tasks onto the inline fallback. Task errors are
// awaited by the handler and still reported through the response.
process.on('unhandledRejection', () => undefined)

parentPort!.on('message', (message: DocumentParseRequest) => {
  void (async () => {
    let response: DocumentParseResponse
    let transfer: ArrayBuffer[] = []
    try {
      const handler = Object.hasOwn(handlers, message.op) ? handlers[message.op] : undefined
      if (!handler) throw new Error(`Unknown document parse operation: ${message.op}`)
      const result = await handler(message.args)
      transfer = message.op === 'extractPptxPages' ? transferables(result) : []
      response = { id: message.id, result }
    } catch (error) {
      response = { id: message.id, error: serializeError(error) }
    }
    parentPort!.postMessage(response, transfer)
  })()
})
