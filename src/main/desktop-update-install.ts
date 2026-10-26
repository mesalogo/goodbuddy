import { spawn } from 'node:child_process'

/** NSIS recovers the previous install scope/path from its own registration. */
export const desktopUpdateInstallArguments = ['/S', '--updated', '--force-run'] as const

export async function launchDesktopUpdateInstaller(installerPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(installerPath, [...desktopUpdateInstallArguments], {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/** Called explicitly by the cleanup owner, since app.exit skips will-quit. */
export async function finishDesktopUpdateShutdown(input: {
  installerPath?: string
  cleanupFailed: boolean
  install: (path: string) => Promise<void>
  reportFailure: (message: string) => void
  exit: (code: number) => void
}): Promise<void> {
  let failed = input.cleanupFailed
  try {
    if (input.installerPath) {
      if (failed) input.reportFailure('退出清理未成功，更新安装没有启动。请重新打开 GoodBuddy 后重试。')
      else await input.install(input.installerPath)
    }
  } catch (error) {
    failed = true
    input.reportFailure(`无法启动更新安装器，原版本仍保留：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    input.exit(failed ? 1 : 0)
  }
}
