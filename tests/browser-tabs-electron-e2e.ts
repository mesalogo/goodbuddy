import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { app, BrowserWindow, webContents } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { KnowledgeService } from '../src/main/knowledge/knowledge-service'
import { KnowledgeMcpGateway } from '../src/main/agent/knowledge-mcp-gateway'
import { BrowserService } from '../src/main/browser/browser-service'
import { BrowserModelTools } from '../src/main/browser/browser-model-tools'
import type { BrowserLiveState } from '../src/shared/contracts'

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
    if (request.url === '/popups') {
      response.end(page('Popup opener', '<a target="_blank" href="/popup-target">Open target</a><button onclick="window.child=window.open(\'/popup-script\')">Open script</button><button onclick="window.child=window.open();child.location=\'/popup-blank\'">Open blank</button>'))
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
    const beforeReservations = webContents.getAllWebContents().length
    const states: BrowserLiveState[] = []
    const removeStateListener = browser.onState((state) => states.push(state))
    const unused = Array.from({ length: 4 }, (_, index) =>
      browser.reserveRequestTab(`unused-request-${index}`, `request-${index}`, window.webContents.id)
    )
    assert.equal(browser.getSessionCount(), 0)
    assert.equal(browser.getTabCount(), 0)
    assert.equal(webContents.getAllWebContents().length, beforeReservations)
    assert.equal(states.length, 0)
    for (const lease of unused) {
      lease.release()
      assert.equal(browser.getOwnerWindowId(lease.conversationId), undefined)
    }
    console.log('Four unused request reservations created no Electron sessions, WebContents, or UI events')

    const reserved = browser.reserveRequestTab(conversationId, 'reserved-request', window.webContents.id)
    await gateway.start()
    token = gateway.grant('reserved-request', [], controller.signal, 'none', undefined, conversationId, reserved.tabId, reserved)
    assert(token)
    client = new Client({ name: 'reserved-browser-electron-e2e', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.getEndpoint()!), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    }))
    assert.equal(browser.getSessionCount(), 0)
    const reservedNavigation = await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/mcp` } })
    assert.notEqual(reservedNavigation.isError, true)
    assert.equal(browser.getSessionCount(), 1)
    assert.equal(states[0]?.status, 'creating')
    assert.equal(states[0]?.tabId, reserved.tabId)
    assert.equal(states[0]?.workbarInstanceId, reserved.tabId)
    assert(states.every((state) => state.workbarInstanceId === reserved.tabId && !('frameDataUrl' in state)))
    const restoredRequestTab = await browser.createTab(conversationId, window.webContents.id, controller.signal, reserved.tabId)
    assert.equal(restoredRequestTab.tabId, reserved.tabId)
    assert.equal(restoredRequestTab.workbarInstanceId, reserved.tabId)
    assert.equal(browser.getTabCount(), 1)
    assert.match(JSON.stringify(await client.callTool({ name: 'browser_snapshot', arguments: {} })), /MCP target/u)
    await browser.closeTab(conversationId, reserved.tabId, window.webContents.id)
    assert.equal(reserved.signal.aborted, true)
    assert.equal(controller.signal.aborted, false)
    assert.equal(browser.getSessionCount(), 0)
    const closedReservationSnapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    assert.equal(closedReservationSnapshot.isError, true)
    assert.match(JSON.stringify(closedReservationSnapshot), /标签页已关闭.*browser_navigate/u)
    assert((await client.listTools()).tools.some((tool) => tool.name === 'browser_navigate'))
    assert.equal(browser.getSessionCount(), 0)
    gateway.revoke(token)
    token = undefined
    await client.close()
    client = undefined
    await browser.closeTab(conversationId, reserved.tabId, window.webContents.id)
    await browser.closeTab(conversationId, reserved.tabId, window.webContents.id)
    assert.equal(browser.getSessionCount(), 0)
    removeStateListener()
    console.log('MCP reservation materialized the exact tab/workbar identity; leased close preserved the MCP session without recreating a page')

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

    const closedContents = webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}/mcp`)
    assert(closedContents)
    const siblingBeforeClose = browser.listTabs(conversationId, window.webContents.id).find((tab) => tab.tabId === second.tabId)
    assert(siblingBeforeClose)
    const destroyed = once(closedContents, 'destroyed', { signal: AbortSignal.timeout(5_000) })
    await browser.closeTab(conversationId, first.tabId, window.webContents.id)
    await destroyed
    assert.equal(closedContents.isDestroyed(), true)
    assert.equal(usage.signal.aborted, true)
    assert.equal(controller.signal.aborted, false)
    assert.equal(browser.getTabCount(conversationId), 1)
    assert(gateway.getAvailableToolNames(token).includes('browser_navigate'))
    assert((await client.listTools()).tools.some((tool) => tool.name === 'browser_snapshot'))
    const closedSnapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    assert.equal(closedSnapshot.isError, true)
    assert.match(JSON.stringify(closedSnapshot), /标签页已关闭.*browser_navigate/u)
    await assert.rejects(
      browser.snapshot(conversationId, controller.signal, first.tabId, window.webContents.id),
      /当前浏览器标签页尚未导航/u
    )
    assert.equal(browser.getTabCount(conversationId), 1)
    const replacementNavigation = await client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/mcp` } })
    assert.notEqual(replacementNavigation.isError, true)
    const replacement = browser.listTabs(conversationId, window.webContents.id).find((tab) => tab.tabId !== second.tabId)
    assert(replacement)
    assert.notEqual(replacement.tabId, first.tabId)
    assert.equal(browser.getTabCount(conversationId), 2)
    const replacementSnapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    assert.notEqual(replacementSnapshot.isError, true)
    assert.match(JSON.stringify(replacementSnapshot), /MCP target/u)
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, replacement.tabId, window.webContents.id)), /MCP target/u)
    // Closing the primary promotes its sibling without changing that sibling's page.
    assert.deepEqual(browser.listTabs(conversationId, window.webContents.id).find((tab) => tab.tabId === second.tabId), {
      ...siblingBeforeClose,
      primary: true
    })
    assert.match(JSON.stringify(await browser.snapshot(conversationId, controller.signal, second.tabId, window.webContents.id)), /shared-browser-tab=visible/u)
    assert.match(JSON.stringify(await browser.snapshot(otherConversationId, controller.signal, other.tabId, window.webContents.id)), /Second tab/u)
    assert.equal(browser.getVisibleTabId(otherConversationId, window.webContents.id), other.tabId)
    console.log('Leased Electron tab destroyed; same MCP capability reported the closed target and explicitly navigated a dedicated replacement, leaving siblings untouched')
    await browser.closeTab(otherConversationId, other.tabId, window.webContents.id)
    assert.equal(browser.getTabCount(otherConversationId), 0)
    assert.equal(browser.getTabCount(conversationId), 2)
    gateway.revoke(token)
    token = undefined
    await browser.closeTab(conversationId, first.tabId, window.webContents.id)
    assert.equal(browser.getTabCount(conversationId), 2)
    await browser.closeTab(conversationId, replacement.tabId, window.webContents.id)
    assert.equal(browser.getTabCount(conversationId), 1)
    await browser.closeTab(conversationId, second.tabId, window.webContents.id)
    assert.equal(browser.getTabCount(conversationId), 0)
    console.log('Real Electron browser-tab and MCP E2E passed')

    await client.close()
    client = undefined
    const opener = await browser.createTab(conversationId, window.webContents.id)
    await browser.navigate(conversationId, `${origin}/popups`, controller.signal, opener.tabId)
    browser.setViewport(conversationId, bounds, opener.tabId, 'popup-viewport', window.webContents.id)
    window.show()
    const openerContents = webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}/popups`)
    assert(openerContents)
    openerContents.focus()
    await openerContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const popupUsage = browser.acquireTabUsage(conversationId, opener.tabId, 'popup-e2e')
    token = gateway.grant('popup-e2e', [], controller.signal, 'none', undefined, conversationId, opener.tabId, popupUsage)
    assert(token)
    client = new Client({ name: 'popup-e2e', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.getEndpoint()!), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    }))
    const snapshot = await browser.snapshot(conversationId, controller.signal, opener.tabId)
    const link = snapshot.nodes.find((node) => node.name === 'Open target')
    assert(link)
    const clickResult = await client.callTool({ name: 'browser_click', arguments: { ref: link.ref } })
    assert.notEqual(clickResult.isError, true, JSON.stringify(clickResult))
    assert.match(JSON.stringify(clickResult), /openedTabId/u)
    const popup = browser.listTabs(conversationId).find((tab) => tab.tabId !== opener.tabId)
    assert(popup)
    assert.equal(popup.workbarInstanceId, popup.tabId)
    const popupSnapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    assert.notEqual(popupSnapshot.isError, true, JSON.stringify(popupSnapshot))
    assert.match(JSON.stringify(popupSnapshot), /popup-target/u)
    assert.equal(browser.listTabs(conversationId).find((tab) => tab.tabId === opener.tabId)?.url, `${origin}/popups`)
    const popupContents = webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}/popup-target`)
    assert(popupContents)
    assert.equal(await popupContents.executeJavaScript('typeof process'), 'undefined')
    const popupDestroyed = once(popupContents, 'destroyed', { signal: AbortSignal.timeout(5_000) })
    await popupContents.executeJavaScript('window.close()').catch(() => undefined)
    await popupDestroyed
    assert.equal(browser.getTabCount(conversationId), 1)
    assert.equal((await client.callTool({ name: 'browser_snapshot', arguments: {} })).isError, true)
    for (const path of ['/popup-script', '/popup-blank']) {
      const navigation = new Promise<void>((resolve) => {
        const remove = browser.onState((state) => {
          if (state.url === `${origin}${path}`) { remove(); resolve() }
        })
      })
      await openerContents.executeJavaScript(path === '/popup-blank'
        ? `window.child=window.open();child.location='${path}';void 0`
        : `window.child=window.open('${path}');void 0`)
      await navigation
      assert.equal(await openerContents.executeJavaScript('child !== null && !child.closed'), true)
      const child = webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}${path}`)
      assert(child)
      const destroyedChild = once(child, 'destroyed', { signal: AbortSignal.timeout(5_000) })
      await openerContents.executeJavaScript('child.close()')
      await destroyedChild
      assert.equal(browser.getTabCount(conversationId), 1)
    }
    assert.equal(await openerContents.executeJavaScript('window.open("file:///unsupported") === null'), true)
    assert.equal(browser.getTabCount(conversationId), 1)
    const directTools = new BrowserModelTools({ service: browser, conversationId, browserTabId: opener.tabId, recoverClosedTab: true })
    const directSnapshot = await browser.snapshot(conversationId, controller.signal, opener.tabId)
    const button = directSnapshot.nodes.find((node) => node.name === 'Open script' && node.role === 'button')
    assert(button)
    assert.match(JSON.stringify(await directTools.callTool('browser_click', { ref: button.ref }, controller.signal)), /openedTabId/u)
    assert.match(JSON.stringify(await directTools.callTool('browser_snapshot', {}, controller.signal)), /popup-script/u)
    const childContents = webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}/popup-script`)
    assert(childContents)
    assert.equal(childContents.session, openerContents.session)
    await browser.closeTab(conversationId, opener.tabId)
    assert.equal(childContents.isDestroyed(), false)
    assert.match(JSON.stringify(await directTools.callTool('browser_snapshot', {}, controller.signal)), /popup-script/u)
    await browser.releaseConversation(conversationId)
    console.log('Native target=_blank, window.open(url), blank-then-location, script close, opener close, shared partition, URL denial and direct/MCP popup binding passed')
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
