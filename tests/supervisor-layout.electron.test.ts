// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import { SupervisionStoryStore } from '../src/main/assistant/supervision-stories'
import { SupervisionExperienceStore } from '../src/main/assistant/supervision-experiences'

it(process.env.GOODBUDDY_STORY_GRAPH_FOCUS
  ? 'focuses the production 3D story camera through canvas and sidebar selection'
  : process.env.GOODBUDDY_SUPERVISOR_SIDEBAR
  ? 'renders the production supervision card at narrow widths in both themes'
  : 'renders the production supervisor at desktop, narrow, and mobile widths', async () => {
  const temporaryRoot = resolve('temp/story-graph-focus')
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, 'supervisor-'))
  // Optional local acceptance run against an online backup. Never initialize/migrate or run models.
  let portable: string | undefined
  if (process.env.GOODBUDDY_SUPERVISOR_BACKUP) {
    const connection = new DatabaseSync(process.env.GOODBUDDY_SUPERVISOR_BACKUP, { readOnly: true })
    try {
      const database = new AssistantDatabase(process.env.GOODBUDDY_SUPERVISOR_BACKUP)
      Reflect.set(database, 'database', connection)
      const results = database.listSupervisionResults()
      portable = JSON.stringify({ results,
        projects: connection.prepare('SELECT id, name FROM projects').all(),
        graphs: Object.fromEntries(results.map(result => [result.id, database.getSupervisionGraph({ resultId: result.id })])),
        stories: Object.fromEntries(results.map(result => [JSON.stringify(result.scope), {
          stories: new SupervisionStoryStore(connection).list(result.scope),
          experiences: new SupervisionExperienceStore(connection).list(result.scope.kind === 'projects' ? result.scope.projectIds : undefined),
          unassigned: new SupervisionStoryStore(connection).unassignedCount(result.scope), canUndo: false
        }]))
      })
    } finally { connection.close() }
  }
  const css = await readFile(
    'src/renderer/src/supervisor-workspace.css',
    'utf8'
  )
  const server = await createServer({
    configFile: false,
    root: resolve('.'),
    cacheDir: join(directory, 'vite'),
    plugins: [
      react(),
      {
        name: 'supervisor-fixture',
        configureServer(server) {
          if (process.env.GOODBUDDY_STORY_GRAPH_FOCUS) server.middlewares.use('/focus-export.json', async (_request, response) => {
            const source = await readFile('docs/features/story-graph/3d-demo-data.js', 'utf8')
            response.setHeader('Content-Type', 'application/json')
            response.end(source.slice(source.indexOf('window.STORY_DATA = ') + 'window.STORY_DATA = '.length).trim().replace(/;$/, ''))
          })
          if (portable) server.middlewares.use('/portable-review.json', (_request, response) => {
            response.setHeader('Content-Type', 'application/json')
            response.end(portable)
          })
          server.middlewares.use(
            '/supervisor.html',
            async (_request, response) => {
              response.setHeader('Content-Type', 'text/html; charset=utf-8')
              response.end(
                await server.transformIndexHtml(
                  '/supervisor.html',
                  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SIMULATED Supervisor validation</title><body><div id="root"></div><script type="module" src="/tests/support/supervisor-layout-regression.tsx"></script></body></html>'
                )
              )
            }
          )
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await server.listen()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TEMP: directory, TMP: directory, TMPDIR: directory,
      GOODBUDDY_SUPERVISOR_URL:
        server.resolvedUrls!.local[0] + 'supervisor.html' + (process.env.GOODBUDDY_SUPERVISOR_SIDEBAR ? '?sidebar=1' : ''),
      GOODBUDDY_SUPERVISOR_DIRECTORY: directory,
      GOODBUDDY_SUPERVISOR_TOKENS: JSON.stringify([
        ...new Set(
          [...css.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1])
        )
      ])
    }
    delete env.ELECTRON_RUN_AS_NODE
    const driver = join(directory, 'driver.mjs')
    await copyFile(
      resolve('tests/support/supervisor-layout-driver.mjs'),
      driver
    )
    await copyFile(resolve('tests/support/supervisor-selection-driver.mjs'), join(directory, 'supervisor-selection-driver.mjs'))
    await copyFile(resolve('tests/support/story-graph-focus-driver.mjs'), join(directory, 'story-graph-focus-driver.mjs'))
    const child = spawn(createRequire(import.meta.url)('electron'), [driver], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    const timeout = setTimeout(() => child.kill(), 90000)
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      expect(code, output).toBe(0)
      if (process.env.GOODBUDDY_STORY_GRAPH_FOCUS) process.stdout.write(output)
      else console.log(output)
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)
