import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { app, BrowserWindow, webContents } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { KnowledgeService } from '../src/main/knowledge/knowledge-service'
import { KnowledgeMcpGateway } from '../src/main/agent/knowledge-mcp-gateway'
import { BrowserService } from '../src/main/browser/browser-service'

const conversationId = 'browser-tabs-electron-e2e'
const otherConversationId = 'browser-tabs-electron-e2e-other'
const firstWorkbarId = '00000000-0000-4000-8000-000000000901'
const secondWorkbarId = '00000000-0000-4000-8000-000000000902'

function page(title: string, body = ''): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`
}

async function main(): Promise<void> {
  await app.whenReady()
  const target = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/set-cookie') {
      response.setHeader('set-cookie', 'shared-browser-tab=visible; Path=/; SameSite=Lax')
      response.end(page('Cookie set'))
      return
    }
    if (request.url === '/cookie') {
      response.end(page('Cookie page', '<p id="cookie"></p><script>document.querySelector("#cookie").textContent = document.cookie</script>'))
      return
    }
    response.end(page(request.url === '/mcp' ? 'MCP target' : request.url === '/second' ? 'Second tab' : 'First tab'))
  })
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', resolve)
  })
  const address = target.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const window = new BrowserWindow({ show: false, width: 900, height: 700 })
  const browser = new BrowserService({ parentWindow: window })
  const gateway = new KnowledgeMcpGateway(
    {
      database: { listKnowledgeBases: () => [] }
    } as unknown as KnowledgeService,
    { browserService: browser }
  )
  const controller = new AbortController()
  let client: Client | undefined
  let token: string | undefined
  try {
    await browser.navigate(conversationId, `${origin}/first`, controller.signal, undefined, window.webContents.id)
    const [unownedPrimary] = browser.listTabs(conversationId, window.webContents.id)
    assert(unownedPrimary)
    const first = await browser.createTab(
      conversationId,
      window.webContents.id,
      controller.signal,
      firstWorkbarId
    )
    assert.notEqual(first.tabId, unownedPrimary.tabId)
    assert.equal(first.url, undefined)
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, unownedPrimary.tabId, window.webContents.id)), /First tab/u)
    await browser.closeTab(conversationId, unownedPrimary.tabId, window.webContents.id)
    console.log('New workbar ID did not adopt the existing navigated primary')
    await browser.navigate(conversationId, `${origin}/first`, controller.signal, first.tabId, window.webContents.id)
    const existingContents = new Set(webContents.getAllWebContents().map((contents) => contents.id))
    const second = await browser.createTab(
      conversationId,
      window.webContents.id,
      controller.signal,
      secondWorkbarId
    )
    assert.notEqual(first.tabId, second.tabId)
    assert.equal(second.url, undefined)
    assert.equal(second.canGoBack, false)
    const freshContents = webContents.getAllWebContents().filter((contents) => !existingContents.has(contents.id))
    assert.equal(freshContents.length, 1)
    assert.equal(freshContents[0]!.getURL(), 'about:blank')
    assert.equal(freshContents[0]!.getTitle(), 'about:blank')
    assert.equal(freshContents[0]!.navigationHistory.canGoBack(), false)
    console.log('Fresh WebContents verified: about:blank, blank-page title, no history')

    await browser.navigate(conversationId, `${origin}/second`, controller.signal, second.tabId, window.webContents.id)
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, first.tabId, window.webContents.id)), /First tab/u)
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, second.tabId, window.webContents.id)), /Second tab/u)

    await browser.navigate(conversationId, `${origin}/set-cookie`, controller.signal, first.tabId, window.webContents.id)
    await browser.navigate(conversationId, `${origin}/cookie`, controller.signal, second.tabId, window.webContents.id)
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, second.tabId, window.webContents.id)), /shared-browser-tab=visible/u)
    console.log('Independent pages and shared conversation cookies verified')

    await gateway.start()
    const usage = browser.acquireTabUsage(conversationId, first.tabId, 'electron-e2e', window.webContents.id)
    token = gateway.grant('electron-e2e', [], controller.signal, 'none', undefined, conversationId, first.tabId, usage)
    assert(token)
    client = new Client({ name: 'browser-tabs-electron-e2e', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(gateway.getEndpoint()!), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    )
    const other = await browser.createTab(otherConversationId, window.webContents.id, controller.signal)
    assert.notEqual(other.tabId, first.tabId)
    await browser.navigate(otherConversationId, `${origin}/second`, controller.signal, other.tabId, window.webContents.id)
    assert.match(JSON.stringify(await browser.snapshot(otherConversationId, controller.signal, other.tabId, window.webContents.id)), /Second tab/u)
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, first.tabId, window.webContents.id)), /Cookie set/u)

    await assert.rejects(
      browser.navigate(otherConversationId, `${origin}/mcp`, controller.signal, first.tabId, window.webContents.id),
      /不属于当前对话/u
    )
    await assert.rejects(
      browser.navigate(conversationId, `${origin}/mcp`, controller.signal, other.tabId, window.webContents.id),
      /不属于当前对话/u
    )

    const bounds = { x: 0, y: 0, width: 800, height: 600 }
    assert.equal(browser.setViewport(conversationId, bounds, first.tabId, 'first-viewport', window.webContents.id), true)
    assert.equal(browser.getVisibleTabId(conversationId, window.webContents.id), first.tabId)
    assert.equal(browser.setViewport(otherConversationId, bounds, other.tabId, 'other-viewport', window.webContents.id), true)
    assert.equal(browser.getVisibleTabId(otherConversationId, window.webContents.id), other.tabId)
    assert.equal(browser.getVisibleTabId(conversationId, window.webContents.id), undefined)

    await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/mcp` } })
    const mcpSnapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    assert.match(JSON.stringify(mcpSnapshot), /MCP target/u)
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, first.tabId, window.webContents.id)), /MCP target/u)
    assert.match(JSON.stringify(await browser.snapshot(otherConversationId, controller.signal, other.tabId, window.webContents.id)), /Second tab/u)
    assert.equal(browser.getVisibleTabId(otherConversationId, window.webContents.id), other.tabId)
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, second.tabId, window.webContents.id)), /shared-browser-tab=visible/u)

    await assert.rejects(
      browser.closeTab(conversationId, first.tabId, window.webContents.id),
      /正在被.*请求使用/u
    )
    await browser.closeTab(otherConversationId, other.tabId, window.webContents.id)
    assert.equal(browser.getTabCount(otherConversationId), 0)
    assert.equal(browser.getTabCount(conversationId), 2)
    gateway.revoke(token)
    token = undefined
    await browser.closeTab(conversationId, first.tabId, window.webContents.id)
    assert.equal(browser.getTabCount(conversationId), 1)
    await browser.closeTab(conversationId, second.tabId, window.webContents.id)
    assert.equal(browser.getTabCount(conversationId), 0)
    console.log('Real Electron browser-tab and MCP E2E passed')
  } finally {
    if (token) gateway.revoke(token)
    await client?.close().catch(() => undefined)
    controller.abort()
    await gateway.dispose().catch(() => undefined)
    await browser.dispose().catch(() => undefined)
    if (!window.isDestroyed()) window.destroy()
    await new Promise<void>((resolve) => target.close(() => resolve()))
    app.quit()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
