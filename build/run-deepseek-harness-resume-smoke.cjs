'use strict'

const { build } = require('esbuild')
const { spawn } = require('node:child_process')
const { mkdir, mkdtemp, rm, readFile, readdir, copyFile } = require('node:fs/promises')
const { resolve, join, dirname } = require('node:path')
const { verifyHarnessBundleImports } = require('./verify-desktop-runtimes.cjs')

async function main() {
  const temporaryRoot = resolve('temp')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'dsh-resume-'))
  const host = resolve(process.env.GOODBUDDY_HARNESS_SMOKE_HOST || 'out/main/deepseek-harness-host-bootstrap.js')
  try {
    if (process.env.GB_DSH_RESUME_SETTINGS) {
      // Windows safeStorage needs the existing profile's encrypted master key.
      // Use an isolated copy; never open or mutate the live Electron profile.
      await mkdir(join(root, 'profile'), { recursive: true })
      await copyFile(join(dirname(process.env.GB_DSH_RESUME_SETTINGS), 'Local State'), join(root, 'profile', 'Local State'))
    }
    // Inspect actual release chunks, so repository node_modules cannot mask
    // the missing external dependency of an app.asar.unpacked Host.
    for (const directory of [dirname(host), join(dirname(host), 'chunks')]) {
      for (const name of await readdir(directory)) {
        if (name.startsWith('deepseek-harness') && name.endsWith('.js')) {
          verifyHarnessBundleImports(await readFile(join(directory, name), 'utf8'), name)
        }
      }
    }
    const entry = join(root, 'resume.cjs')
    await build({ entryPoints: [resolve('tests/support/deepseek-harness-resume.electron.ts')], outfile: entry,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'error' })
    const env = { ...process.env, TEMP: root, TMP: root, GB_DSH_RESUME_ROOT: root, GB_DSH_RESUME_HOST: host }
    delete env.ELECTRON_RUN_AS_NODE
    for (const phase of ['create', 'resume']) {
      await new Promise((done, fail) => {
        const child = spawn(require('electron'), [entry, '--no-sandbox', `--user-data-dir=${join(root, 'profile')}`], {
          env: { ...env, GB_DSH_RESUME_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        })
        child.stdout.pipe(process.stdout)
        child.stderr.pipe(process.stderr)
        const timer = setTimeout(() => { child.kill(); fail(new Error(`Harness ${phase} timed out`)) }, 60_000)
        child.once('error', error => { clearTimeout(timer); fail(error) })
        child.once('exit', code => {
          clearTimeout(timer)
          if (code === 0) done()
          else fail(new Error(`Harness ${phase} exited ${code}`))
        })
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1 })
