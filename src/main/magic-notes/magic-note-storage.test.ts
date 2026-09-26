import { randomUUID } from 'node:crypto'
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MagicNoteCanvasContent, MagicNoteContent } from '../../shared/magic-notes-contracts'
import { AssistantDatabase, ASSISTANT_DATABASE_SCHEMA_VERSION } from '../assistant/assistant-database'
import { getPendingAssistantStorageUpgrade, upgradeAssistantStorage } from '../assistant/assistant-storage-upgrade'

const actualFs = { renameSync: fs.renameSync, rmSync: fs.rmSync }

const directories: string[] = []
const connections: Array<{ close(): void }> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const connection of connections.splice(0)) connection.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(options: ConstructorParameters<typeof AssistantDatabase>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'goodbuddy-note-files-'))
  directories.push(directory)
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path, options)
  connections.push(database)
  database.initialize(directory)
  const sql = new DatabaseSync(path)
  connections.push(sql)
  return { database, sql, directory, path }
}

const png = 'data:image/png;base64,iVBORw0KGgo='
const rich: MagicNoteContent = { version: 1, ops: [
  { insert: 'Task' }, { insert: '\n', attributes: { list: 'unchecked' } },
  { insert: { image: png } },
  { insert: { localVideo: { name: 'clip.mp4', mimeType: 'video/mp4', size: 12, dataUrl: `data:video/mp4;base64,${Buffer.from('0000ftyp0000').toString('base64')}` } } },
  { insert: { attachment: { name: 'file.txt', mimeType: 'text/plain', size: 5, dataUrl: 'data:text/plain;base64,aGVsbG8=' } } },
  { insert: '\n' }
] }

function canvas(size = 40): MagicNoteCanvasContent {
  return {
    version: 2, kind: 'paged-canvas',
    pages: [{ id: 'page', width: 794, height: 1123,
      background: { type: 'pdf', assetId: 'original-pdf-id', pageNumber: 1, text: 'PDF text' },
      objects: [{ type: 'Image', src: png }, { type: 'IText', text: 'Annotation', left: 0 }] }],
    flow: { ops: [{ insert: 'Canvas task' }, { insert: '\n', attributes: { list: 'unchecked' } }] },
    assets: [{ id: 'original-pdf-id', name: 'document.pdf', mimeType: 'application/pdf',
      dataUrl: `data:application/pdf;base64,${Buffer.from(`%PDF-${'x'.repeat(size)}`).toString('base64')}` }],
    preview: png
  }
}

