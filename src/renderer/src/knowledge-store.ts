export type KnowledgeDocument = {
  id: string
  name: string
  size: number
  createdAt: string
  content: string
}

export type KnowledgeSearchResult = {
  documentId: string
  documentName: string
  score: number
  snippet: string
}

export const MAX_KNOWLEDGE_FILE_SIZE = 512 * 1024
export const MAX_KNOWLEDGE_TOTAL_SIZE = 10 * 1024 * 1024

export const SUPPORTED_KNOWLEDGE_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'xml',
  'yaml',
  'yml',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'java',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hpp',
  'cs',
  'go',
  'rs',
  'php',
  'rb',
  'swift',
  'kt',
  'kts',
  'scala',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'sql',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'dart',
  'lua',
  'r',
  'ex',
  'exs',
  'erl',
  'fs',
  'fsx',
  'vb',
  'groovy',
  'gradle',
  'toml',
  'ini',
  'conf',
  'cfg'
] as const

const DATABASE_NAME = 'goodbuddy-local-knowledge'
const DATABASE_VERSION = 1
const DOCUMENT_STORE = 'documents'
const MAX_SEARCH_RESULTS = 3
const MAX_SNIPPET_LENGTH = 2000
const MAX_QUERY_LENGTH = 500
const MAX_QUERY_TOKENS = 64
const supportedExtensions = new Set<string>(
  SUPPORTED_KNOWLEDGE_EXTENSIONS
)

function operationError(prefix: string, reason: unknown): Error {
  if (
    reason instanceof Error &&
    (reason.message.startsWith('当前浏览器') ||
      reason.message.startsWith('不支持的文件') ||
      reason.message.startsWith('文件“') ||
      reason.message.startsWith('知识库'))
  ) {
    return reason
  }

  const detail =
    reason instanceof Error && reason.message
      ? `：${reason.message}`
      : ''
  return new Error(`${prefix}${detail}`)
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error(
        '当前浏览器不支持 IndexedDB，无法使用本地知识库。'
      )
    )
  }

  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    } catch (reason) {
      reject(operationError('知识库数据库无法打开', reason))
      return
    }

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
        database.createObjectStore(DOCUMENT_STORE, {
          keyPath: 'id'
        })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(
        operationError(
          '知识库数据库无法打开',
          request.error
        )
      )
    request.onblocked = () =>
      reject(
        new Error(
          '知识库数据库升级被其他窗口阻止，请关闭其他窗口后重试。'
        )
      )
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('数据库请求失败'))
  })
}

function transactionComplete(
  transaction: IDBTransaction
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('数据库事务失败'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('数据库事务已取消'))
  })
}

async function withDocumentStore<T>(
  mode: IDBTransactionMode,
  errorMessage: string,
  action: (
    store: IDBObjectStore,
    transaction: IDBTransaction
  ) => Promise<T>
): Promise<T> {
  const database = await openDatabase()
  const transaction = database.transaction(DOCUMENT_STORE, mode)
  const completion = transactionComplete(transaction)

  try {
    const result = await action(
      transaction.objectStore(DOCUMENT_STORE),
      transaction
    )
    await completion
    return result
  } catch (reason) {
    try {
      transaction.abort()
    } catch {
      // The transaction may already be complete or aborted.
    }
    try {
      await completion
    } catch {
      // The original error is more useful to the caller.
    }
    throw operationError(errorMessage, reason)
  } finally {
    database.close()
  }
}

function fileExtension(name: string): string {
  const separator = name.lastIndexOf('.')
  return separator > -1 ? name.slice(separator + 1).toLowerCase() : ''
}

function validateFile(file: File): void {
  if (!supportedExtensions.has(fileExtension(file.name))) {
    throw new Error(
      `不支持的文件类型：“${file.name}”。请选择文本、Markdown、数据文件或常见代码文件。`
    )
  }
  if (file.size > MAX_KNOWLEDGE_FILE_SIZE) {
    throw new Error(
      `文件“${file.name}”超过 512KB 的单文件限制。`
    )
  }
}

function createDocumentId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function listKnowledgeDocuments(): Promise<
  KnowledgeDocument[]
> {
  return withDocumentStore(
    'readonly',
    '知识库文档读取失败',
    async (store) => {
      const documents = await requestResult<KnowledgeDocument[]>(
        store.getAll()
      )
      return documents.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      )
    }
  )
}

export async function importKnowledgeFiles(
  files: File[]
): Promise<KnowledgeDocument[]> {
  if (files.length === 0) {
    return []
  }

  for (const file of files) {
    validateFile(file)
  }

  const contents = await Promise.all(
    files.map(async (file) => {
      try {
        return await file.text()
      } catch (reason) {
        throw operationError(
          `文件“${file.name}”读取失败`,
          reason
        )
      }
    })
  )
  const createdAt = new Date().toISOString()
  const documents = files.map<KnowledgeDocument>((file, index) => ({
    id: createDocumentId(),
    name: file.name,
    size: file.size,
    createdAt,
    content: contents[index] ?? ''
  }))

  return withDocumentStore(
    'readwrite',
    '知识库文档导入失败',
    async (store) => {
      const existing = await requestResult<KnowledgeDocument[]>(
        store.getAll()
      )
      const currentSize = existing.reduce(
        (total, document) => total + document.size,
        0
      )
      const importedSize = documents.reduce(
        (total, document) => total + document.size,
        0
      )

      if (
        currentSize + importedSize >
        MAX_KNOWLEDGE_TOTAL_SIZE
      ) {
        throw new Error(
          '知识库总容量将超过 10MB，请删除部分文档后重试。'
        )
      }

      await Promise.all(
        documents.map((document) =>
          requestResult(store.add(document))
        )
      )
      return documents
    }
  )
}

