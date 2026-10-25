"""Export allowlisted metadata only. Never exports original titles, bodies or IDs.

Usage: python export_snapshot.py <portable-data-dir>
Output: snapshot.js beside this script. Source databases are opened read-only.
"""
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


def connect(path):
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    return db


def rows(db, query, args=()):
    return [dict(row) for row in db.execute(query, args)]


def enum(value, allowed):
    return value if value in allowed else 'unknown'


def stamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat()
    except (TypeError, ValueError, AttributeError):
        return None


def export(root):
    result = {'capturedAt': datetime.now(timezone.utc).isoformat(), 'schema': 1}
    with connect(root / 'assistant.sqlite') as db:
        projects = rows(db, 'SELECT id, length(name) titleLength, kind, status FROM projects ORDER BY created_at,id')
        pmap = {r['id']: f'p{i+1}' for i, r in enumerate(projects)}
        result['projects'] = [{'id': pmap[r['id']], 'titleLength': r['titleLength'],
                               'kind': enum(r['kind'], ('local', 'ssh', 'remote', 'channel')),
                               'status': enum(r['status'], ('active', 'archived'))} for r in projects]
        conversations = rows(db, '''SELECT c.id,c.project_id,length(c.title) titleLength,c.status,c.updated_at,c.pinned,
            (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id) messageCount,
            (SELECT coalesce(max(length(content)),0) FROM messages m WHERE m.conversation_id=c.id) maxMessageLength
            FROM conversations c ORDER BY c.updated_at DESC,c.id''')
        result['conversations'] = []
        for i, r in enumerate(conversations):
            messages = rows(db, '''SELECT role,state,length(content) characters,sequence,created_at
                FROM messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 12''', (r['id'],))
            result['conversations'].append({
                'id': f'c{i+1}', 'project': pmap.get(r['project_id']), 'titleLength': r['titleLength'],
                'status': enum(r['status'], ('idle', 'running', 'completed', 'failed', 'cancelled', 'archived', 'active')),
                'updatedAt': stamp(r['updated_at']), 'pinned': bool(r['pinned']),
                'messageCount': r['messageCount'], 'maxMessageLength': r['maxMessageLength'],
                'messages': [{'role': enum(m['role'], ('user', 'assistant', 'system', 'tool')),
                              'state': enum(m['state'], ('streaming', 'complete', 'error')),
                              'characters': m['characters'] or 0, 'sequence': m['sequence'],
                              'createdAt': stamp(m['created_at'])} for m in reversed(messages)]})
        result['messageCount'] = db.execute('SELECT count(*) FROM messages').fetchone()[0]
        notes = rows(db, 'SELECT id,length(title) titleLength,pinned,updated_at FROM magic_notes ORDER BY updated_at DESC,id')
        result['notes'] = []
        for i, r in enumerate(notes):
            entries = rows(db, '''SELECT length(plain_text) characters,created_at,
                coalesce(image_bytes,0) imageBytes
                FROM magic_note_entries WHERE note_id=? ORDER BY created_at DESC,id''', (r['id'],))
            result['notes'].append({'id': f'n{i+1}', 'titleLength': r['titleLength'], 'pinned': bool(r['pinned']),
                                    'updatedAt': stamp(r['updated_at']),
                                    'entries': [{'characters': e['characters'] or 0, 'createdAt': stamp(e['created_at']),
                                                 'hasImage': bool(e['imageBytes'])} for e in entries]})
    with connect(root / 'knowledge.sqlite') as db:
        libraries = rows(db, 'SELECT id,length(name) titleLength,storage_mode,graph_enabled FROM knowledge_bases ORDER BY created_at,id')
        lmap = {r['id']: f'k{i+1}' for i,r in enumerate(libraries)}
        result['libraries'] = [{'id': lmap[r['id']], 'titleLength': r['titleLength'],
                                'storage': enum(r['storage_mode'], ('managed','reference')),
                                'graphEnabled': bool(r['graph_enabled'])} for r in libraries]
        docs = rows(db, '''SELECT d.id,d.knowledge_base_id,length(d.title) titleLength,d.mime_type,d.updated_at,
            s.status sourceStatus,s.type sourceType,
            (SELECT count(*) FROM chunks c WHERE c.document_id=d.id) chunks,
            (SELECT count(*) FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id WHERE c.document_id=d.id) embeddings,
            (SELECT sum(length(content)) FROM chunks c WHERE c.document_id=d.id) characters
            FROM documents d LEFT JOIN knowledge_sources s ON s.id=d.source_id ORDER BY d.created_at,d.id''')
        dmap = {r['id']: f'd{i+1}' for i,r in enumerate(docs)}
        result['documents'] = [{'id': dmap[r['id']], 'library': lmap.get(r['knowledge_base_id']),
            'titleLength': r['titleLength'], 'format': enum(r['mime_type'], ('text/plain', 'text/markdown', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
            'sourceStatus': enum(r['sourceStatus'], ('ready','queued','syncing','paused','failed')),
            'sourceType': enum(r['sourceType'], ('file','directory','url')), 'updatedAt': stamp(r['updated_at']),
            'chunks': r['chunks'], 'embeddings': r['embeddings'], 'characters': r['characters'] or 0} for r in docs]
        tasks = rows(db, '''SELECT library_id,document_id,kind,stage,status,progress,completed_items,total_items,
            created_at,completed_at,CASE WHEN error_message IS NULL OR error_message='' THEN 0 ELSE 1 END hasError
            FROM knowledge_tasks ORDER BY created_at DESC,id''')
        result['tasks'] = [{'id': f't{i+1}', 'library': lmap.get(r['library_id']), 'document': dmap.get(r['document_id']),
            'kind': enum(r['kind'], ('source-sync','document-process','document-rebuild','library-rebuild','embedding-rebuild','graph-rebuild','parsing','embedding','graph')),
            'stage': enum(r['stage'], ('queued','syncing','reading','parsing','chunking','indexing','embedding','graph','finalizing')),
            'status': enum(r['status'], ('queued','running','succeeded','failed','cancelled','skipped','interrupted')),
            'progress': r['progress'], 'completedItems': r['completed_items'], 'totalItems': r['total_items'],
            'createdAt': stamp(r['created_at']), 'completedAt': stamp(r['completed_at']), 'hasError': bool(r['hasError'])} for i,r in enumerate(tasks)]
        result['graph'] = {'entities': db.execute('SELECT count(*) FROM graph_entities').fetchone()[0],
                           'relations': db.execute('SELECT count(*) FROM graph_relations').fetchone()[0]}
    # Only boolean appearance fields, never model, account, host or provider settings.
    settings = json.loads((root / 'application-settings.json').read_text(encoding='utf-8-sig'))
    keys = ('desktopNotificationsEnabled', 'chatMinimapEnabled', 'transparentFrostedEffectEnabled', 'conversationHtmlRenderingEnabled')
    result['settings'] = {k: settings[k] for k in keys if type(settings.get(k)) is bool}
    return result


if __name__ == '__main__':
    data = export(Path(sys.argv[1]))
    output = Path(__file__).with_name('snapshot.js')
    output.write_text('window.PORTABLE_SNAPSHOT = ' + json.dumps(data, ensure_ascii=True, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(json.dumps({'projects': len(data['projects']), 'conversations': len(data['conversations']),
                      'messages': data['messageCount'], 'notes': len(data['notes']),
                      'entries': sum(len(n['entries']) for n in data['notes']),
                      'libraries': len(data['libraries']), 'documents': len(data['documents']), 'tasks': len(data['tasks']),
                      'taskStatuses': sorted(set(t['status'] for t in data['tasks'])),
                      'sourceStatuses': sorted(set(d['sourceStatus'] for d in data['documents'])),
                      'settingsFields': list(data['settings'])}, ensure_ascii=True))
