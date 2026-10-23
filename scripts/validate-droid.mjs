// Run: node scripts/validate-droid.mjs [--live] [--max-calls=16] [--question-only|--text-only|--native [--native-background]]
// GB_DROID_SUITE selects native, capabilities, tasks, or session when --native is set.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import console from 'node:console'
import { setTimeout, clearTimeout } from 'node:timers'
import electron from 'electron'

async function main() {
  const root = path.resolve(import.meta.dirname, '..')
  const directory = await fs.mkdtemp(await fs.mkdir(path.join(root, 'temp'), { recursive: true }).then(() => path.join(root, 'temp', 'droid-validation-')))
  let child
  const settingsFiles = [process.env.GB_DROID_SETTINGS ?? path.join(process.env.APPDATA, 'goodbuddy', 'runtime-settings.json'), ...['settings.json', 'config.json'].map(name => path.join(homedir(), '.factory', name))]
  const originals = await Promise.all(settingsFiles.map(file => fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })))
  try {
    if (process.argv.includes('--native')) {
      const sdkDirectory = path.join(directory, 'sdk')
      await fs.mkdir(sdkDirectory)
      await fs.writeFile(path.join(sdkDirectory, 'package.json'), '{"private":true}')
      const install = spawn(process.platform === 'win32' ? process.env.COMSPEC ?? 'cmd.exe' : 'npm', process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm.cmd install --ignore-scripts --no-audit --no-fund @factory/droid-sdk@0.10.0']
        : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@factory/droid-sdk@0.10.0'],
      { cwd: sdkDirectory, env: { ...process.env, TEMP: directory, TMP: directory }, stdio: 'ignore' })
      const installed = await new Promise((resolve, reject) => { install.once('error', reject); install.once('exit', resolve) })
      if (installed !== 0) throw new Error('Isolated SDK install failed')
    }
    const profile = path.join(directory, 'electron')
    await fs.mkdir(profile)
    if (process.platform === 'win32') {
      const source = process.env.GB_DROID_SETTINGS ?? path.join(process.env.APPDATA, 'goodbuddy', 'runtime-settings.json')
      const state = JSON.parse(await fs.readFile(path.join(path.dirname(source), 'Local State'), 'utf8'))
      await fs.writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }))
    }
    await build({ entryPoints: [path.join(import.meta.dirname, 'validate-droid-main.mjs')], outfile: path.join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    const env = { ...process.env, GB_DROID_DIRECTORY: directory, GB_DROID_LIVE: String(process.argv.includes('--live')), TEMP: directory, TMP: directory }
    env.GB_DROID_MAX_CALLS = process.argv.find(arg => arg.startsWith('--max-calls='))?.split('=')[1] ?? '16'
    if (!Number.isInteger(Number(env.GB_DROID_MAX_CALLS)) || Number(env.GB_DROID_MAX_CALLS) < 0 || Number(env.GB_DROID_MAX_CALLS) > 18) throw new Error('Invalid call budget')
    env.GB_DROID_QUESTION_ONLY = String(process.argv.includes('--question-only'))
    env.GB_DROID_TEXT_ONLY = String(process.argv.includes('--text-only'))
    env.GB_DROID_NATIVE = String(process.argv.includes('--native'))
    env.GB_DROID_NATIVE_BACKGROUND = String(process.argv.includes('--native-background'))
    if (env.GB_DROID_NATIVE === 'true' && Number(env.GB_DROID_MAX_CALLS) > 8) throw new Error('Native validation requires an explicit budget of at most 8 calls')
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron, [path.join(directory, 'main.cjs')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
    // Only structured harness output is published; Chromium diagnostics can contain URLs.
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n'); buffer = lines.pop()
      for (const line of lines) if (line.startsWith('DROID_REPORT ')) console.log(line.slice(13))
    })
    child.stderr.resume()
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill()
    }, 600000)
    const code = await new Promise(resolve => child.on('exit', resolve))
    clearTimeout(timer)
    process.exitCode = code ?? 1
  } finally {
    if (child && child.exitCode === null) child.kill()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    const after = await Promise.all(settingsFiles.map(file => fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })))
    const unchanged = originals.every((before, i) => before === null ? after[i] === null : after[i] !== null && before.equals(after[i]))
    console.log(JSON.stringify({ cleanup: 'removed task directory', userSettingsUnchanged: unchanged }))
    if (!unchanged) process.exitCode = 1
  }
}
main().catch(() => { console.error('Droid harness launcher failed (details suppressed)'); process.exitCode = 1 })