describe('Magic note SQLite and filesystem storage', () => {
  it('preserves textual data URLs and arbitrary $asset objects through save, migration and reopen', () => {
    const { database, sql, path, directory } = setup()
    const text = 'data:text/plain;base64,aGVsbG8'
    const custom = { $asset: 'not-a-storage-reference', mimeType: 'text/plain', name: text, text }
    const richText: MagicNoteContent = { version: 1, ops: [{ insert: text }, { insert: png }, { insert: '\n' }] }
    const drawing = canvas()
    drawing.pages[0]!.objects.push({ type: 'IText', ...custom }, { type: 'Group', objects: [{ type: 'Image', src: png, name: text, custom }] })
    drawing.flow!.ops.push({ insert: text }, { insert: { image: png } }, { insert: { custom } })
    const notes = [richText, drawing].map((content) => database.createMagicNote({ title: 'Literal URLs', content }))
    for (const [index, note] of notes.entries()) expect(note.entries[0]!.content).toEqual([richText, drawing][index])
    const disk = JSON.parse(readFileSync(join(directory, 'notes', notes[1]!.id, 'entries', `${notes[1]!.entries[0]!.id}.json`), 'utf8'))
    expect(disk.content.pages[0].objects[2]).toEqual({ type: 'IText', ...custom })
    expect(disk.content.flow.ops.at(-2).insert.image).toHaveProperty('$asset')
    expect(existsSync(join(directory, 'notes', notes[0]!.id, 'assets'))).toBe(false)
    database.close()
    for (const note of notes) sql.prepare('UPDATE magic_note_entries SET content_json = ? WHERE id = ?').run(JSON.stringify(note.entries[0]!.content), note.entries[0]!.id)
    rmSync(join(directory, 'notes'), { recursive: true })
    upgradeAssistantStorage(path, () => undefined)
    database.initialize(directory)
    expect(notes.map((note) => database.getMagicNote(note.id))).toEqual(notes)
  })

  it.each(['manifest', 'gc'] as const)('returns successful creates/updates despite deferred %s failures and retries cleanup', (failure) => {
    const changed = vi.fn()
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { database, directory } = setup({ onMagicNotesChanged: changed })
    let failing = true
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (failing && failure === 'manifest' && String(target).endsWith('note.json')) throw new Error('manifest rename blocked')
      actualFs.renameSync(source, target)
    })
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (failing && failure === 'gc' && String(path).endsWith('unused.bin')) throw new Error('asset removal blocked')
      actualFs.rmSync(path, options)
    })
    const note = database.createMagicNote({ title: 'Committed', content: rich })
    const root = join(directory, 'notes', note.id)
    writeFileSync(join(root, 'assets', 'unused.bin'), 'unused')
    const appended = database.createMagicNoteEntry({ noteId: note.id, content: rich, plainText: '' })
    const first = appended.entries[0]!
    const saved = database.updateMagicNoteEntry({ entryId: first.id, expectedRevision: first.revision, content: canvas(), plainText: '' })
    expect(saved.entries).toHaveLength(2)
    expect(saved.entries[0]!.content).toEqual(canvas())
    expect(changed).toHaveBeenCalledTimes(3)
    expect(logged).toHaveBeenCalledWith('Magic note file cleanup deferred', expect.objectContaining({ noteId: note.id, error: expect.any(Error) }))
    database.close()
    database.initialize(directory)
    expect(database.getMagicNote(note.id)).toEqual(saved)
    failing = false
    expect(database.listMagicNotes()[0]!.entryCount).toBe(2)
    expect(existsSync(join(root, 'assets', 'unused.bin'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'note.json'), 'utf8')).entries).toEqual(saved.entries.map((entry) => entry.id))
  })

  it.each(['delete', 'reset'] as const)('notifies and completes %s after SQL commit when filesystem removal fails', (operation) => {
    const changed = vi.fn()
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { database, directory } = setup({ onMagicNotesChanged: changed })
    const note = database.createMagicNote({ title: 'Remove', content: rich })
    const root = join(directory, 'notes', note.id)
    let failing = true
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (failing && (String(path) === root || String(path) === join(directory, 'notes'))) throw new Error('directory removal blocked')
      actualFs.rmSync(path, options)
    })
    if (operation === 'delete') database.deleteMagicNote(note.id)
    else database.clearAssistantData()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(database.listMagicNotes()).toEqual([])
    expect(existsSync(root)).toBe(true)
    expect(logged).toHaveBeenCalled()
    // A delayed reset cleanup must not remove notes created afterwards.
    const retained = database.createMagicNote({ title: 'New note', content: canvas() })
    failing = false
    database.listMagicNotes()
    expect(existsSync(root)).toBe(false)
    expect(database.getMagicNote(retained.id)).toEqual(retained)
  })

  it('still rejects authoritative body rename failures before committing SQL', () => {
    const { database } = setup()
    const note = database.createMagicNote({ title: 'Body error', content: rich })
    const entry = note.entries[0]!
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(target).endsWith(`${entry.id}.json`)) throw new Error('body rename blocked')
      actualFs.renameSync(source, target)
    })
    expect(() => database.updateMagicNoteEntry({ entryId: entry.id, content: canvas(), expectedRevision: entry.revision, plainText: '' })).toThrow('body rename blocked')
    expect(database.getMagicNote(note.id)).toEqual(note)
  })

  it.each(['cancel', 'vacuum'] as const)('retries free-page reclamation after %s interrupts a fully converted migration', (failure) => {
    const { database, sql, path } = setup()
    const note = database.createMagicNote({ title: 'Migration retry', content: canvas(1024 * 1024) })
    database.close()
    sql.prepare('UPDATE magic_note_entries SET content_json = ? WHERE id = ?').run(JSON.stringify(note.entries[0]!.content), note.entries[0]!.id)
    sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const confirmedUpgrade = getPendingAssistantStorageUpgrade(path)!
    let cancelled = false
    const exec = DatabaseSync.prototype.exec
    const injected = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, statement) {
      if (failure === 'vacuum' && statement.includes('VACUUM')) throw new Error('vacuum disk full')
      return exec.call(this, statement)
    })
    expect(() => upgradeAssistantStorage(path, (progress) => {
      if (failure === 'cancel' && progress.stage === 'converting' && progress.processed === progress.total) cancelled = true
    }, () => cancelled)).toThrow(failure === 'cancel' ? 'cancelled' : 'vacuum disk full')
    injected.mockRestore()
    expect(sql.prepare("SELECT json_extract(content_json, '$.storage') AS storage FROM magic_note_entries").get()!.storage).toBe('file')
    expect(sql.prepare('PRAGMA freelist_count').get()!.freelist_count).toBeGreaterThan(0)
    expect(getPendingAssistantStorageUpgrade(path)).toBeUndefined()
    const stages: string[] = []
    upgradeAssistantStorage(path, (progress) => stages.push(progress.stage), () => false, {
      confirmedUpgrade
    })
    expect(stages).toContain('compacting')
    expect(sql.prepare('PRAGMA freelist_count').get()!.freelist_count).toBe(0)
  })

  it('hydrates rich media, searches, writes todos back, shares assets, deletes and resets', () => {
    const { database, sql, directory } = setup()
    const note = database.createMagicNote({ title: 'Media', content: rich })
    const first = note.entries[0]!
    const root = join(directory, 'notes', note.id)
    expect(first.content).toEqual(rich)
    expect(readdirSync(join(root, 'assets'))).toHaveLength(3)
    const body = readFileSync(join(root, 'entries', `${first.id}.json`), 'utf8')
    expect(body).not.toContain('base64')
    expect(body).toContain('$asset')
    expect(sql.prepare('SELECT content_json FROM magic_note_entries WHERE id = ?').get(first.id)).toEqual({
      content_json: JSON.stringify({ storage: 'file', version: 1, revision: 0 })
    })
    const second = database.createMagicNoteEntry({ noteId: note.id, content: rich, plainText: 'ignored' }).entries[1]!
    expect(readdirSync(join(root, 'assets'))).toHaveLength(3)
    const todo = database.listMagicTodos().find((item) => item.entryId === first.id)!
    database.updateMagicTodo({ todoId: todo.id, expectedRevision: todo.revision, completed: true })
    expect(database.getMagicNoteEntry(first.id).content).toMatchObject({ ops: expect.arrayContaining([{ insert: '\n', attributes: { list: 'checked' } }]) })
    expect(database.searchMagicNotes('Task', 20)).toHaveLength(2)
    database.deleteMagicNoteEntry(first.id)
    expect(existsSync(join(root, 'entries', `${first.id}.json`))).toBe(false)
    expect(database.getMagicNoteEntry(second.id).content).toEqual(rich)
    expect(readdirSync(join(root, 'assets'))).toHaveLength(3)
    expect(JSON.parse(readFileSync(join(root, 'note.json'), 'utf8')).entries).toEqual([second.id])
    database.deleteMagicNote(note.id)
    expect(existsSync(root)).toBe(false)
    expect(database.listMagicTodos()).toEqual([])
    database.createMagicNote({ title: 'Reset', content: canvas() })
    database.clearAssistantData()
    expect(existsSync(join(directory, 'notes'))).toBe(false)
    expect(database.listMagicNotes()).toEqual([])
  })

  it('migrates both formats via the startup worker path and preserves metadata, comments and todo IDs', () => {
    const { database, sql, path, directory } = setup()
    const original = [rich, canvas()].map((content) => database.createMagicNote({ title: 'Legacy', content }))
    for (const note of original) {
      const entry = note.entries[0]!
      database.saveMagicNoteAnalysis({ entryId: entry.id, expectedRevision: entry.revision,
        comments: [{ id: randomUUID(), kind: 'summary', content: 'Keep comment' }] })
    }
    const before = original.map((note) => database.getMagicNote(note.id))
    const todos = database.listMagicTodos()
    database.close()
    for (const note of before) {
      const entry = note.entries[0]!
      sql.prepare('UPDATE magic_note_entries SET content_json = ? WHERE id = ?').run(JSON.stringify(entry.content), entry.id)
    }
    sql.exec(`ALTER TABLE supervision_results DROP COLUMN graph_snapshot_json;
      DROP TABLE activity_history_records;
      ALTER TABLE activity_history RENAME COLUMN record_order_json TO records_json;
      DROP TRIGGER messages_review_insert; DROP TRIGGER messages_review_update;
      DROP TRIGGER messages_review_delete; DROP TRIGGER tasks_review_delete;
      DROP VIEW IF EXISTS supervision_review_current;
      DROP TABLE IF EXISTS supervision_review_navigation; DROP TABLE IF EXISTS supervision_review_batches;
      DROP TABLE IF EXISTS supervision_review_sources; DROP TABLE IF EXISTS supervision_review_runs;
      DROP TABLE review_checkpoints; ALTER TABLE messages DROP COLUMN review_revision;
      PRAGMA user_version = 37`)
    rmSync(join(directory, 'notes'), { recursive: true })
    const progress: number[] = []
    upgradeAssistantStorage(path, (value) => progress.push(value.processed))
    expect(progress).toContain(2)
    expect(sql.prepare('PRAGMA user_version').get()).toEqual({ user_version: ASSISTANT_DATABASE_SCHEMA_VERSION })
    database.initialize(directory)
    expect(original.map((note) => database.getMagicNote(note.id))).toEqual(before)
    expect(database.listMagicTodos()).toEqual(todos)
    database.close()
    database.initialize(directory)
    expect(original.map((note) => database.getMagicNote(note.id))).toEqual(before)
    expect(sql.prepare('SELECT SUM(length(content_json)) AS bytes FROM magic_note_entries').get()!.bytes).toBeLessThan(200)
    expect(sql.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })

  it('retains legacy payload on a failed migration and retries partially completed conversion', () => {
    const { database, sql, directory, path } = setup()
    const note = database.createMagicNote({ title: 'Legacy', content: rich })
    database.createMagicNoteEntry({ noteId: note.id, content: canvas(), plainText: '' })
    const entries = database.getMagicNote(note.id).entries
    database.close()
    for (const entry of entries) sql.prepare('UPDATE magic_note_entries SET content_json = ? WHERE id = ?').run(JSON.stringify(entry.content), entry.id)
    rmSync(join(directory, 'notes'), { recursive: true })
    sql.exec(`CREATE TRIGGER fail_note_migration BEFORE UPDATE OF content_json ON magic_note_entries
      BEGIN SELECT RAISE(ABORT, 'migration index failure'); END`)
    expect(() => upgradeAssistantStorage(path, () => undefined)).toThrow('migration index failure')
    expect(JSON.parse(String(sql.prepare('SELECT content_json FROM magic_note_entries WHERE id = ?').get(entries[0]!.id)!.content_json))).toEqual(rich)
    sql.exec('DROP TRIGGER fail_note_migration')
    let cancelled = false
    expect(() => upgradeAssistantStorage(path, (progress) => {
      if (progress.stage === 'converting') cancelled = true
    }, () => cancelled)).toThrow('cancelled')
    expect(sql.prepare("SELECT COUNT(*) AS count FROM magic_note_entries WHERE json_extract(content_json, '$.storage') = 'file'").get()!.count).toBe(1)
    upgradeAssistantStorage(path, () => undefined)
    database.initialize(directory)
    expect(database.getMagicNote(note.id).entries).toEqual(entries)
  })

  it('reclaims migrated SQLite payload space and restores a coordinated database/files backup', async () => {
    const { database, sql, directory, path } = setup()
    const note = database.createMagicNote({ title: 'Large legacy PDF', content: canvas(2 * 1024 * 1024) })
    const entry = note.entries[0]!
    database.close()
    sql.prepare('UPDATE magic_note_entries SET content_json = ? WHERE id = ?').run(JSON.stringify(entry.content), entry.id)
    sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const bytesBefore = statSync(path).size
    const stages: string[] = []
    upgradeAssistantStorage(path, (progress) => stages.push(progress.stage))
    expect(stages).toContain('compacting')
    expect(bytesBefore - statSync(path).size).toBeGreaterThan(2 * 1024 * 1024)
    database.initialize(directory)
    expect(database.getMagicNote(note.id)).toEqual(note)
    const destination = join(directory, 'backup')
    mkdirSync(destination)
    await backup(sql, join(destination, 'assistant.sqlite'))
    cpSync(join(directory, 'notes'), join(destination, 'notes'), { recursive: true })
    database.deleteMagicNote(note.id)
    const restored = new AssistantDatabase(join(destination, 'assistant.sqlite'))
    connections.push(restored)
    restored.initialize(destination)
    expect(restored.getMagicNote(note.id)).toEqual(note)
    expect(restored.listMagicTodos()[0]).toMatchObject({ title: 'Canvas task' })
  })

  it('rejects stale entry and todo revisions before touching files', () => {
    const { database, directory } = setup()
    const note = database.createMagicNote({ title: 'Conflict', content: rich })
    const entry = note.entries[0]!
    const path = join(directory, 'notes', note.id, 'entries', `${entry.id}.json`)
    const before = readFileSync(path)
    const mtime = statSync(path).mtimeMs
    database.saveMagicNoteAnalysis({ entryId: entry.id, expectedRevision: 0, comments: [] })
    expect(() => database.updateMagicNoteEntry({ entryId: entry.id, expectedRevision: 0, content: canvas(), plainText: '' })).toThrow('已被更新')
    const todo = database.listMagicTodos()[0]!
    expect(() => database.updateMagicTodo({ todoId: todo.id, expectedRevision: 100, completed: true })).toThrow('已被更新')
    expect(readFileSync(path)).toEqual(before)
    expect(statSync(path).mtimeMs).toBe(mtime)
    expect(readdirSync(join(directory, 'notes', note.id, 'assets'))).toHaveLength(3)
  })

  it.each([false, true])('repairs a committed file after a real SQLite index failure (reopen=%s)', (reopen) => {
    const { database, sql, directory } = setup()
    const note = database.createMagicNote({ title: 'Repair', content: rich })
    const entry = note.entries[0]!
    sql.exec(`CREATE TRIGGER fail_note_update BEFORE UPDATE OF content_json ON magic_note_entries
      BEGIN SELECT RAISE(ABORT, 'index unavailable'); END`)
    expect(() => database.updateMagicNoteEntry({ entryId: entry.id, expectedRevision: entry.revision, content: canvas(), plainText: '' })).toThrow('index unavailable')
    expect(() => database.searchMagicNotes('PDF text', 10)).toThrow('index unavailable')
    sql.exec('DROP TRIGGER fail_note_update')
    if (reopen) { database.close(); database.initialize(directory) }
    expect(database.searchMagicNotes('PDF text', 10)).toHaveLength(1)
    expect(database.getMagicNoteEntry(entry.id)).toMatchObject({ content: canvas(), revision: 1 })
    expect(database.listMagicTodos()).toEqual([expect.objectContaining({ title: 'Canvas task' })])
    expect(() => database.updateMagicNoteEntry({ entryId: entry.id, expectedRevision: 0, content: rich, plainText: '' })).toThrow('已被更新')
  })

  it('repairs todo writeback from disk without replacing the todo identity', () => {
    const { database, sql } = setup()
    database.createMagicNote({ title: 'Todo repair', content: canvas() })
    const todo = database.listMagicTodos()[0]!
    sql.exec(`CREATE TRIGGER fail_todo_update BEFORE UPDATE OF completed ON magic_todos
      BEGIN SELECT RAISE(ABORT, 'todo index unavailable'); END`)
    expect(() => database.updateMagicTodo({ todoId: todo.id, expectedRevision: todo.revision, completed: true })).toThrow('todo index unavailable')
    sql.exec('DROP TRIGGER fail_todo_update')
    expect(database.getMagicTodo(todo.id)).toMatchObject({ id: todo.id, completed: true, revision: todo.revision + 1 })
    expect(database.getMagicNoteEntry(todo.entryId).content).toMatchObject({ flow: { ops: expect.arrayContaining([{ insert: '\n', attributes: { list: 'checked' } }]) } })
  })

  it('rolls back failed creates and cleans their unaccepted files without affecting existing notes', () => {
    const { database, sql, directory } = setup()
    const retained = database.createMagicNote({ title: 'Keep', content: rich })
    sql.exec(`CREATE TRIGGER fail_note_insert BEFORE INSERT ON magic_note_entries
      BEGIN SELECT RAISE(ABORT, 'insert unavailable'); END`)
    expect(() => database.createMagicNote({ title: 'Failed', content: canvas() })).toThrow('insert unavailable')
    expect(() => database.createMagicNoteEntry({ noteId: retained.id, content: canvas(), plainText: '' })).toThrow('insert unavailable')
    sql.exec('DROP TRIGGER fail_note_insert')
    expect(database.listMagicNotes()).toHaveLength(1)
    expect(database.getMagicNote(retained.id)).toEqual(retained)
    expect(readdirSync(join(directory, 'notes'))).toEqual([retained.id])
    expect(readdirSync(join(directory, 'notes', retained.id, 'assets'))).toHaveLength(3)
  })

  it('keeps body unchanged if binary persistence fails and does not hide missing body errors', () => {
    const { database, directory } = setup()
    const note = database.createMagicNote({ title: 'Failure', content: { version: 1, ops: [{ insert: 'Plain\n' }] } })
    const entry = note.entries[0]!
    const root = join(directory, 'notes', note.id)
    const path = join(root, 'entries', `${entry.id}.json`)
    const before = readFileSync(path)
    writeFileSync(join(root, 'assets'), 'block directory creation')
    expect(() => database.updateMagicNoteEntry({ entryId: entry.id, expectedRevision: 0, content: rich, plainText: '' })).toThrow()
    expect(readFileSync(path)).toEqual(before)
    rmSync(join(root, 'assets'))
    expect(database.getMagicNoteEntry(entry.id).content).toEqual(entry.content)
    rmSync(path)
    expect(() => database.getMagicNoteEntry(entry.id)).toThrow('ENOENT')
    database.close()
    expect(() => database.initialize(directory)).toThrow('ENOENT')
  })

  it('updates a PDF canvas repeatedly without copying PDF bytes to SQLite, and collects only unreferenced assets', () => {
    const { database, sql, directory, path } = setup()
    const content = canvas(1024 * 1024)
    const note = database.createMagicNote({ title: 'PDF', content })
    let entry = note.entries[0]!
    const root = join(directory, 'notes', note.id)
    const assetFiles = readdirSync(join(root, 'assets'))
    const pdf = assetFiles.find((name) => name.endsWith('.pdf'))!
    const pdfPath = join(root, 'assets', pdf)
    const originalMtime = statSync(pdfPath).mtimeMs
    sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const bytesBefore = statSync(path).size
    for (let index = 0; index < 20; index++) {
      const next = { ...content, pages: [{ ...content.pages[0]!, objects: [{ type: 'IText', text: `Edit ${index}`, left: index }] }] }
      entry = database.updateMagicNoteEntry({ entryId: entry.id, expectedRevision: entry.revision, content: next, plainText: '' }).entries[0]!
    }
    expect(statSync(pdfPath).mtimeMs).toBe(originalMtime)
    expect(readdirSync(join(root, 'assets'))).toEqual(assetFiles)
    expect(statSync(join(root, 'entries', `${entry.id}.json`)).size).toBeLessThan(5000)
    expect(statSync(path).size + statSync(`${path}-wal`).size - bytesBefore).toBeLessThan(2 * 1024 * 1024)
    const todo = database.listMagicTodos()[0]!
    database.updateMagicTodo({ todoId: todo.id, expectedRevision: todo.revision, completed: true })
    const saved = database.getMagicNoteEntry(entry.id)
    database.close()
    database.initialize(directory)
    expect(database.getMagicNoteEntry(entry.id)).toEqual(saved)
    database.updateMagicNoteEntry({ entryId: entry.id, expectedRevision: saved.revision, content: { version: 1, ops: [{ insert: 'No PDF\n' }] }, plainText: '' })
    expect(readdirSync(join(root, 'assets'))).toEqual([])
  })

  it('cleans orphan files on reopening without removing another persisted record', () => {
    const { database, directory } = setup()
    const note = database.createMagicNote({ title: 'Keep', content: rich })
    const root = join(directory, 'notes', note.id)
    const orphan = join(directory, 'notes', randomUUID())
    mkdirSync(orphan)
    writeFileSync(join(root, 'entries', `${randomUUID()}.json`), '{}')
    writeFileSync(join(root, 'assets', 'unused.bin'), 'unused')
    database.close()
    database.initialize(directory)
    expect(existsSync(orphan)).toBe(false)
    expect(readdirSync(join(root, 'entries'))).toEqual([`${note.entries[0]!.id}.json`])
    expect(readdirSync(join(root, 'assets'))).toHaveLength(3)
    expect(database.getMagicNote(note.id).entries[0]!.content).toEqual(rich)
  })
})
