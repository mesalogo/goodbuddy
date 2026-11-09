// @vitest-environment node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { encodeSpeechWav } from '../src/main/speech/remote-speech-transcription'

it('saves speech settings and records through real Preload, IPC and transcription in Electron', async () => {
  const directory = await mkdtemp(resolve('temp/speech-electron-'))
  const server = await createServer({ configFile: false, root: resolve('.'), cacheDir: join(directory, 'vite'),
    plugins: [react(), { name: 'speech-fixture', configureServer(server) {
      server.middlewares.use('/speech.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await server.transformIndexHtml('/speech.html', '<html><body><div id="root"></div><script type="module" src="/tests/support/speech-settings-regression.tsx"></script></body></html>'))
      })
    } }], optimizeDeps: { entries: ['tests/support/speech-settings-regression.tsx'] }, server: { host: '127.0.0.1', port: 0, watch: null }
  })
  try {
    await build({ entryPoints: ['tests/support/speech-settings-driver.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: join(directory, 'driver.mjs') })
    await build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(directory, 'preload.cjs') })
    const samples = Float32Array.from({ length: 16000 * 5 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 16000) * 0.2)
    const audio = join(directory, 'sample.wav')
    await writeFile(audio, Buffer.from(await encodeSpeechWav(samples, 16000, new AbortController().signal)))
    await server.listen()
    const env: NodeJS.ProcessEnv = { ...process.env, GB_SPEECH_DIRECTORY: directory, GB_SPEECH_AUDIO: process.env.GB_SPEECH_AUDIO ?? audio, GB_SPEECH_URL: server.resolvedUrls!.local[0] + 'speech.html' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'driver.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 90000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
      expect(timedOut, output).toBe(false)
      expect(code, output).toBe(0)
      expect(output).toContain('SPEECH_ELECTRON_OK')
      console.log(output)
    } finally { clearTimeout(timeout) }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
}, 120000)
