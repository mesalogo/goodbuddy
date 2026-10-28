const { build } = require('esbuild')
const { mkdir, rm } = require('node:fs/promises')
const { resolve, join } = require('node:path')
const { spawn } = require('node:child_process')
async function main() {
  const root = resolve('temp/managed-browser-ui')
  await mkdir(root, { recursive: true })
  try {
    const common = { bundle: true, logLevel: 'warning', jsx: 'automatic' }
    await Promise.all([
      build({ ...common, entryPoints: ['tests/managed-browser-ui.fixture.tsx'], platform: 'browser', format: 'iife', outfile: join(root, 'view.js'), define: { 'process.env.NODE_ENV': '"test"' } }),
      build({ ...common, entryPoints: ['src/preload/index.ts'], platform: 'node', format: 'cjs', external: ['electron'], outfile: join(root, 'preload.cjs') }),
      build({ ...common, entryPoints: ['tests/managed-browser-ui.electron.ts'], platform: 'node', format: 'cjs', packages: 'external', outfile: join(root, 'main.cjs') })
    ])
    for (const scale of ['1', '1.5']) {
      const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root, GB_BROWSER_SCALE: scale }
      delete env.ELECTRON_RUN_AS_NODE
      await new Promise((done, reject) => {
        const child = spawn(require('electron'), [join(root, 'main.cjs')], { env, stdio: 'inherit' })
        const timer = setTimeout(() => { child.kill(); reject(new Error('Native browser test timed out')) }, 90_000)
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('exit', (code) => { clearTimeout(timer); if (code === 0) done(); else reject(new Error(`Native browser test exited ${code}`)) })
      })
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
