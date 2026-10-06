// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AssistantDatabase } from './assistant/assistant-database'

it('runs the three owner-local perf harnesses with explicit reader/checkpoint shutdown', async () => {
  const parent = resolve('temp/goodbuddy-storage-foundation')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'perf-smoke-'))
  try {
    const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
    try {
      database.initialize(directory)
      database.saveLocalConversations([{ header: { id: randomUUID(), title: 'Synthetic perf', updatedAt: 1 },
        messages: [{ id: randomUUID(), role: 'user', state: 'complete', content: 'Synthetic', createdAt: 1 }] }])
    } finally { database.close() }
    const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', TEMP: directory, TMP: directory, TMPDIR: directory,
      GB_MPERF_NODE: '1', GB_MPERF_CONVERSATIONS: '4', GB_MPERF_MESSAGES: '20', GB_MPERF_ACTIVITY: '100', GB_MPERF_CALLS: '2',
      GB_KPERF_NODE: '1', GB_KPERF_SIZES: '100', GB_KPERF_DIMENSIONS: '4', GB_KPERF_QUERIES: '2',
      GB_WPERF_NODE: '1', GB_WPERF_DATA: directory, GB_WPERF_EVENTS: '4', GB_WPERF_RATE: '0', GB_WPERF_KEEP: '0' }
    for (const script of ['run-main-perf.cjs', 'run-knowledge-perf.cjs', 'run-write-perf.cjs']) {
      const child = spawn(process.execPath, [resolve('build', script)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', value => { output += value })
      child.stderr.on('data', value => { output += value })
      const timeout = setTimeout(() => child.kill(), 40_000)
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
        expect(code, `${script}: ${output}`).toBe(0)
      } finally { clearTimeout(timeout) }
    }
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 120_000)
