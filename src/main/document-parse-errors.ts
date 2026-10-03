// Wire format shared by document-parse-client (Main) and document-parse-worker.

export type DocumentParseOperation =
  | 'parseDocument'
  | 'extractPdfTextPages'
  | 'extractPptxPages'
  | 'chunkDocument'
  | 'sha256'

export type DocumentParseRequest = {
  id: number
  op: DocumentParseOperation
  args: unknown[]
}

export type SerializedDocumentParseError = {
  name: string
  message: string
  /** Primitive own properties some error types carry (PDF.js, Node). */
  extra?: Record<string, unknown>
  cause?: SerializedDocumentParseError
}

export type DocumentParseResponse =
  | { id: number; result: unknown }
  | { id: number; error: SerializedDocumentParseError }

export const documentParseErrorExtraKeys = ['code', 'status', 'missing', 'details', 'extraDelay'] as const