export async function removeKnowledgeDocument(
  id: string
): Promise<void> {
  await withDocumentStore(
    'readwrite',
    '知识库文档删除失败',
    async (store) => {
      await requestResult(store.delete(id))
    }
  )
}

export async function clearKnowledgeDocuments(): Promise<void> {
  await withDocumentStore(
    'readwrite',
    '知识库清空失败',
    async (store) => {
      await requestResult(store.clear())
    }
  )
}

function normalizeSearchText(value: string): string {
  return [...value.normalize('NFKC').toLocaleLowerCase()]
    .map((character) => (character.charCodeAt(0) === 0 ? ' ' : character))
    .join('')
}

function tokenize(query: string): string[] {
  const normalized = normalizeSearchText(query).slice(
    0,
    MAX_QUERY_LENGTH
  )
  const tokens = new Set<string>()
  const segments = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []

  for (const rawSegment of segments) {
    const segment = rawSegment.slice(0, 64)
    if (segment.length > 0) {
      tokens.add(segment)
    }

    const hanCharacters = segment.match(/\p{Script=Han}/gu)
    if (hanCharacters && hanCharacters.length > 1) {
      for (let index = 0; index < hanCharacters.length - 1; index += 1) {
        tokens.add(
          `${hanCharacters[index] ?? ''}${hanCharacters[index + 1] ?? ''}`
        )
        if (tokens.size >= MAX_QUERY_TOKENS) {
          break
        }
      }
    }

    if (tokens.size >= MAX_QUERY_TOKENS) {
      break
    }
  }

  return [...tokens].slice(0, MAX_QUERY_TOKENS)
}

function countOccurrences(
  content: string,
  token: string,
  maximum: number
): { count: number; firstIndex: number } {
  let count = 0
  let firstIndex = -1
  let fromIndex = 0

  while (count < maximum) {
    const index = content.indexOf(token, fromIndex)
    if (index === -1) {
      break
    }
    if (firstIndex === -1) {
      firstIndex = index
    }
    count += 1
    fromIndex = index + Math.max(token.length, 1)
  }

  return { count, firstIndex }
}

function createSnippet(content: string, hitIndex: number): string {
  if (content.length <= MAX_SNIPPET_LENGTH) {
    return content
  }

  const contentLength = MAX_SNIPPET_LENGTH - 2
  const start = Math.max(
    0,
    Math.min(
      hitIndex - Math.floor(contentLength / 3),
      content.length - contentLength
    )
  )
  const end = Math.min(content.length, start + contentLength)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${
    end < content.length ? '…' : ''
  }`
}

export function searchKnowledgeDocumentsInMemory(
  query: string,
  documents: readonly KnowledgeDocument[],
  limit = MAX_SEARCH_RESULTS
): KnowledgeSearchResult[] {
  const normalizedQuery = normalizeSearchText(query)
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
  const tokens = tokenize(normalizedQuery)
  if (!normalizedQuery || tokens.length === 0) {
    return []
  }

  const results: KnowledgeSearchResult[] = []
  for (const document of documents) {
    const normalizedContent = normalizeSearchText(document.content)
    const normalizedName = normalizeSearchText(document.name)
    let score = 0
    let strongestHit = -1
    let strongestWeight = -1

    const phraseMatch = countOccurrences(
      normalizedContent,
      normalizedQuery,
      10
    )
    if (phraseMatch.count > 0) {
      score += 20 + phraseMatch.count * 5
      strongestHit = phraseMatch.firstIndex
      strongestWeight = 20
    }
    if (normalizedName.includes(normalizedQuery)) {
      score += 16
    }

    for (const token of tokens) {
      const contentMatch = countOccurrences(
        normalizedContent,
        token,
        20
      )
      if (contentMatch.count > 0) {
        const weight = Math.min(token.length, 12)
        score += weight + contentMatch.count
        if (weight > strongestWeight) {
          strongestHit = contentMatch.firstIndex
          strongestWeight = weight
        }
      }
      if (normalizedName.includes(token)) {
        score += Math.min(token.length, 12) + 4
      }
    }

    if (score > 0) {
      results.push({
        documentId: document.id,
        documentName: document.name,
        score,
        snippet: createSnippet(
          document.content,
          Math.max(strongestHit, 0)
        )
      })
    }
  }

  const safeLimit = Math.min(
    MAX_SEARCH_RESULTS,
    Math.max(0, Math.floor(limit))
  )
  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.documentName.localeCompare(right.documentName)
    )
    .slice(0, safeLimit)
}

export async function searchKnowledgeDocuments(
  query: string
): Promise<KnowledgeSearchResult[]> {
  const documents = await listKnowledgeDocuments()
  return searchKnowledgeDocumentsInMemory(query, documents)
}
