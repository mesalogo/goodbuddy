import { useCallback, useSyncExternalStore } from 'react'

export type ExternalReferenceProvider = 'feishu' | 'wecom' | 'local'

/** One document picked with `@`, referenced by its owning store's ID. */
export type ExternalDocumentReference = {
  provider: ExternalReferenceProvider
  /** Local: document ID. Feishu: node/file token. WeCom: docid. */
  id: string
  title: string
  /** Feishu only: wiki page or drive file. */
  kind?: 'node' | 'file'
  /** Platform document type, e.g. docx, sheet, smartsheet. */
  type?: string
  url?: string
  libraryId?: string
  libraryName?: string
  path?: string
  status?: string
}

/** Whether `@` can search a platform, and why not. */
export type ExternalReferenceSource =
  | { state: 'ready' }
  | { state: 'unavailable'; reason: string }

export type ExternalReferenceSources = Partial<Record<ExternalReferenceProvider, ExternalReferenceSource>>

export const MAX_EXTERNAL_REFERENCES = 5

export const referenceKey = (reference: Pick<ExternalDocumentReference, 'provider' | 'id'>): string =>
  `${reference.provider}:${reference.id}`

/** Draft-only markers; converted to readable labels before sending or copying. */
export const referenceToken = (reference: ExternalDocumentReference): string => `\uFFF9${encodeURIComponent(referenceKey(reference))}\uFFFB`

export function referencesInDraft(text: string, references: readonly ExternalDocumentReference[]): ExternalDocumentReference[] {
  return references.filter(reference => text.includes(referenceToken(reference)))
    .sort((a, b) => text.indexOf(referenceToken(a)) - text.indexOf(referenceToken(b)))
}

export function referenceDraftParts(text: string, references: readonly ExternalDocumentReference[]): (string | ExternalDocumentReference)[] {
  const byToken = new Map(references.map(reference => [referenceToken(reference), reference]))
  return text.split(/(\uFFF9[^\uFFF9\uFFFB]*\uFFFB)/u).filter(Boolean).map(part => byToken.get(part) ?? part)
}

export function referenceDraftText(text: string, references: readonly ExternalDocumentReference[]): string {
  return referenceDraftParts(text, references).map(part => typeof part === 'string' ? part : `@${part.title}`).join('')
}

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
    /** Retain removed metadata for undo; activeKeys applies duplicate/limit checks to the current draft. */
    add(conversationId: string, reference: ExternalDocumentReference, activeKeys?: readonly string[]): boolean {
      const current = store.get(conversationId)
      const key = referenceKey(reference)
      if ((activeKeys?.length ?? current.length) >= MAX_EXTERNAL_REFERENCES) return false
      if (activeKeys?.includes(key)) return false
      if (current.some((item) => referenceKey(item) === key)) {
        if (activeKeys === undefined) return false
        references.set(conversationId, current.map(item => referenceKey(item) === key ? reference : item))
        notify()
        return true
      }
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

const referenceHeading = '引用的文档（用户用 @ 选择；请用对应工具读取后再回答，读取失败时说明原因，不要猜测内容）：'

/** Interpret only a complete generated footer; ordinary user text stays intact. */
export function referencedMessagePresentation(content: string): { body: string; references: ExternalDocumentReference[] } {
  const unchanged = { body: content, references: [] as ExternalDocumentReference[] }
  const start = content.lastIndexOf(`\n\n${referenceHeading}\n`)
  if (start < 0) return unchanged
  const footer = content.slice(start + 2)
  const lines = footer.split('\n').slice(1)
  if (!lines.length || lines.length % 2 || lines.length > MAX_EXTERNAL_REFERENCES * 2) return unchanged
  const references: ExternalDocumentReference[] = []
  for (let index = 0; index < lines.length; index += 2) {
    const heading = /^(\d+)\. (本地知识库|飞书|企业微信)「([^「」]*)」(.*)$/u.exec(lines[index]!)
    const hint = lines[index + 1]!
    if (!heading || Number(heading[1]) !== references.length + 1 || !hint.startsWith('   ')) return unchanged
    const provider = heading[2] === '本地知识库' ? 'local' : heading[2] === '飞书' ? 'feishu' : 'wecom'
    const id = /^(?:documentId|docid|知识库节点 token|doc_token|file_token): (.*?)(?:。|（类型 )/u.exec(hint.slice(3))?.[1]
    if (!id) return unchanged
    const reference: ExternalDocumentReference = { provider, id, title: heading[3]! }
    let location = heading[4]!
    if (provider === 'local') {
      const local = / 知识库：(.*?)；路径：(.*)$/u.exec(location)
      if (!local) return unchanged
      reference.libraryName = local[1]
      reference.path = local[2]
      location = location.slice(0, local.index)
    }
    if (location) {
      if (!location.startsWith(' 链接：')) return unchanged
      reference.url = location.slice(4)
    }
    if (provider === 'wecom') reference.type = /该类型（(.*?)）/u.exec(hint)?.[1]
    if (provider === 'feishu') {
      reference.kind = hint.startsWith('   知识库节点 token:') ? 'node' : 'file'
      reference.type = /（类型 (.*?)）/u.exec(hint)?.[1]
    }
    references.push(reference)
  }
  // Exact round-trip also rejects extra prose, incomplete hints, and unrelated quotations.
  if (formatExternalReferences(references) !== footer) return unchanged
  return { body: content.slice(0, start), references }
}

function readingHint(reference: ExternalDocumentReference): string {
  if (reference.provider === 'local') {
    return `documentId: ${reference.id}。用 knowledge_read 读取这篇文档，按返回的 next（ordinal、offset）继续分页，直到 next 为 null；不可用或未解析时说明原因。`
  }
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
  const selected = referencesInDraft(text, references)
  const referenceText = formatExternalReferences(selected)
  if (!referenceText) return text
  const parts = referenceDraftParts(text, selected)
  const body = parts.map(part => typeof part === 'string' ? part
    : `@${part.title} [${selected.indexOf(part) + 1}]`).join('')
  const introduction = parts.some(part => typeof part === 'string' && part.trim()) ? '' : fallback
  return `${introduction ? `${introduction}\n` : ''}${body}\n\n${referenceText}`
}

/** Explicit instructions appended to the prompt so the model reads exactly these documents. */
export function formatExternalReferences(references: readonly ExternalDocumentReference[]): string {
  if (references.length === 0) return ''
  const lines = references.map((reference, index) => {
    const platform = reference.provider === 'local' ? '本地知识库' : reference.provider === 'feishu' ? '飞书' : '企业微信'
    const link = reference.url ? ` 链接：${reference.url}` : ''
    const location = reference.provider === 'local'
      ? ` 知识库：${clean(reference.libraryName ?? '', 120)}；路径：${clean(reference.path ?? '', 1024)}` : ''
    return `${index + 1}. ${platform}「${clean(reference.title, 120)}」${link}${location}\n   ${readingHint(reference)}`
  })
  return [
    referenceHeading,
    ...lines
  ].join('\n')
}
