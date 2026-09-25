from pathlib import Path
import difflib
files = ['src/main/assistant/assistant-database.test.ts', 'src/main/assistant/activity-history-io.test.ts', 'src/main/assistant/assistant-storage-upgrade.test.ts', 'src/main/assistant/heartbeat-database.test.ts', 'src/main/magic-notes/magic-note-storage.test.ts']
patch = ''
for name in files:
    old = Path(name).read_text(encoding='utf-8')
    new = old.replace('DROP TABLE review_checkpoints; ALTER TABLE messages DROP COLUMN review_revision;', 'DROP VIEW IF EXISTS supervision_review_current;\n      DROP TABLE IF EXISTS supervision_review_navigation; DROP TABLE IF EXISTS supervision_review_batches;\n      DROP TABLE IF EXISTS supervision_review_sources; DROP TABLE IF EXISTS supervision_review_runs;\n      DROP TABLE review_checkpoints; ALTER TABLE messages DROP COLUMN review_revision;')
    patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/'+name, tofile='b/'+name))
Path('.validation-fixtures.patch').write_text(patch, encoding='utf-8')
