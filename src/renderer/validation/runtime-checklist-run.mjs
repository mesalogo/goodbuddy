import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import process from 'node:process'
import console from 'node:console'

const require = createRequire(import.meta.url)
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 }, esbuild: { jsx: 'automatic' } })
await server.listen()
const port = server.httpServer.address().port
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.CHECKLIST_VISUAL_URL = `http://127.0.0.1:${port}/src/renderer/validation/runtime-checklist.html`
env.CHECKLIST_VISUAL_EVIDENCE = resolve(process.argv[2])
env.CHECKLIST_VISUAL_BASELINE = process.argv.includes('--baseline') ? '1' : ''
const child = spawn(require('electron'), [resolve('src/renderer/validation'), `--user-data-dir=${resolve(process.argv[2], 'profile')}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.on('exit', async code => { console.log('Electron exit:', code); await server.close(); process.exit(code ?? 1) })
