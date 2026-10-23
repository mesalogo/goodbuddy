import { build } from 'esbuild'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import { setTimeout, clearTimeout } from 'node:timers'

const parent = resolve('temp')
await mkdir(parent, { recursive: true })
const root = await mkdtemp(join(parent, 'continue-dsh-tasks-'))

async function runCleanup(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    timeout: 10000, killSignal: 'SIGKILL' })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit) })
  if (code !== 0) throw new Error(`Owned probe cleanup failed (${code}): ${output}`)
  if (output.trim()) console.log(output.trim())
}

async function stopOwnedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // This handle is the launcher child, never an arbitrary PID from a process search.
    await runCleanup('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(error => {
      if (child.exitCode === null && child.signalCode === null) throw error
    })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  for (let attempt = 0; attempt < 60 && child.exitCode === null && child.signalCode === null; attempt++) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error('Owned probe child exit was not confirmed')
}

async function cleanOwnedWindowsProcesses() {
  if (process.platform !== 'win32') return
  // A runtime can exit before its descendants. Match only this run's unique path,
  // then recheck the process identity before issuing a tree kill.
  await runCleanup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $ownedRoot = $env:GB_TASK_CLEANUP_ROOT
    function Get-OwnedProbeProcesses {
      Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.ProcessId -ne ${process.pid} -and
        $_.Name -in @('node.exe', 'electron.exe', 'pwsh.exe', 'powershell.exe') -and
        $_.CommandLine -and $_.CommandLine.Contains($ownedRoot)
      }
    }
    foreach ($candidate in @(Get-OwnedProbeProcesses)) {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.ProcessId)"
      if ($current -and $current.CreationDate -eq $candidate.CreationDate -and $current.CommandLine.Contains($ownedRoot)) {
        & taskkill.exe /PID $current.ProcessId /T /F
        if ($LASTEXITCODE -ne 0 -and (Get-CimInstance Win32_Process -Filter "ProcessId = $($current.ProcessId)")) {
          throw 'Owned probe process tree did not terminate'
        }
      }
    }
    if (@(Get-OwnedProbeProcesses).Count -ne 0) { throw 'Owned probe processes remain; retain temp root' }
  `], { ...process.env, GB_TASK_CLEANUP_ROOT: root })
  console.log('PROBE_OWNED_PROCESSES_CLEARED', root)
}

try {
  const entry = join(root, 'probe.mjs')
  await build({ entryPoints: [resolve('scripts/validate-continue-dsh-tasks.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href) } })
  const env = { ...process.env, GB_TASK_PROBE_ROOT: root, GB_TASK_PROBE_NODE: process.execPath,
    TEMP: root, TMP: root, TMPDIR: root, DSH_TELEMETRY_DISABLED: '1', OTEL_SDK_DISABLED: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  for (const provider of ['continue', 'dsh']) {
    const args = provider === 'continue' ? [entry, `--user-data-dir=${join(root, 'electron-profile')}`] : [entry]
    const child = spawn(provider === 'continue' ? electron : process.execPath, args, {
      env: { ...env, GB_TASK_PROBE_PROVIDER: provider }, stdio: 'inherit', detached: process.platform !== 'win32' })
    let timeout
    let watchdogCleanup
    try {
      const exited = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
      const watchdog = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          console.error('PROBE_WATCHDOG', provider, child.pid)
          watchdogCleanup = stopOwnedChild(child)
          watchdogCleanup.then(() => reject(new Error(`${provider} probe watchdog expired`)), reject)
        }, 90000)
      })
      const code = await Promise.race([exited, watchdog])
      if (watchdogCleanup || code !== 0) process.exitCode = watchdogCleanup ? 1 : code ?? 1
    } finally {
      clearTimeout(timeout)
      await watchdogCleanup
      await stopOwnedChild(child)
    }
  }
} finally {
  // Do not delete launch/fixture evidence if owned-process cleanup fails.
  await cleanOwnedWindowsProcesses().catch(error => {
    console.error('PROBE_TEMP_RETAINED', root)
    throw error
  })
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log('PROBE_TEMP_REMOVED', root)
}
