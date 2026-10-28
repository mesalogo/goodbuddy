import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Browser } from 'playwright'
import type { BrowserWebContents } from './electron-browser-session'
import { PlaywrightBrowserDriver } from './playwright-browser-driver'

// Electron's native views remain the rendering and input surface. Playwright
// attaches over the supported CDP connection and never creates a second page.
export function configureNativeBrowserAutomation(): void {
  if (!app.commandLine.hasSwitch('remote-debugging-port')) {
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
    app.commandLine.appendSwitch('remote-debugging-port', '0')
  }
}

let connection: Promise<Browser> | undefined
let users = 0
async function connect(): Promise<Browser> {
  const { chromium } = await import('playwright')
  const configuredPort = app.commandLine.getSwitchValue('remote-debugging-port')
  const port = configuredPort && configuredPort !== '0' ? configuredPort
    : (await readFile(join(app.getPath('userData'), 'DevToolsActivePort'), 'utf8')).split('\n')[0]?.trim()
  if (!port || !/^\d+$/u.test(port)) throw new Error('浏览器自动化连接尚未就绪，请重试')
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 15_000 })
}

export async function attachNativeBrowser(
  contents: BrowserWebContents,
  nativeDownloads: () => unknown[] = () => []
): Promise<PlaywrightBrowserDriver> {
  const targetId = contents.getOrCreateDevToolsTargetId?.()
  if (!targetId) throw new Error('当前浏览器视图不支持 Playwright 连接')
  users += 1
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    users -= 1
    if (!users) {
      const previous = connection
      connection = undefined
      void previous?.then((browser) => browser.close()).catch(() => undefined)
    }
  }
  try {
    const browser = await (connection ??= connect())
    const deadline = Date.now() + 15_000
    while (!contents.isDestroyed() && Date.now() < deadline) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const session = await context.newCDPSession(page).catch(() => undefined)
          if (!session) continue
          const info = await session.send('Target.getTargetInfo').catch(() => undefined)
          if (info?.targetInfo.targetId === targetId) {
            return new PlaywrightBrowserDriver(page, session, {
              downloads: nativeDownloads,
              dispose: () => { void session.detach().catch(() => undefined); release() }
            })
          }
          await session.detach()
        }
      }
      await delay(25)
    }
    throw new Error('浏览器页面在建立自动化连接前关闭或未就绪')
  } catch (error) { release(); throw error }
}
