import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import type { ContextAttachment } from '../shared/contracts'
import type { ParsedDocument } from './knowledge/document-parser'
import type { DocumentResultStorage } from './document-result-storage'

type AssetRow = { id: string; path: string; name: string; result_id: string | null; metadata: string }

function metadata(context: ContextAttachment): string {
  const { thumbnailUrl: _thumbnail, contentUrl: _content, ...descriptor } = context
  void _thumbnail
  void _content
  return JSON.stringify(descriptor)
}

function originalFileName(context: Pick<ContextAttachment, 'name' | 'originalMime'>): string {
  return `original${context.originalMime ? `.${context.originalMime === 'image/jpeg' ? 'jpg' : context.originalMime.slice(6)}` : extname(context.name).toLowerCase()}`
}

export class ConversationAttachmentStorage {
  private readonly database: DatabaseSync
  constructor(private readonly root: string, private readonly results: DocumentResultStorage) {
    mkdirSync(root, { recursive: true })
    this.database = new DatabaseSync(join(root, 'conversation-attachments.sqlite'))
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version > 1) { this.database.close(); throw new Error('附件数据库版本较新，请升级应用') }
    this.database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;`)
    if (version.user_version === 0) this.database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
        result_id TEXT UNIQUE, metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachment_refs (
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL, kind TEXT NOT NULL, owner_id TEXT NOT NULL,
        PRIMARY KEY (attachment_id, kind, owner_id)
      );
      CREATE INDEX IF NOT EXISTS attachment_refs_owner ON attachment_refs(kind, owner_id);
      CREATE INDEX IF NOT EXISTS attachment_refs_conversation ON attachment_refs(conversation_id);
      PRAGMA user_version = 1; COMMIT;`)
    results.setPersistentLookup((id) => {
      const row = this.database.prepare('SELECT * FROM attachments WHERE result_id = ?').get(id) as AssetRow | undefined
      return row ? { directory: join(root, row.path), original: join(root, row.path, originalFileName({ ...JSON.parse(row.metadata), name: row.name })) } : undefined
    })
  }

  private row(id: string): AssetRow {
    const row = this.database.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AssetRow | undefined
    if (!row) throw new Error('附件资源不存在，请重新添加')
    return row
  }

  has(id: string): boolean { return Boolean(this.database.prepare('SELECT 1 FROM attachments WHERE id = ?').get(id)) }

  save(context: ContextAttachment, serialized: string, original: Buffer): void {
    const path = join('temp', 'document-parsing', context.id)
    const directory = join(this.root, path)
    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, originalFileName({ ...context, name: context.originalName ?? context.name })), original)
      writeFileSync(join(directory, 'request.json'), serialized)
      this.database.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?)').run(
        context.id, path, context.originalName ?? context.name, context.resultId ?? null, metadata(context)
      )
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
  }

  async saveDocument(name: string, original: Buffer, parsed: ParsedDocument): Promise<string> {
    if (!parsed.parsingSettings) throw new Error('解析结果缺少生效配置')
    const result = await this.results.save(name, original, parsed, parsed.parsingSettings, parsed.parsingDurationMs ?? 0)
    return result.id
  }

  discardResult(id: string): Promise<void> { return this.results.release(id) }

  adoptDocument(context: ContextAttachment, serialized: string): void {
    const location = this.results.detach(context.resultId!)
    try {
      writeFileSync(join(location.directory, 'request.json'), serialized)
      this.database.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?)').run(
        context.id, relative(this.root, location.directory), context.originalName ?? context.name,
        context.resultId!, metadata(context)
      )
    } catch (error) { rmSync(location.directory, { recursive: true, force: true }); throw error }
  }

  get(id: string): ContextAttachment {
    const descriptor = JSON.parse(this.row(id).metadata) as ContextAttachment
    const request = JSON.parse(this.request(id)) as ContextAttachment
    return { ...descriptor, ...(request.thumbnailUrl ? { thumbnailUrl: request.thumbnailUrl } : {}), ...(request.kind === 'image' && 'data' in request && typeof request.data === 'string' && request.data.length <= 399_970 ? { contentUrl: `data:image/jpeg;base64,${request.data}` } : {}) }
  }
  update(context: ContextAttachment, serialized: string): void {
    const row = this.row(context.id)
    writeFileSync(join(this.root, row.path, 'request.json'), serialized)
    this.database.prepare('UPDATE attachments SET metadata = ? WHERE id = ?').run(metadata(context), context.id)
  }

  copyResult(sourceId: string, targetId: string): boolean {
    const source = this.row(sourceId)
    if (!source.result_id) return false
    const target = this.row(targetId)
    const from = join(this.root, source.path), to = join(this.root, target.path)
    const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'))
    writeFileSync(join(to, 'parsed.md'), readFileSync(join(from, 'parsed.md')))
    cpSync(join(from, 'images'), join(to, 'images'), { recursive: true })
    writeFileSync(join(to, 'manifest.json'), JSON.stringify({ ...manifest, id: targetId }))
    this.database.prepare('UPDATE attachments SET result_id = ? WHERE id = ?').run(targetId, targetId)
    return true
  }
  request(id: string): string { return readFileSync(join(this.root, this.row(id).path, 'request.json'), 'utf8') }
  original(id: string): { name: string; data: Buffer; path: string } {
    const row = this.row(id)
    const path = join(this.root, row.path, originalFileName({ ...JSON.parse(row.metadata), name: row.name }))
    return { name: row.name, data: readFileSync(path), path }
  }

  reference(conversationId: string, kind: 'draft' | 'message' | 'queue' | 'parsing', ownerId: string, ids: string[]): void {
    const assets = ids.filter((id) => this.has(id)).map((id) => this.row(id))
    for (const asset of assets) {
      if (!asset.path.startsWith(`temp`)) continue
      const context = JSON.parse(asset.metadata) as ContextAttachment
      const target = join('conversation-assets', conversationId, context.kind === 'image' ? 'images' : 'documents', asset.id)
      mkdirSync(join(this.root, 'conversation-assets', conversationId, context.kind === 'image' ? 'images' : 'documents'), { recursive: true })
      renameSync(join(this.root, asset.path), join(this.root, target))
      try {
        this.database.prepare('UPDATE attachments SET path = ? WHERE id = ?').run(target, asset.id)
      } catch (error) {
        renameSync(join(this.root, target), join(this.root, asset.path))
        throw error
      }
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('DELETE FROM attachment_refs WHERE kind = ? AND owner_id = ?').run(kind, ownerId)
      const insert = this.database.prepare('INSERT INTO attachment_refs VALUES (?, ?, ?, ?)')
      for (const asset of assets) insert.run(asset.id, conversationId, kind, ownerId)
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  draft(conversationId: string): ContextAttachment[] {
    return (this.database.prepare(`SELECT a.id FROM attachments a JOIN attachment_refs r ON r.attachment_id = a.id
      WHERE r.kind = 'draft' AND r.owner_id = ? ORDER BY r.rowid`).all(conversationId) as { id: string }[])
      .map((row) => this.get(row.id))
  }

  release(kind: 'draft' | 'message' | 'queue' | 'parsing', ownerId: string): void {
    this.database.prepare('DELETE FROM attachment_refs WHERE kind = ? AND owner_id = ?').run(kind, ownerId)
  }

  deleteConversation(conversationId: string, protectedIds: readonly string[] = []): void {
    this.database.prepare('DELETE FROM attachment_refs WHERE conversation_id = ?').run(conversationId)
    this.collect(protectedIds)
  }

  private collectOrphanDirectories(): void {
    const owned = new Set((this.database.prepare('SELECT path FROM attachments').all() as { path: string }[]).map((row) => row.path))
    const directories = (path: string): string[] => {
      try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/iu.test(entry.name)).map((entry) => entry.name) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    }
    const candidates = directories(join(this.root, 'temp', 'document-parsing')).map((id) => join('temp', 'document-parsing', id))
    for (const conversationId of directories(join(this.root, 'conversation-assets'))) {
      for (const kind of ['images', 'documents']) {
        for (const id of directories(join(this.root, 'conversation-assets', conversationId, kind))) candidates.push(join('conversation-assets', conversationId, kind, id))
      }
    }
    for (const path of candidates) {
      if (owned.has(path) || this.results.isTemporaryResult(path.split(/[\\/]/u).at(-1)!)) continue
      rmSync(join(this.root, path), { recursive: true, force: true })
    }
  }

  collect(protectedIds: readonly string[] = []): void {
    const protectedSet = new Set(protectedIds)
    const rows = this.database.prepare(`SELECT a.* FROM attachments a WHERE NOT EXISTS
      (SELECT 1 FROM attachment_refs r WHERE r.attachment_id = a.id)`).all() as AssetRow[]
    for (const row of rows) {
      if (protectedSet.has(row.id)) continue
      try {
        rmSync(join(this.root, row.path), { recursive: true, force: true })
        this.database.prepare('DELETE FROM attachments WHERE id = ?').run(row.id)
      } catch {
        // The unreferenced row remains authoritative for the next cleanup attempt.
        console.warn('Attachment cleanup deferred; unreferenced files will be retried on the next cleanup')
      }
    }
  }

  reconcile(hasOwner: (conversationId: string, kind: string, ownerId: string) => boolean, startup = false, protectedIds: readonly string[] = []): void {
    const owners = this.database.prepare('SELECT DISTINCT conversation_id, kind, owner_id FROM attachment_refs').all() as { conversation_id: string; kind: string; owner_id: string }[]
    for (const owner of owners) {
      if (!hasOwner(owner.conversation_id, owner.kind, owner.owner_id)) {
        this.database.prepare('DELETE FROM attachment_refs WHERE conversation_id = ? AND kind = ? AND owner_id = ?').run(owner.conversation_id, owner.kind, owner.owner_id)
      }
    }
    if (startup) this.database.exec("UPDATE attachments SET metadata = json_set(metadata, '$.parsingState', 'interrupted') WHERE json_extract(metadata, '$.parsingState') = 'parsing'")
    this.collect(protectedIds)
    if (startup) this.collectOrphanDirectories()
  }

  beginParsing(conversationId: string, name: string, original: Buffer): string {
    const id = randomUUID()
    const context: ContextAttachment = { id, resourceId: id, name, originalName: name, originalSize: original.length, kind: 'text', size: 0, preview: '', parsingState: 'parsing' }
    this.save(context, JSON.stringify(context), original)
    this.reference(conversationId, 'parsing', id, [id])
    return id
  }

  parsingFailed(id: string, interrupted: boolean, error: string): void {
    const context = this.get(id)
    this.update({ ...context, parsingState: interrupted ? 'interrupted' : 'failed', parsingError: error.slice(0, 1000) }, this.request(id))
  }

  pendingParsing(conversationId: string): ContextAttachment[] {
    return (this.database.prepare(`SELECT a.id FROM attachments a JOIN attachment_refs r ON r.attachment_id = a.id
      WHERE r.kind = 'parsing' AND r.conversation_id = ? AND json_extract(a.metadata, '$.parsingState') IN ('failed', 'interrupted')`).all(conversationId) as { id: string }[]).map((row) => this.get(row.id))
  }

  close(): void { this.database.close() }
}
