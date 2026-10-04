import { app, net } from 'electron'
import { ChannelService } from '../../../src/main/channels/channel-service'
import { TelegramChannelDriver } from '../../../src/main/channels/telegram-channel-driver'

type Update = {
  update_id: number
  message?: {
    date: number
    text?: string
    from?: { id: number; is_bot: boolean }
    chat: { id: number; type: string }
    message_thread_id?: number
    is_topic_message?: boolean
  }
}

function report(code: string): void {
  process.send?.(code)
}

async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Probe timeout')), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  let driver: TelegramChannelDriver | undefined
  let service: ChannelService | undefined
  let exitCode = 1
  try {
    const userData = process.env.GOODBUDDY_PROBE_USER_DATA
    const secret = process.env.TELEGRAM_BOT_TOKEN
    if (!userData || !secret || !process.send) throw new Error('Runner required')
    app.setPath('userData', userData)
    app.setPath('sessionData', userData)
    app.setPath('logs', userData)
    // Keep Chromium caches and diagnostics inside the disposable profile.
    app.commandLine.appendSwitch('disable-logging')
    app.commandLine.appendSwitch('disable-http-cache')
    await bounded(app.whenReady(), 15_000)

    let selected: Update | undefined = undefined
    const electronFetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const response = await net.fetch(url, init)
      if (!selected || !url.endsWith('/getUpdates') || !response.ok) return response
      const data = await response.json() as { ok?: boolean; result?: Update[] }
      if (data.ok !== true || !Array.isArray(data.result)) throw new Error('Invalid updates')
      // This is the only network adaptation. Receiving, parsing, queuing and sending
      // still run through production code; other queued commands cannot send help.
      return new Response(JSON.stringify({
        ok: true,
        result: data.result.filter((update) =>
          update.update_id === selected?.update_id &&
          update.message?.text === '/goodbuddy_test' &&
          update.message?.from?.id === selected?.message?.from?.id &&
          update.message?.chat.id === selected?.message?.chat.id)
      }), { headers: { 'content-type': 'application/json' } })
    }
    driver = new TelegramChannelDriver({ secret, allowedSenderIds: [], fetch: electronFetch })
    await bounded(driver.testConnection(), 35_000)
    report('connection')
    if (!process.argv.includes('--send-test')) {
      exitCode = 0
      return
    }

    // No offset: discovery does not acknowledge the queue or alter allowed_updates.
    const response = await net.fetch(`https://api.telegram.org/bot${secret}/getUpdates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout: 0, limit: 100 }), redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })
    const data = await response.json() as { ok?: boolean; result?: Update[] }
    if (!response.ok || data.ok !== true || !Array.isArray(data.result)) throw new Error('Discovery failed')
    const now = Math.floor(Date.now() / 1000)
    selected = data.result.filter((update) => {
      const message = update.message
      return Number.isSafeInteger(update.update_id) && update.update_id >= 0 &&
        message?.text === '/goodbuddy_test' && message.chat?.type === 'private' &&
        Number.isSafeInteger(message.from?.id) && message.from!.id > 0 &&
        message.from?.is_bot === false && message.chat.id === message.from.id &&
        message.message_thread_id === undefined && !message.is_topic_message &&
        Number.isSafeInteger(message.date) && message.date >= now - 86_400 && message.date <= now
    }).sort((a, b) => b.message!.date - a.message!.date || b.update_id - a.update_id)[0]
    if (!selected) {
      report('missing')
      return
    }
    report('selected')
    const allowedSenderIds = [String(selected.message!.from!.id)]
    driver.updateAllowedSenderIds(allowedSenderIds)
    let delivered!: () => void
    const delivery = new Promise<void>((resolve) => { delivered = resolve })
    service = new ChannelService(driver, async (message) => {
      if (message.eventId !== String(selected!.update_id) || message.text !== '/goodbuddy_test') {
        throw new Error('Unexpected event')
      }
      return {
        status: 'completed',
        output: 'GoodBuddy Telegram channel test passed using the production driver and ChannelService. No AI model or tools were used.'
      }
    }, { allowedSenderIds, maximumConcurrency: 1, onDeliverySuccess: delivered })
    await service.start()
    await bounded(delivery, 45_000)
    report('delivered')
    exitCode = 0
  } catch {
    report('failed')
  } finally {
    try {
      await bounded(Promise.all([service?.stop(), driver?.stop()]), 5_000)
    } catch {
      report('shutdown')
      exitCode = 1
    }
    process.exitCode = exitCode
    app.quit()
    setTimeout(() => app.exit(exitCode), 1_000).unref()
  }
}

process.on('uncaughtException', () => { report('failed'); app.exit(1) })
process.on('unhandledRejection', () => { report('failed'); app.exit(1) })
void main()
