import { app, session } from 'electron'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer as createProxy } from 'node:http'
import { createServer as createFixture } from 'node:https'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { TelegramChannelDriver } from '../../src/main/channels/telegram-channel-driver'

const directory = process.env.GB_PROXY_DIRECTORY!
const trusted = process.env.GB_PROXY_TRUSTED === 'true'
assert(directory)
app.setPath('userData', join(directory, trusted ? 'trusted-profile' : 'untrusted-profile'))
app.setPath('sessionData', join(directory, trusted ? 'trusted-session' : 'untrusted-session'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1')

void app.whenReady().then(async () => {
  const secret = '123456:local-proxy-test-placeholder'
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  const tunnels: string[] = []
  const blockedConnects: string[] = []
  const rejected: string[] = []
  const sockets = new Set<Socket>()
  let pollStarted!: () => void
  const polling = new Promise<void>((resolve) => { pollStarted = resolve })
  let pollClosed!: () => void
  const closed = new Promise<void>((resolve) => { pollClosed = resolve })
  const fixture = createFixture({
    key: await readFile(join(directory, 'server.key')),
    cert: await readFile(join(directory, 'server.pem'))
  }, (request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.host, 'api.telegram.org')
      assert(request.url && request.url.startsWith(`/bot${secret}/`))
      const method = request.url.split('/').at(-1)!
      let payload = ''
      for await (const chunk of request) payload += chunk
      const body = JSON.parse(payload) as Record<string, unknown>
      calls.push({ method, body })
      if (method === 'getUpdates') {
        assert.equal(body.timeout, 30)
        assert.deepEqual(body.allowed_updates, ['message'])
        response.once('close', pollClosed)
        pollStarted()
        return // Hold the HTTPS response until driver.stop() aborts the real request.
      }
      const result = method === 'getMe' ? { id: 123456, is_bot: true, username: 'fixture_bot' }
        : method === 'getWebhookInfo' ? { url: '' }
          : method === 'sendMessage' ? { message_id: 1 } : undefined
      assert(result, `Unexpected method: ${method}`)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, result }))
    })().catch((error: unknown) => { console.error(error); app.exit(1) })
  })
  const proxy = createProxy((_request, response) => { response.writeHead(405).end() })
  for (const server of [fixture, proxy]) {
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
  }
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const fixtureAddress = fixture.address()
  assert(fixtureAddress && typeof fixtureAddress !== 'string')
  proxy.on('connect', (request, downstream, head) => {
    if (request.url !== 'api.telegram.org:443') {
      blockedConnects.push(request.url ?? 'missing authority')
      downstream.destroy()
      return
    }
    tunnels.push(request.url)
    // Never resolve or connect to the requested public hostname.
    const upstream = connect(fixtureAddress.port, '127.0.0.1', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      downstream.pipe(upstream).pipe(downstream)
    })
    sockets.add(upstream)
    upstream.once('close', () => { sockets.delete(upstream); downstream.destroy() })
    downstream.once('close', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    downstream.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyAddress = proxy.address()
  assert(proxyAddress && typeof proxyAddress !== 'string')
  await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxyAddress.port}` })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    const allowed = url.origin === 'https://api.telegram.org' && url.pathname.startsWith(`/bot${secret}/`)
    if (!allowed) rejected.push('unexpected Chromium request')
    callback({ cancel: !allowed })
  })
  const statuses: string[] = []
  // No injected fetch, net.fetch replacement, certificate callback or TLS bypass.
  const driver = new TelegramChannelDriver({ secret, allowedSenderIds: ['7'],
    onStatus: (status) => statuses.push(status.state) })
  try {
    assert.equal(await session.defaultSession.resolveProxy('https://api.telegram.org'), `PROXY 127.0.0.1:${proxyAddress.port}`)
    if (!trusted) {
      await assert.rejects(driver.testConnection(), /network request failed/)
      assert(tunnels.length > 0)
      assert.deepEqual(calls, [], 'Untrusted TLS must fail before an HTTPS request reaches the fixture')
      assert.deepEqual(rejected, [])
      console.log(JSON.stringify({ untrustedTlsRejected: true, blockedConnects }))
    } else {
      assert.deepEqual(await driver.testConnection(), { botId: '123456', botUsername: 'fixture_bot' })
      assert.deepEqual(calls.map((call) => call.method), ['getMe', 'getWebhookInfo'])
      await driver.start(() => { throw new Error('Held poll must not dispatch inbound messages') })
      await polling
      await driver.send({ channel: 'telegram', eventId: '1', conversationId: '123456:7',
        recipientId: '7', status: 'completed', output: 'reply through local CONNECT' }, new AbortController().signal)
      assert.deepEqual(calls.at(-1), { method: 'sendMessage', body: { chat_id: '7', text: 'reply through local CONNECT' } })
      await driver.stop()
      await closed
      assert.equal(statuses.at(-1), 'stopped')
      assert.deepEqual(calls.map((call) => call.method), ['getMe', 'getWebhookInfo', 'getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage'])
      assert(tunnels.length >= 2, 'Sending while polling requires another CONNECT tunnel')
      assert.deepEqual(rejected, [])
      await assert.rejects(driver.send({ channel: 'telegram', eventId: '2', conversationId: '123456:7',
        recipientId: '7', status: 'completed', output: 'after stop' }, new AbortController().signal), { name: 'AbortError' })
      assert.equal(calls.length, 6)
      console.log(JSON.stringify({ telegramProxy: 'passed', defaultDriverFetch: true, trustedTls: true,
        connectTunnels: tunnels.length, methods: calls.map((call) => call.method), pollAbortedAtServer: true,
        sendAfterStopRejected: true, blockedConnects, externalNetworkCalls: 0 }))
    }
  } finally {
    await driver.stop()
    await session.defaultSession.closeAllConnections()
    for (const socket of sockets) socket.destroy()
    await Promise.all([fixture, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  }
  app.exit(0)
}).catch((error: unknown) => { console.error(error); app.exit(1) })
