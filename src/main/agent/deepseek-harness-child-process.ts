import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

type HarnessChildProcessModule = Pick<
  typeof childProcess,
  'execFileSync' | 'spawn' | 'spawnSync'
>

type SyncBuiltinExports = () => void

function withHiddenWindow(args: unknown[]): unknown[] {
  const next = [...args]
  const optionsIndex =
    Array.isArray(next[1]) ||
    (next[1] === undefined && next.length >= 3)
      ? 2
      : 1
  const options = next[optionsIndex]
  next[optionsIndex] = {
    ...(options && typeof options === 'object' ? options : {}),
    windowsHide: true
  }
  return next
}

/**
 * DeepSeek Harness 0.1.0-rc.6 omits `windowsHide` when its local subprocess
 * service starts the ACL runner and PowerShell. In an Electron GUI process
 * that can briefly create a visible console window. Keep this override scoped
 * to the isolated Harness UtilityProcess and synchronize the built-in ESM
 * bindings already captured by the bundled Harness modules.
 */
export function installHarnessChildProcessWindowGuard(
  platform: NodeJS.Platform = process.platform,
  target: HarnessChildProcessModule = childProcess,
  syncExports: SyncBuiltinExports = syncBuiltinESMExports
): () => void {
  if (platform !== 'win32') {
    return () => undefined
  }

  const originals = {
    execFileSync: target.execFileSync,
    spawn: target.spawn,
    spawnSync: target.spawnSync
  }
  const guardedExecFileSync = ((...args: unknown[]) =>
    Reflect.apply(
      originals.execFileSync,
      target,
      withHiddenWindow(args)
    )) as typeof target.execFileSync
  const guardedSpawn = ((...args: unknown[]) =>
    Reflect.apply(
      originals.spawn,
      target,
      withHiddenWindow(args)
    )) as typeof target.spawn
  const guardedSpawnSync = ((...args: unknown[]) =>
    Reflect.apply(
      originals.spawnSync,
      target,
      withHiddenWindow(args)
    )) as typeof target.spawnSync

  target.execFileSync = guardedExecFileSync
  target.spawn = guardedSpawn
  target.spawnSync = guardedSpawnSync
  syncExports()

  let restored = false
  return () => {
    if (restored) {
      return
    }
    restored = true
    target.execFileSync = originals.execFileSync
    target.spawn = originals.spawn
    target.spawnSync = originals.spawnSync
    syncExports()
  }
}
