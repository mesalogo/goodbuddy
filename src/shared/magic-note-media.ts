import type { MagicNoteContent, MagicNoteDetail } from './magic-notes-contracts'

// Copy containers only: immutable Base64 strings need no serialization round trip.
export function copyNoteValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyNoteValue) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyNoteValue(item)])) as T
  return value
}

export function mapNoteMedia(content: MagicNoteContent, transform: (value: unknown, owner?: Record<string, unknown>) => unknown): void {
  const field = (record: Record<string, unknown>, key: string): void => {
    if (record[key] === undefined) return
    const next = transform(record[key], record)
    if (next !== record[key]) record[key] = next
  }
  const embeds = (ops: Array<{ insert: unknown }>): void => {
    for (const op of ops) {
      if (!op.insert || typeof op.insert !== 'object') continue
      const insert = op.insert as Record<string, unknown>
      field(insert, 'image')
      for (const key of ['localVideo', 'attachment']) {
        const file = insert[key]
        if (file && typeof file === 'object') field(file as Record<string, unknown>, 'dataUrl')
      }
    }
  }
  if (content.version === 1) { embeds(content.ops); return }
  for (const asset of content.assets) field(asset, 'dataUrl')
  field(content, 'preview')
  if (content.flow) embeds(content.flow.ops)
  const objects = (items: Record<string, unknown>[]): void => {
    for (const item of items) {
      if (item.type === 'Image' || item.type === 'image' || item.canvasKind === 'image') field(item, 'src')
      if (item.canvasKind === 'attachment') field(item, 'dataUrl')
      if (Array.isArray(item.objects)) objects(item.objects as Record<string, unknown>[])
    }
  }
  for (const page of content.pages) objects(page.objects)
}

export type ReusedNoteMedia = { slot: number; previousSlot: number }[]

export function noteHasMedia(note: MagicNoteDetail): boolean {
  let found = false
  for (const entry of note.entries) mapNoteMedia(entry.content, value => { found = true; return value })
  return found
}

export function compactNoteMedia(content: MagicNoteContent, previous: MagicNoteContent): { content: MagicNoteContent; reusedMedia?: ReusedNoteMedia } {
  const previousSlots = new Map<string, number>()
  let index = 0
  mapNoteMedia(previous, value => {
    if (typeof value === 'string') previousSlots.set(value, index)
    index++
    return value
  })
  const copy = copyNoteValue(content)
  const reusedMedia: ReusedNoteMedia = []
  index = 0
  mapNoteMedia(copy, value => {
    const slot = index++
    const previousSlot = typeof value === 'string' ? previousSlots.get(value) : undefined
    if (previousSlot === undefined || typeof value !== 'string') return value
    reusedMedia.push({ slot, previousSlot })
    // A valid transport placeholder; the owner restores it before content validation.
    return value.slice(0, value.indexOf(',') + 1) + 'AA=='
  })
  return reusedMedia.length ? { content: copy, reusedMedia } : { content }
}

export function restoreNoteMedia(content: MagicNoteContent, previous: MagicNoteContent, reused: ReusedNoteMedia): MagicNoteContent {
  const values: unknown[] = []
  mapNoteMedia(previous, value => { values.push(value); return value })
  const replacements = new Map(reused.map(item => [item.slot, item.previousSlot]))
  if (replacements.size !== reused.length) throw new Error('重复的附件引用')
  const copy = copyNoteValue(content)
  let index = 0
  mapNoteMedia(copy, value => {
    const slot = index++
    const previousSlot = replacements.get(slot)
    if (previousSlot === undefined) return value
    if (typeof values[previousSlot] !== 'string') throw new Error('原附件不存在')
    replacements.delete(slot)
    return values[previousSlot]
  })
  if (replacements.size) throw new Error('附件引用位置不存在')
  return copy
}

export function mergeNoteSaveResult<T extends MagicNoteDetail>(result: T, previous: MagicNoteDetail): T {
  if (!result.entryOrder) return result
  const entries = new Map(previous.entries.map(entry => [entry.id, entry]))
  for (const entry of result.entries) entries.set(entry.id, entry)
  return { ...result, entries: result.entryOrder.map(id => {
    const entry = entries.get(id)
    if (!entry) throw new Error('保存结果缺少记录')
    return entry
  }) }
}
