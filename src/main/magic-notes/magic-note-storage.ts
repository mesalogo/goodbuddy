import { createHash, randomUUID } from 'node:crypto'
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MagicNoteContent } from '../../shared/magic-notes-contracts'

export type MagicNoteStoredEntry = {
  id: string
  noteId: string
  revision: number
  updatedAt: string
  content: MagicNoteContent
}

const extensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'video/mp4': 'mp4',
  'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov'
}

// Only media slots may contain storage references. Text and arbitrary canvas
// properties (including objects named "$asset") are ordinary user content.
function mapMediaFields(content: MagicNoteContent, transform: (value: unknown) => unknown): void {
  const field = (record: Record<string, unknown>, key: string): void => {
    if (record[key] !== undefined) record[key] = transform(record[key])
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
  if (content.version === 1) {
    embeds(content.ops)
    return
  }
  for (const asset of content.assets) field(asset, 'dataUrl')
  field(content, 'preview')
  if (content.flow) embeds(content.flow.ops)
  const objects = (items: Record<string, unknown>[]): void => {
    for (const item of items) {
      if (item.type === 'Image' || item.type === 'image' || item.canvasKind === 'image') field(item, 'src')
      if (Array.isArray(item.objects)) objects(item.objects as Record<string, unknown>[])
    }
  }
  for (const page of content.pages) objects(page.objects)
}

export class MagicNoteStorage {
  readonly rootPath: string

  constructor(databasePath: string) {
    this.rootPath = databasePath === ':memory:'
      ? join(tmpdir(), `goodbuddy-memory-notes-${randomUUID()}`)
      : join(dirname(databasePath), 'notes')
  }

  private atomicWrite(path: string, value: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, value)
      fs.renameSync(temporary, path)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  private entryPath(noteId: string, entryId: string): string {
    return join(this.rootPath, noteId, 'entries', `${entryId}.json`)
  }

  revision(noteId: string, entryId: string): number {
    return (JSON.parse(readFileSync(this.entryPath(noteId, entryId), 'utf8')) as MagicNoteStoredEntry).revision
  }

  write(entry: MagicNoteStoredEntry): void {
    const notePath = join(this.rootPath, entry.noteId)
    const stored = JSON.parse(JSON.stringify(entry)) as MagicNoteStoredEntry
    mapMediaFields(stored.content, (value) => {
      if (typeof value !== 'string') return value
      const match = /^data:([^;]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
      if (!match) return value
      const mimeType = match[1]!
      const bytes = Buffer.from(match[2]!, 'base64')
      const name = `${createHash('sha256').update(bytes).digest('hex')}.${extensions[mimeType] ?? 'bin'}`
      const path = join(notePath, 'assets', name)
      if (!existsSync(path)) this.atomicWrite(path, bytes)
      return { $asset: `assets/${name}`, mimeType }
    })
    this.atomicWrite(this.entryPath(entry.noteId, entry.id), JSON.stringify(stored))
  }

  read(noteId: string, entryId: string): MagicNoteStoredEntry {
    const entry = JSON.parse(readFileSync(this.entryPath(noteId, entryId), 'utf8')) as MagicNoteStoredEntry
    mapMediaFields(entry.content, (value) => {
      if (!value || typeof value !== 'object' || !('$asset' in value)) return value
      const reference = value as { $asset: string; mimeType: string }
      if (!/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(reference.$asset)) throw new Error('Invalid note asset reference')
      return `data:${reference.mimeType};base64,${readFileSync(join(this.rootPath, noteId, reference.$asset)).toString('base64')}`
    })
    if (entry.id !== entryId || entry.noteId !== noteId) throw new Error('Note entry identity mismatch')
    return entry
  }

  reconcile(noteId: string, entryIds: string[]): void {
    const notePath = join(this.rootPath, noteId)
    const entriesPath = join(notePath, 'entries')
    const retained = new Set(entryIds.map((id) => `${id}.json`))
    const referenced = new Set<string>()
    // Read every retained body before deleting anything, including shared assets.
    for (const name of retained) {
      const entry = JSON.parse(readFileSync(join(entriesPath, name), 'utf8')) as MagicNoteStoredEntry
      mapMediaFields(entry.content, (value) => {
        if (value && typeof value === 'object' && '$asset' in value) referenced.add(String(value.$asset))
        return value
      })
    }
    this.atomicWrite(join(notePath, 'note.json'), JSON.stringify({ id: noteId, entries: entryIds }))
    if (existsSync(entriesPath)) {
      for (const name of readdirSync(entriesPath)) {
        if (!retained.has(name)) {
          fs.rmSync(join(entriesPath, name), { force: true })
          continue
        }
      }
    }
    const assetsPath = join(notePath, 'assets')
    if (existsSync(assetsPath)) {
      for (const name of readdirSync(assetsPath)) {
        if (!referenced.has(`assets/${name}`)) fs.rmSync(join(assetsPath, name), { force: true })
      }
    }
  }

  deleteNote(noteId: string): void {
    fs.rmSync(join(this.rootPath, noteId), { recursive: true, force: true })
  }

  reconcileNotes(noteIds: Set<string>): void {
    if (!existsSync(this.rootPath)) return
    for (const name of readdirSync(this.rootPath)) {
      if (/^[a-f0-9-]{36}$/.test(name) && !noteIds.has(name)) this.deleteNote(name)
    }
  }

  clear(): void {
    fs.rmSync(this.rootPath, { recursive: true, force: true })
  }
}
