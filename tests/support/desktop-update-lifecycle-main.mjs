import { app } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'

const mode = process.argv[2]
const directory = process.argv[3]
app.setPath('userData', join(directory, 'profile'))
const events = []
const { finishDesktopUpdateShutdown } = (await import(pathToFileURL(join(directory, 'install.cjs')).href)).default
let cleaned = false
app.on('before-quit', event => {
  events.push('before-quit')
  if (cleaned) return
  event.preventDefault()
  // Reproduce the application's asynchronous cleanup followed by app.exit().
  setTimeout(() => {
    events.push('cleanup-complete')
    cleaned = true
    if (mode.startsWith('update-')) {
      void finishDesktopUpdateShutdown({
        installerPath: 'isolated-installer.exe', cleanupFailed: mode === 'update-cleanup-failed',
        install: async () => {
          if (mode === 'update-spawn-failed') throw new Error('simulated spawn failure')
          events.push('installer-started')
        },
        reportFailure: () => events.push('update-failed'),
        exit: code => app.exit(code)
      })
    } else if (mode === 'exit') app.exit(0)
    else app.quit()
  }, 10)
})
app.on('will-quit', () => { events.push('will-quit') })
app.on('quit', () => {
  events.push('quit')
  writeFileSync(join(directory, 'events.json'), JSON.stringify(events))
})
void app.whenReady().then(() => app.quit())
