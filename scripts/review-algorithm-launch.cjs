// Explicit --prepare is read-only; --run launches only this bounded experiment.
/* global require, __dirname, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { build } = require('esbuild')
const { mkdirSync, writeFileSync, openSync, existsSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { resolve, join } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
async function main() {
  const [mode, directoryArg, databasePath, conversationId, settingsPath] = process.argv.slice(2)
  const directory = resolve(directoryArg), repository = resolve(__dirname, '..')
  if (directory.toLowerCase().startsWith(repository.toLowerCase())) throw Error('External output required')
  if (mode === '--prepare') {
    const { pages, chunks, hash } = await import('./review-algorithm.mjs')
    mkdirSync(directory, { recursive: true })
    if (existsSync(join(directory, 'sources.private.json'))) throw Error('Use existing frozen sources or a new output directory')
    const db = new DatabaseSync(databasePath, { readOnly: true })
    db.exec('PRAGMA query_only=ON; BEGIN')
    const metadata = db.prepare('SELECT id, project_id, title FROM conversations WHERE id=?').get(conversationId)
    if (!metadata) throw Error('Unknown conversation')
    const messagePages = [...pages(db, conversationId)]
    db.exec('ROLLBACK'); db.close()
    const messages = messagePages.flat(), batches = [...chunks(messagePages)]
    if (batches.length + 3 > 12) throw Error('Scope exceeds 12-call budget; choose smaller complete conversation')
    writeFileSync(join(directory, 'sources.private.json'), JSON.stringify({ metadata, messagePages, batches }))
    const report = { conversationId, sourceMessages: messages.length, pages: messagePages.length,
      utf16: messages.reduce((n, m) => n + m.content.length, 0), codePoints: messages.reduce((n, m) => n + Array.from(m.content).length, 0),
      leafBatches: batches.length, spans: batches.flat().length, maxLeafUtf16: Math.max(...batches.map((b) => b.reduce((n, s) => n + s.text.length, 0))),
      sourceHash: hash(JSON.stringify(messages)), firstAt: messages[0].created_at, lastAt: messages.at(-1).created_at,
      originalDatabaseReadOnly: true, maxHttpRequests: 12 }
    writeFileSync(join(directory, 'scope.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2)); return
  }
  if (mode !== '--run' || !settingsPath) throw Error('Expected --run output database conversation settings')
  const main = join(directory, 'main.cjs')
  await build({ entryPoints: [join(__dirname, 'review-algorithm-live.mjs')], outfile: main, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'absolute-private-dependencies', setup(builder) {
      builder.onResolve({ filter: /^[^./]|^@/ }, (args) => {
        if (args.kind === 'entry-point' || /^[A-Za-z]:/.test(args.path) || args.path === '@opencode-ai/sdk/v2') return
        if (args.path === 'electron') return { path: args.path, external: true }
        return { path: require.resolve(args.path, { paths: [repository] }), external: true }
      })
    } }] })
  const env = { ...process.env, GB_REVIEW_PROBE_DIRECTORY: directory, GB_REVIEW_LIVE_SETTINGS: settingsPath }
  delete env.ELECTRON_RUN_AS_NODE
  const attempt = Date.now()
  const child = spawn(require('electron'), [main], { env, detached: true, stdio: ['ignore',
    openSync(join(directory, `stdout-${attempt}.private.log`), 'wx'), openSync(join(directory, `stderr-${attempt}.private.log`), 'wx')] })
  writeFileSync(join(directory, 'launch.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }))
  child.unref(); console.log(JSON.stringify({ directory, pid: child.pid }))
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
