import type { ConversationToolActivity } from '../../shared/assistant-contracts'

/** What a finished Feishu or WeCom tool call did, for the card under the tool row. */
export type PlatformToolCard = {
  provider: 'feishu' | 'wecom'
  /** i18n key suffix under chat.platformTools.objects, e.g. doc, wiki, todo. */
  object: string
  write: boolean
  /** The action as the platform names it, e.g. append, create. */
  action?: string
  title?: string
  url?: string
  /** Number of items a list or batch call returned or changed. */
  count?: number
}

const FEISHU_WRITES: Record<string, readonly string[]> = {
  doc: ['create', 'write', 'append', 'update_block', 'delete_block'],
  wiki: ['create', 'move', 'rename'],
  drive: ['create_folder', 'move', 'delete', 'add_comment'],
  bitable: ['create_app', 'create_record', 'update_record'],
  perm: ['add', 'remove']
}
/** Verbs in wecom-cli command paths that change data. */
const WECOM_WRITE_VERBS = new Set(['create', 'add', 'update', 'delete', 'remove', 'upload', 'import', 'send', 'rename',
  'set', 'append', 'overwrite', 'move', 'edit', 'cancel', 'reply', 'forward', 'complete', 'insert'])
const WECOM_OBJECTS = new Set(['doc', 'sheet', 'smartsheet', 'smartpage', 'slide', 'disk', 'media', 'calendar',
  'meeting', 'todo', 'contact', 'mail', 'message', 'chat'])

function parse(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

const PLATFORM_URL = /https:\/\/(?:[\w-]+\.)*(?:feishu\.cn|larksuite\.com|weixin\.qq\.com)\/[^\s"'<>)\]]+/u

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const nested of ['document', 'node', 'file', 'data', 'record']) {
    const inner = record[nested]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const found = firstString(inner as Record<string, unknown>, keys)
      if (found) return found
    }
  }
  return undefined
}

function countOf(record: Record<string, unknown> | undefined): number | undefined {
  if (!record) return undefined
  for (const key of ['items', 'docs', 'files', 'records', 'blocks', 'nodes', 'list']) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).length
  }
  return undefined
}

/** The card for a completed Feishu or WeCom tool call, or undefined for other tools and guides. */
export function platformToolCard(tool: Pick<ConversationToolActivity, 'name' | 'state' | 'input' | 'output'>): PlatformToolCard | undefined {
  if (tool.state !== 'completed') return undefined
  const match = /(?:^|[_.:/-])(feishu_(doc|wiki|drive|bitable|perm)|wecom_(cli|script))$/u.exec(tool.name.trim())
  if (!match) return undefined
  const input = parse(tool.input)
  const output = parse(tool.output)
  const url = firstString(output, ['url', 'doc_url', 'link']) ?? PLATFORM_URL.exec(tool.output ?? '')?.[0]
  const title = firstString(output, ['title', 'doc_name', 'file_name', 'name']) ?? firstString(input, ['title', 'doc_name', 'file_name', 'name'])
  const count = countOf(output)
  if (match[2]) {
    const object = match[2]
    const action = typeof input?.action === 'string' ? input.action : undefined
    return {
      provider: 'feishu',
      object,
      write: Boolean(action && FEISHU_WRITES[object]?.includes(action)),
      ...(action ? { action } : {}),
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(count !== undefined ? { count } : {})
    }
  }
  if (match[3] === 'script') {
    return { provider: 'wecom', object: 'file', write: true, action: 'generate', ...(title ? { title } : {}), ...(url ? { url } : {}) }
  }
  const args = Array.isArray(input?.args) ? input.args.filter((value): value is string => typeof value === 'string') : []
  const words = args.filter((value) => !value.startsWith('-') && !value.startsWith('{') && !value.startsWith('['))
  const object = words[0] && WECOM_OBJECTS.has(words[0]) ? words[0] : 'other'
  const verb = words.slice(1, 4).find((word) => WECOM_WRITE_VERBS.has(word))
  return {
    provider: 'wecom',
    object,
    write: Boolean(verb),
    ...(verb ?? words[1] ? { action: verb ?? words[1] } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(count !== undefined ? { count } : {})
  }
}
