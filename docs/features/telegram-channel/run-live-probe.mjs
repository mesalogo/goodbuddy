/* global process, console, setTimeout, clearTimeout, URL */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const messages = {
  connection: 'PASS: production driver getMe/getWebhookInfo.',
  selected: 'Selected a queued private test marker from the last 24 hours.',
  delivered: 'PASS: production driver and ChannelService delivered the test reply.',
  missing: 'FAIL: no eligible marker in the pending batch (maximum 100 updates).',
  failed: 'FAIL: live probe failed; network details suppressed.',
  shutdown: 'FAIL: probe shutdown did not complete.'
}

async function main() {
  const args = process.argv.slice(2)
  let tempParent = tmpdir()
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--temp-parent' && args[i + 1]) tempParent = args[++i]
    else if (!['--dry-run', '--send-test'].includes(args[i])) {
      console.error('Usage: node run-live-probe.mjs [--dry-run | --send-test] [--temp-parent PATH]')
      process.exitCode = 1
      return
    }
  }
  const dry = args.includes('--dry-run')
  const send = args.includes('--send-test')
  if (dry && send) throw new Error('Invalid mode')
  if (!dry && !/^\d+:[A-Za-z0-9_-]+$/.test(process.env.TELEGRAM_BOT_TOKEN ?? '')) {
    console.error('Set TELEGRAM_BOT_TOKEN in the environment before running live.')
    process.exitCode = 1
    return
  }
  if (!(await stat(tempParent)).isDirectory()) throw new Error('Invalid temporary parent')
  const directory = await mkdtemp(join(tempParent, 'goodbuddy-telegram-live-'))
  try {
    const outfile = join(directory, 'probe.cjs')
    await build({
      entryPoints: [fileURLToPath(new URL('./live-probe-main.ts', import.meta.url))],
      outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      external: ['electron'], logLevel: 'silent'
    })
    const check = spawnSync(process.execPath, ['--check', outfile], {
      stdio: 'ignore', timeout: 15_000
    })
    if (check.status !== 0) throw new Error('Bundle syntax check failed')
    const electron = require('electron')
    if (typeof electron !== 'string') throw new Error('Electron executable unavailable')
    if (dry) {
      console.log('PASS: bundled production sources and checked syntax; Electron not launched, no network calls.')
      return
    }
    if (send) {
      console.log('Send mode: use a dedicated idle bot. Polling may consume/acknowledge earlier queued updates.')
      console.log('Only the selected exact /goodbuddy_test event receives a fixed reply; no model or tools run.')
    }
    const userData = join(directory, 'user-data')
    await mkdir(userData)
    const env = { ...process.env, GOODBUDDY_PROBE_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_ENABLE_LOGGING
    delete env.ELECTRON_LOG_FILE
    delete env.NODE_OPTIONS
    env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
    process.exitCode = await new Promise((resolve) => {
      // Never forward Electron/Chromium stderr: it may contain credential-bearing URLs.
      const child = spawn(electron, [outfile, ...(send ? ['--send-test'] : [])], {
        env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
      })
      let passed = false
      const timer = setTimeout(() => child.kill('SIGKILL'), 125_000)
      const interrupt = () => child.kill('SIGKILL')
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', interrupt)
      child.on('message', (code) => {
        if (typeof code !== 'string' || !Object.hasOwn(messages, code)) return
        console.log(messages[code])
        if (code === (send ? 'delivered' : 'connection')) passed = true
      })
      child.once('error', () => resolve(1))
      child.once('close', (code) => {
        clearTimeout(timer)
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', interrupt)
        if (code !== 0 || !passed) console.error('FAIL: Electron probe did not complete successfully.')
        resolve(code === 0 && passed ? 0 : 1)
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch(() => {
  console.error('FAIL: probe setup, build, or cleanup failed; details suppressed.')
  process.exitCode = 1
})
