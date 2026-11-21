// Run: node scripts/validate-pi.mjs [--live --max-calls=8]
// Validates the Pi coding-agent SDK bundle inside an Electron UtilityProcess.
// GB_PI_CANDIDATE may point to an existing trimmed candidate root (containing node_modules);
// otherwise @earendil-works/pi-coding-agent@1.5.2 is installed into the task directory.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { setTimeout, clearTimeout } from 'node:timers'
import electron from 'electron'

const version = '1.5.2'
async function install(directory) {
  const target = path.join(directory, 'install')
  await fs.mkdir(target)
  await fs.writeFile(path.join(target, 'package.json'), '{"private":true}')
  const command = `npm${process.platform === 'win32' ? '.cmd' : ''} install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@${version}`
  const child = spawn(process.platform === 'win32' ? process.env.COMSPEC ?? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command], { cwd: target, stdio: 'ignore', env: { ...process.env, TEMP: directory, TMP: directory } })
  if (await new Promise(resolve => child.once('exit', resolve)) !== 0) throw new Error('Pi install failed')
  return target
}
async function copyCandidate(source, target) {
  const pi = path.join('node_modules', '@earendil-works', 'pi-coding-agent')
  const keep = [path.join(pi, 'package.json'), path.join(pi, 'dist', 'bundle'), path.join(pi, 'dist', 'core', 'export-html'), path.join(pi, 'dist', 'modes', 'interactive'),
    path.join('node_modules', 'jiti'), path.join('node_modules', '@silvia-odwyer', 'photon-node')]
  for (const entry of keep) await fs.cp(path.join(source, entry), path.join(target, entry), { recursive: true, filter: file => !/\.(map|d\.[cm]?ts)$/.test(file) })
}
async function size(directory) {
  let bytes = 0
  for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true })) if (entry.isFile()) bytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size
  return bytes
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..')
  await fs.mkdir(path.join(root, 'temp'), { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, 'temp', 'pi-validation-'))
  const settings = process.env.GB_PI_SETTINGS ?? path.join(process.env.APPDATA ?? '', 'goodbuddy', 'runtime-settings.json')
  const before = await fs.readFile(settings).catch(() => null)
  let child
  try {
    const candidate = path.join(directory, 'candidate')
    await copyCandidate(process.env.GB_PI_CANDIDATE ?? await install(directory), candidate)
    await fs.rm(path.join(directory, 'install'), { recursive: true, force: true })
    console.log(JSON.stringify({ candidateMiB: +((await size(candidate)) / 1048576).toFixed(2) }))
    await fs.copyFile(path.join(import.meta.dirname, 'validate-pi-host.mjs'), path.join(directory, 'host.mjs'))
    await build({ entryPoints: [path.join(import.meta.dirname, 'validate-pi-main.mjs')], outfile: path.join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    if (process.argv.includes('--live') && process.platform === 'win32') {
      const state = JSON.parse(await fs.readFile(path.join(path.dirname(settings), 'Local State'), 'utf8'))
      await fs.mkdir(path.join(directory, 'electron'), { recursive: true })
      await fs.writeFile(path.join(directory, 'electron', 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }))
    }
    const maxCalls = process.argv.find(arg => arg.startsWith('--max-calls='))?.split('=')[1] ?? '0'
    if (!/^\d+$/.test(maxCalls) || Number(maxCalls) > 16) throw new Error('Invalid call budget')
    const env = { ...process.env, GB_PI_DIRECTORY: directory, GB_PI_LIVE: String(process.argv.includes('--live')), GB_PI_MAX_CALLS: maxCalls, GB_PI_BUNDLE: path.join(candidate, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'index.js'), TEMP: directory, TMP: directory }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(electron, [path.join(directory, 'main.cjs')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n'); buffer = lines.pop()
      for (const line of lines) if (line.startsWith('PI_REPORT ')) console.log(line.slice(10))
    })
    let errors = ''
    child.stderr.on('data', chunk => { if (process.env.GB_PI_DEBUG) errors += chunk })
    const timer = setTimeout(() => process.platform === 'win32' ? spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : child.kill(), 600000)
    process.exitCode = await new Promise(resolve => child.on('exit', resolve)) ?? 1
    clearTimeout(timer)
    if (errors) console.error(errors.slice(-4000))
  } finally {
    if (child && child.exitCode === null) child.kill()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    const after = await fs.readFile(settings).catch(() => null)
    const unchanged = before === null ? after === null : after !== null && before.equals(after)
    console.log(JSON.stringify({ cleanup: 'removed task directory', userSettingsUnchanged: unchanged }))
    if (!unchanged) process.exitCode = 1
  }
}
main().catch(error => { console.error(`Pi harness launcher failed: ${String(error?.message ?? error).slice(0, 300)}`); process.exitCode = 1 })
