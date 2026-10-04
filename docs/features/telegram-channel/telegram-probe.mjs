/* global process, fetch, AbortSignal, console, setTimeout */
// Credentials stay in the process environment; never print raw API errors.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const listen = process.argv.includes('--listen')
const pending = process.argv.includes('--pending')
const startedAt = Math.floor(Date.now() / 1000)
const marker = '/goodbuddy_test'

async function call(method, body = {}, timeout = 15000) {
  let response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    })
  } catch (error) {
    const code = error?.cause?.code ?? error?.name
    const safeCode = /^[A-Z_a-z0-9]+$/.test(code ?? '') ? code : 'NETWORK_ERROR'
    // Raw network errors can embed the credential-bearing request URL.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`${method}: ${safeCode}`)
  }
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error(`${method}: invalid JSON (HTTP ${response.status})`)
  }
  if (!response.ok || !data.ok) {
    const code = Number.isInteger(data.error_code) ? data.error_code : response.status
    const wait = Number.isInteger(data.parameters?.retry_after)
      ? `; retry_after=${data.parameters.retry_after}` : ''
    throw new Error(`${method}: API error ${code}${wait}`)
  }
  return data.result
}

async function main() {
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Set TELEGRAM_BOT_TOKEN to a valid BotFather token.')
  }
  const bot = await call('getMe')
  console.log(JSON.stringify({ check: 'getMe', ok: true, username: bot.username }))
  const webhook = await call('getWebhookInfo')
  console.log(JSON.stringify({
    check: 'getWebhookInfo', ok: true,
    webhookConfigured: Boolean(webhook.url), pendingUpdates: webhook.pending_update_count
  }))
  if (!listen && !pending) return
  if (webhook.url) throw new Error('Webhook is configured; polling skipped. No configuration changed.')
  console.log(pending
    ? `Checking queued private ${marker} messages from the last hour.`
    : `Send ${marker} in a private chat with @${bot.username} within 45 seconds.`)
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    // Do not advance offset or change allowed_updates on a diagnostic run.
    const updates = await call('getUpdates', { timeout: pending ? 0 : 10, limit: 100 }, 15000)
    const message = updates.map((update) => update.message).reverse().find((item) =>
      item?.chat?.type === 'private' && !item.from?.is_bot &&
      item.date >= startedAt - (pending ? 3600 : 0) && item.text === marker
    )
    if (message) {
      await call('sendMessage', {
        chat_id: message.chat.id,
        text: 'GoodBuddy Telegram API test passed. This is a connectivity test, not an AI task.'
      })
      console.log(JSON.stringify({ check: 'privateMessageRoundTrip', ok: true }))
      return
    }
    if (updates.length >= 100) {
      throw new Error('Pending update batch is full; stopped without confirming existing updates.')
    }
    if (pending) break
    if (updates.length) await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  console.log(JSON.stringify({ check: 'privateMessageRoundTrip', ok: false, reason: 'no_matching_message' }))
  process.exitCode = 2
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
