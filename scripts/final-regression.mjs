/* global process, console, setTimeout, clearTimeout */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const base = join(root, 'temp', 'goodbuddy-final-tests-final')
const stateFile = join(base, 'status.json')
const lockFile = join(base, 'runner.lock')
const npm = join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
const [mode = 'status', selection = 'all', ...filters] = process.argv.slice(2)
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'))
const killTree = (pid) => {
  if (!pid || !alive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { /* Already exited. */ }
  }
}

if (mode === 'start') {
  if (!['all', 'test', 'typecheck', 'lint'].includes(selection)) throw new Error('Unknown validation selection')
  if (!statSync(join(root, 'temp')).isDirectory()) throw new Error('Repository temp directory is required')
  mkdirSync(base, { recursive: true })
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8'))
    if (alive(pid)) throw new Error(`Validation runner already active: ${pid}`)
    rmSync(lockFile)
  }
  const lock = openSync(lockFile, 'wx')
  writeFileSync(lock, String(process.pid))
  closeSync(lock)
  const log = openSync(join(base, 'runner.log'), 'a')
  try {
    const child = spawn(process.execPath, [script, 'worker', selection, ...filters], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log]
    })
    await new Promise((resolveSpawn, reject) => {
      child.once('spawn', resolveSpawn)
      child.once('error', reject)
    })
    writeFileSync(lockFile, String(child.pid))
    child.unref()
    console.log(JSON.stringify({ runnerPid: child.pid, selection, logs: base }))
  } catch (error) {
    rmSync(lockFile, { force: true })
    throw error
  } finally { closeSync(log) }
} else if (mode === 'status') {
  const state = readState()
  console.log(JSON.stringify({ ...state, runnerAlive: alive(state.pid) }, null, 2))
} else if (mode === 'stop') {
  const state = readState()
  if (state.status === 'running') {
    killTree(state.childPid)
    killTree(state.pid)
    state.status = 'stopped'
    state.endedAt = new Date().toISOString()
    writeFileSync(stateFile, JSON.stringify(state, null, 2))
    rmSync(lockFile, { force: true })
  }
} else if (mode === 'worker') {
  const run = join(base, new Date().toISOString().replace(/[:.]/g, '-'))
  const tmp = join(run, 'tmp')
  mkdirSync(tmp, { recursive: true })
  if (!statSync(tmp).isDirectory()) throw new Error('Child temp directory was not created')
  const state = { pid: process.pid, status: 'running', startedAt: new Date().toISOString(), run, results: [] }
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2))
  let child
  let interrupted = false
  const interrupt = (reason) => {
    interrupted = true
    state.reason = reason
    killTree(child?.pid)
  }
  process.on('SIGINT', () => interrupt('SIGINT'))
  process.on('SIGTERM', () => interrupt('SIGTERM'))
  process.on('exit', () => killTree(child?.pid))
  const deadline = setTimeout(() => interrupt('30-minute overall deadline exceeded'), 30 * 60 * 1000)
  save()
  try {
    for (const job of selection === 'all' ? ['test', 'typecheck', 'lint'] : [selection]) {
      if (interrupted) break
      const started = Date.now()
      const report = join(run, 'tests.json')
      const args = job === 'test'
        ? ['test', '--', ...filters, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`]
        : ['run', job]
      const logPath = join(run, `${job}.log`)
      const log = openSync(logPath, 'w')
      try {
        child = spawn(process.execPath, [npm, ...args], {
          cwd: root, windowsHide: true, detached: process.platform !== 'win32',
        env: { ...process.env, TEMP: join(tmpdir(), 'goodbuddy-final-tests-final'), TMP: join(tmpdir(), 'goodbuddy-final-tests-final'), TMPDIR: join(tmpdir(), 'goodbuddy-final-tests-final'), NO_COLOR: '1' },
          stdio: ['ignore', log, log]
        })
        state.active = job
        state.childPid = child.pid
        save()
        const result = await new Promise((resolveExit, reject) => {
          child.once('error', reject)
          child.once('exit', (code, signal) => resolveExit({ code, signal }))
        })
        const entry = { job, ...result, seconds: (Date.now() - started) / 1000, log: logPath }
        if (job === 'test' && existsSync(report)) {
          const data = JSON.parse(readFileSync(report, 'utf8'))
          entry.totals = Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith('num') || key === 'success'))
          entry.failedFiles = data.testResults.filter((file) => file.status === 'failed').map((file) => ({
            file: file.name.replace(root, '').replaceAll('\\', '/'),
            tests: file.assertionResults.filter((test) => test.status === 'failed').map((test) => test.fullName)
          }))
        }
        state.results.push(entry)
      } finally {
        killTree(child?.pid)
        child = undefined
        closeSync(log)
        delete state.childPid
        delete state.active
        save()
      }
    }
    state.status = interrupted ? 'interrupted' : 'completed'
  } catch (error) {
    state.status = 'error'
    state.reason = error.message
  } finally {
    clearTimeout(deadline)
    killTree(child?.pid)
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) }
    catch (error) { state.cleanupError = error.code }
    state.endedAt = new Date().toISOString()
    save()
    rmSync(lockFile, { force: true })
  }
} else {
  throw new Error('Usage: node scripts/final-regression.mjs start [all|test|typecheck|lint] [test filters...] | status | stop')
}
