import { useCallback, useSyncExternalStore } from 'react'

export type ExternalReferenceProvider = 'feishu' | 'wecom'

/** One document picked with `@`, referenced by the platform's own ID. */
export type ExternalDocumentReference = {
  provider: ExternalReferenceProvider
  /** Feishu: wiki node token or drive file token. WeCom: docid. */
  id: string
  title: string
  /** Feishu only: wiki page or drive file. */
  kind?: 'node' | 'file'
  /** Platform document type, e.g. docx, sheet, smartsheet. */
  type?: string
  url?: string
}

/** Whether `@` can search a platform, and why not. */
export type ExternalReferenceSource =
  | { state: 'ready' }
  | { state: 'unavailable'; reason: string }

export type ExternalReferenceSources = Partial<Record<ExternalReferenceProvider, ExternalReferenceSource>>

export const MAX_EXTERNAL_REFERENCES = 5

export const referenceKey = (reference: Pick<ExternalDocumentReference, 'provider' | 'id'>): string =>
  `${reference.provider}:${reference.id}`

/** Per-conversation references, outside App state like composer drafts. */
export type ExternalReferenceStore = ReturnType<typeof createExternalReferenceStore>

const empty: readonly ExternalDocumentReference[] = []

export function createExternalReferenceStore() {
  const references = new Map<string, readonly ExternalDocumentReference[]>()
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const store = {
    get(conversationId: string): readonly ExternalDocumentReference[] {
      return references.get(conversationId) ?? empty
    },
    /** Returns false when the reference is a duplicate or the limit is reached. */
    add(conversationId: string, reference: ExternalDocumentReference): boolean {
      const current = store.get(conversationId)
      if (current.length >= MAX_EXTERNAL_REFERENCES) return false
      if (current.some((item) => referenceKey(item) === referenceKey(reference))) return false
      references.set(conversationId, [...current, reference])
      notify()
      return true
    },
    remove(conversationId: string, key: string): void {
      const current = store.get(conversationId)
      const next = current.filter((item) => referenceKey(item) !== key)
      if (next.length === current.length) return
      if (next.length > 0) references.set(conversationId, next)
      else references.delete(conversationId)
      notify()
    },
    clear(conversationId: string): void {
      if (references.delete(conversationId)) notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
  return store
}

export function useExternalReferences(
  store: ExternalReferenceStore,
  conversationId: string
): readonly ExternalDocumentReference[] {
  const getSnapshot = useCallback(() => store.get(conversationId), [conversationId, store])
  return useSyncExternalStore(store.subscribe, getSnapshot)
}

/**
 * The `@query` being typed right before the caret, if any. `@` must start the
 * text or follow whitespace, so e-mail addresses do not open the menu.
 */
export function activeMention(text: string, caret: number): { start: number; query: string } | undefined {
  const match = /(^|\s)@([^\s@]{0,40})$/u.exec(text.slice(0, caret))
  if (!match) return undefined
  return { start: caret - match[2]!.length - 1, query: match[2]! }
}

const clean = (value: string, limit: number): string =>
  value.replace(/[\r\n「」]+/gu, ' ').trim().slice(0, limit)

function readingHint(reference: ExternalDocumentReference): string {
  if (reference.provider === 'wecom') {
    return `docid: ${reference.id}。先用 wecom_guide 查看该类型（${clean(reference.type ?? 'doc', 40)}）对应类别的说明，再以 docid 读取。`
  }
  if (reference.kind === 'node') {
    return `知识库节点 token: ${reference.id}。先用 feishu_wiki get 取得 obj_token，再按 obj_type 读取（docx 用 feishu_doc read）。`
  }
  return reference.type === 'docx' || reference.type === undefined
    ? `doc_token: ${reference.id}。用 feishu_doc read 读取。`
    : `file_token: ${reference.id}（类型 ${clean(reference.type, 40)}）。用 feishu_drive info 查看。`
}

/**
 * The prompt sent for typed text plus `@` references. With references but no
 * text, `fallback` asks the model to read them.
 */
export function promptWithReferences(
  text: string,
  references: readonly ExternalDocumentReference[],
  fallback: string
): string {
  const referenceText = formatExternalReferences(references)
  if (!referenceText) return text
  return `${text || fallback}\n\n${referenceText}`
}

/** Explicit instructions appended to the prompt so the model reads exactly these documents. */
export function formatExternalReferences(references: readonly ExternalDocumentReference[]): string {
  if (references.length === 0) return ''
  const lines = references.map((reference, index) => {
    const platform = reference.provider === 'feishu' ? '飞书' : '企业微信'
    const link = reference.url ? ` 链接：${reference.url}` : ''
    return `${index + 1}. ${platform}「${clean(reference.title, 120)}」${link}\n   ${readingHint(reference)}`
  })
  return [
    '引用的外部文档（用户用 @ 选择；请用对应工具读取后再回答，读取失败时说明原因，不要猜测内容）：',
    ...lines
  ].join('\n')
}
