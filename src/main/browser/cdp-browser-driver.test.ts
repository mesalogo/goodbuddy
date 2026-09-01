import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CdpBrowserDriver } from './cdp-browser-driver'
import type {
  BrowserDebugger,
  BrowserWebContents
} from './electron-browser-session'

function createHarness(
  command: (
    method: string,
    parameters?: Record<string, unknown>
  ) => Promise<unknown>
) {
  const contentEvents = new EventEmitter()
  const debuggerEvents = new EventEmitter()
  let currentUrl = 'https://example.com/page'
  const sendCommand = vi.fn(command)
  const browserDebugger: BrowserDebugger = {
    attach: vi.fn(),
    detach: vi.fn(),
    isAttached: vi.fn(() => true),
    sendCommand,
    on: (event, listener) =>
      debuggerEvents.on(
        event,
        listener as (...argumentsValue: unknown[]) => void
      ),
    off: (event, listener) =>
      debuggerEvents.off(
        event,
        listener as (...argumentsValue: unknown[]) => void
      )
  }
  const webContents: BrowserWebContents = {
    debugger: browserDebugger,
    on: (event, listener) =>
      contentEvents.on(
        event,
        listener as (...argumentsValue: unknown[]) => void
      ),
    off: (event, listener) =>
      contentEvents.off(
        event,
        listener as (...argumentsValue: unknown[]) => void
      ),
    setWindowOpenHandler: vi.fn(),
    getURL: vi.fn(() => currentUrl),
    stop: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false)
  }
  return {
    browserDebugger,
    contentEvents,
    debuggerEvents,
    sendCommand,
    webContents,
    setUrl(url: string) {
      currentUrl = url
    }
  }
}

function standardCommand(
  method: string,
  parameters?: Record<string, unknown>
): Promise<unknown> {
  if (method === 'Accessibility.getFullAXTree') {
    return Promise.resolve({
      nodes: [
        {
          nodeId: 'root',
          backendDOMNodeId: 10,
          role: { value: 'RootWebArea' },
          name: { value: 'Example' }
        },
        {
          nodeId: 'button',
          parentId: 'root',
          backendDOMNodeId: 11,
          role: { value: 'button' },
          name: { value: 'Submit' }
        },
        {
          nodeId: 'input',
          parentId: 'root',
          backendDOMNodeId: 12,
          role: { value: 'textbox' },
          name: { value: 'Email' },
          value: { value: 'typed-secret@example.com' },
          properties: [{ name: 'editable', value: { value: true } }]
        },
        {
          nodeId: 'password',
          parentId: 'root',
          backendDOMNodeId: 13,
          role: { value: 'password' },
          name: { value: 'Password' },
          value: { value: 'secret' }
        }
      ]
    })
  }
  if (method === 'Runtime.evaluate') {
    return Promise.resolve(
      parameters?.expression === 'document.readyState'
        ? { result: { value: 'complete' } }
        : {
            result: {
              value: {
                title: 'Example',
                url: 'https://example.com/page'
              }
            }
          }
    )
  }
  if (method === 'DOM.describeNode') {
    const backendNodeId = parameters?.backendNodeId
    return Promise.resolve({
      node: {
        backendNodeId,
        nodeName:
          backendNodeId === 12
            ? 'INPUT'
            : backendNodeId === 13
              ? 'INPUT'
              : 'BUTTON',
        attributes:
          backendNodeId === 12
            ? ['type', 'text']
            : backendNodeId === 13
              ? ['type', 'password']
              : []
      }
    })
  }
  if (method === 'DOM.getBoxModel') {
    return Promise.resolve({
      model: { content: [10, 20, 110, 20, 110, 60, 10, 60] }
    })
  }
  if (method === 'Page.getLayoutMetrics') {
    return Promise.resolve({
      cssVisualViewport: { clientWidth: 800, clientHeight: 600 }
    })
  }
  if (method === 'Page.getNavigationHistory') {
    return Promise.resolve({
      currentIndex: 1,
      entries: [
        { id: 4, url: 'https://previous.example/' },
        { id: 5, url: 'https://example.com/page' }
      ]
    })
  }
  if (method === 'Page.captureScreenshot') {
    return Promise.resolve({
      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
    })
  }
  return Promise.resolve({})
}

function selectCommand(
  selection: { selected: boolean; value: string }
): (
  method: string,
  parameters?: Record<string, unknown>
) => Promise<unknown> {
  return async (method, parameters) => {
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          {
            nodeId: 'root',
            backendDOMNodeId: 20,
            role: { value: 'RootWebArea' },
            name: { value: 'Example' }
          },
          {
            nodeId: 'select',
            parentId: 'root',
            backendDOMNodeId: 21,
            role: { value: 'combobox' },
            name: { value: 'Region' }
          }
        ]
      }
    }
    if (method === 'DOM.describeNode') {
      return {
        node: {
          backendNodeId: parameters?.backendNodeId,
          nodeName: 'SELECT',
          attributes: []
        }
      }
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: 'select-object' } }
    }
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: selection } }
    }
    return standardCommand(method, parameters)
  }
}

describe('CdpBrowserDriver', () => {
  it('waits for the requested main-frame commit instead of incumbent about:blank readiness', async () => {
    let readinessChecks = 0
    const harness = createHarness(async (method, parameters) => {
      if (method === 'Page.navigate') {
        return { frameId: 'main', loaderId: 'loader-1' }
      }
      if (
        method === 'Runtime.evaluate' &&
        parameters?.expression === 'document.readyState'
      ) {
        readinessChecks += 1
        return { result: { value: 'complete' } }
      }
      return standardCommand(method, parameters)
    })
    harness.setUrl('about:blank')
    const driver = new CdpBrowserDriver(harness.webContents)
    const navigation = driver.navigate(
      'https://example.com/page',
      new AbortController().signal
    )

    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenCalledWith(
        'Page.navigate',
        { url: 'https://example.com/page' }
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readinessChecks).toBe(0)

    harness.contentEvents.emit(
      'did-navigate-in-page',
      {},
      'https://example.com/frame',
      false
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(readinessChecks).toBe(0)

    harness.setUrl('https://example.com/page')
    harness.contentEvents.emit(
      'did-navigate',
      {},
      'https://example.com/page'
    )
    await expect(navigation).resolves.toEqual({
      url: 'https://example.com/page'
    })
    expect(readinessChecks).toBe(1)
    driver.dispose()
  })

  it('fails when the requested main frame never commits', async () => {
    const harness = createHarness(async (method, parameters) =>
      method === 'Page.navigate'
        ? { frameId: 'main', loaderId: 'loader-1' }
        : standardCommand(method, parameters)
    )
    harness.setUrl('about:blank')
    const driver = new CdpBrowserDriver(harness.webContents, {
      timeoutMs: 30
    })

    await expect(
      driver.navigate(
        'https://example.com/page',
        new AbortController().signal
      )
    ).rejects.toThrow('未在安全期限内提交')
    driver.dispose()
  })

  it('surfaces a main-frame load failure before reporting ready', async () => {
    const harness = createHarness(async (method, parameters) =>
      method === 'Page.navigate'
        ? { frameId: 'main', loaderId: 'loader-1' }
        : standardCommand(method, parameters)
    )
    const driver = new CdpBrowserDriver(harness.webContents)
    const navigation = driver.navigate(
      'https://example.com/page',
      new AbortController().signal
    )
    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenCalledWith(
        'Page.navigate',
        { url: 'https://example.com/page' }
      )
    )
    harness.contentEvents.emit(
      'did-fail-load',
      {},
      -105,
      'NAME_NOT_RESOLVED',
      'https://example.com/page',
      true
    )

    await expect(navigation).rejects.toThrow('NAME_NOT_RESOLVED')
    driver.dispose()
  })

  it('creates opaque refs and redacts editable and protected values', async () => {
    const harness = createHarness(standardCommand)
    const driver = new CdpBrowserDriver(harness.webContents)
    const snapshot = await driver.snapshot(new AbortController().signal)

    expect(snapshot).toMatchObject({
      url: 'https://example.com/page',
      title: 'Example',
      truncated: false
    })
    expect(snapshot.nodes).toHaveLength(4)
    expect(snapshot.nodes.every((node) => /^b_[A-Za-z0-9_-]+$/u.test(node.ref)))
      .toBe(true)
    expect(snapshot.nodes.find((node) => node.name === 'Email')?.value)
      .toBeUndefined()
    expect(snapshot.nodes.find((node) => node.name === 'Password')?.value)
      .toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('typed-secret')
    driver.dispose()
  })

  it('truncates very large accessibility trees without failing', async () => {
    const largeNodes = [
      {
        nodeId: 'root',
        backendDOMNodeId: 100,
        role: { value: 'RootWebArea' },
        name: { value: 'Large page' }
      },
      ...Array.from({ length: 2_000 }, (_, index) => ({
        nodeId: `node-${index}`,
        parentId: 'root',
        backendDOMNodeId: index + 101,
        role: { value: 'button' },
        name: { value: `Item ${index} ${'x'.repeat(2_000)}` }
      }))
    ]
    const harness = createHarness((method, parameters) =>
      method === 'Accessibility.getFullAXTree'
        ? Promise.resolve({ nodes: largeNodes })
        : standardCommand(method, parameters)
    )
    const driver = new CdpBrowserDriver(harness.webContents)

    const snapshot = await driver.snapshot(new AbortController().signal)

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.nodes.length).toBeGreaterThan(0)
    expect(snapshot.nodes.length).toBeLessThan(500)
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      128 * 1024
    )
    driver.dispose()
  })

  it('rejects a snapshot crossed by main-frame navigation', async () => {
    const harness = createHarness(async (method, parameters) => {
      if (
        method === 'Runtime.evaluate' &&
        parameters?.expression !== 'document.readyState'
      ) {
        harness.contentEvents.emit(
          'did-start-navigation',
          {},
          'https://example.com/changed',
          false,
          true
        )
      }
      return standardCommand(method, parameters)
    })
    const driver = new CdpBrowserDriver(harness.webContents)

    await expect(
      driver.snapshot(new AbortController().signal)
    ).rejects.toThrow('生成快照时发生变化')
    driver.dispose()
  })

  it('retries a transient CDP navigation race while taking a snapshot', async () => {
    let metadataAttempts = 0
    const harness = createHarness(async (method, parameters) => {
      if (
        method === 'Runtime.evaluate' &&
        parameters?.expression !== 'document.readyState'
      ) {
        metadataAttempts += 1
        if (metadataAttempts === 1) {
          throw new Error('Inspected target navigated or closed')
        }
      }
      return standardCommand(method, parameters)
    })
    const driver = new CdpBrowserDriver(harness.webContents)

    await expect(
      driver.snapshot(new AbortController().signal)
    ).resolves.toMatchObject({ title: 'Example' })
    expect(metadataAttempts).toBe(2)
    driver.dispose()
  })

  it('waits briefly for a placeholder challenge document to populate', async () => {
    let snapshotAttempts = 0
    const harness = createHarness(async (method, parameters) => {
      if (method === 'Accessibility.getFullAXTree') {
        snapshotAttempts += 1
        return snapshotAttempts === 1
          ? {
              nodes: [
                {
                  nodeId: 'root',
                  backendDOMNodeId: 10,
                  role: { value: 'RootWebArea' },
                  name: { value: '' }
                }
              ]
            }
          : standardCommand(method, parameters)
      }
      if (
        method === 'Runtime.evaluate' &&
        parameters?.expression !== 'document.readyState' &&
        snapshotAttempts === 1
      ) {
        return {
          result: {
            value: {
              title: '',
              url: 'https://example.com/challenge'
            }
          }
        }
      }
      return standardCommand(method, parameters)
    })
    const driver = new CdpBrowserDriver(harness.webContents)

    await expect(
      driver.snapshot(new AbortController().signal)
    ).resolves.toMatchObject({ title: 'Example' })
    expect(snapshotAttempts).toBe(2)
    driver.dispose()
  })

  it('keeps refs for subframe navigation and invalidates them for main-frame navigation', async () => {
    const harness = createHarness(standardCommand)
    const driver = new CdpBrowserDriver(harness.webContents)
    const snapshot = await driver.snapshot(new AbortController().signal)
    const button = snapshot.nodes.find((node) => node.name === 'Submit')
    if (!button) {
      throw new Error('button missing')
    }
    await driver.click(button.ref, new AbortController().signal)
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 60, y: 40 })
    )

    harness.contentEvents.emit(
      'did-start-navigation',
      {},
      'https://ads.example/frame',
      false,
      false,
      1,
      2
    )
    await expect(
      driver.click(button.ref, new AbortController().signal)
    ).resolves.toBeUndefined()

    harness.contentEvents.emit(
      'did-start-navigation',
      {},
      'https://example.com/next',
      false,
      true,
      1,
      1
    )
    await expect(
      driver.click(button.ref, new AbortController().signal)
    ).rejects.toThrow('引用已失效')
    driver.dispose()
  })

  it('keeps refs for subframe redirects and invalidates them for main-frame redirects', async () => {
    const harness = createHarness(standardCommand)
    const driver = new CdpBrowserDriver(harness.webContents)
    const snapshot = await driver.snapshot(new AbortController().signal)
    const button = snapshot.nodes.find((node) => node.name === 'Submit')
    if (!button) {
      throw new Error('button missing')
    }

    harness.contentEvents.emit(
      'will-redirect',
      {},
      'https://ads.example/redirect',
      false,
      false,
      1,
      2
    )
    await expect(
      driver.click(button.ref, new AbortController().signal)
    ).resolves.toBeUndefined()

    harness.contentEvents.emit(
      'will-redirect',
      {},
      'https://example.com/redirect',
      false,
      true,
      1,
      1
    )
    await expect(
      driver.click(button.ref, new AbortController().signal)
    ).rejects.toThrow('引用已失效')
    driver.dispose()
  })

  it('allows password typing while keeping the password value redacted', async () => {
    const harness = createHarness(standardCommand)
    const driver = new CdpBrowserDriver(harness.webContents)
    const snapshot = await driver.snapshot(new AbortController().signal)
    const password = snapshot.nodes.find((node) => node.name === 'Password')
    if (!password) {
      throw new Error('password missing')
    }
    await expect(
      driver.type(password.ref, 'login-secret', new AbortController().signal)
    ).resolves.toBeUndefined()
    expect(
      harness.sendCommand.mock.calls.some(
        ([method, parameters]) =>
          method === 'Input.insertText' &&
          parameters?.text === 'login-secret'
      )
    ).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('secret')
    driver.dispose()
  })

  it('selects an exact native option value with fixed internal DOM code', async () => {
    const selectedValue = `us-west'); globalThis.compromised = true; ('`
    const harness = createHarness(
      selectCommand({ selected: true, value: selectedValue })
    )
    const driver = new CdpBrowserDriver(harness.webContents)
    const snapshot = await driver.snapshot(new AbortController().signal)
    const select = snapshot.nodes.find((node) => node.name === 'Region')
    if (!select) {
      throw new Error('select missing')
    }

    await driver.select(
      select.ref,
      selectedValue,
      new AbortController().signal
    )

    const call = harness.sendCommand.mock.calls.find(
      ([method]) => method === 'Runtime.callFunctionOn'
    )
    expect(call?.[1]).toMatchObject({
      objectId: 'select-object',
      arguments: [{ value: selectedValue }],
      returnByValue: true
    })
    expect(call?.[1]?.functionDeclaration).toEqual(expect.any(String))
    expect(String(call?.[1]?.functionDeclaration)).not.toContain(selectedValue)
    expect(String(call?.[1]?.functionDeclaration)).toContain(
      "new Event('input'"
    )
    expect(String(call?.[1]?.functionDeclaration)).toContain(
      "new Event('change'"
    )
    expect(
      harness.sendCommand.mock.calls.some(
        ([method]) =>
          method === 'Input.insertText' ||
          method === 'Input.dispatchKeyEvent'
      )
    ).toBe(false)
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Runtime.releaseObject',
      { objectId: 'select-object' }
    )
    driver.dispose()
  })

  it('rejects a native select result that is not an exact value match', async () => {
    const harness = createHarness(
      selectCommand({ selected: false, value: 'partial-match' })
    )
    const driver = new CdpBrowserDriver(harness.webContents)
    const snapshot = await driver.snapshot(new AbortController().signal)
    const select = snapshot.nodes.find((node) => node.name === 'Region')
    if (!select) {
      throw new Error('select missing')
    }

    await expect(
      driver.select(
        select.ref,
        'partial-match-longer',
        new AbortController().signal
      )
    ).rejects.toThrow('完全匹配')
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Runtime.releaseObject',
      { objectId: 'select-object' }
    )
    driver.dispose()
  })

  it('bounds screenshots and returns only validated JPEG data', async () => {
    const harness = createHarness(standardCommand)
    const driver = new CdpBrowserDriver(harness.webContents)
    await expect(
      driver.screenshot(new AbortController().signal)
    ).resolves.toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg'
    })
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 60,
        fromSurface: true,
        captureBeyondViewport: false
      }
    )
    harness.sendCommand.mockImplementation(async (method) =>
      method === 'Page.captureScreenshot' ? { data: 'bm90LXBuZw==' } : {}
    )
    await expect(
      driver.screenshot(new AbortController().signal)
    ).rejects.toThrow('截图无效')
    driver.dispose()
  })

  it('validates a history target again before returning', async () => {
    const harness = createHarness(standardCommand)
    const driver = new CdpBrowserDriver(harness.webContents)
    const target = await driver.getBackTarget(new AbortController().signal)
    expect(target).toEqual({
      entryId: 4,
      url: 'https://previous.example/'
    })
    harness.setUrl('https://previous.example/')
    const navigation = driver.backTo(
      target,
      new AbortController().signal
    )
    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenCalledWith(
        'Page.navigateToHistoryEntry',
        { entryId: 4 }
      )
    )
    harness.contentEvents.emit(
      'did-navigate',
      {},
      'https://previous.example/'
    )
    await expect(navigation).resolves.toEqual({
      url: 'https://previous.example/'
    })
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Page.navigateToHistoryEntry',
      { entryId: 4 }
    )
    driver.dispose()
  })

  it('reloads through CDP with bounded commit and document waits', async () => {
    const harness = createHarness(async (method, parameters) =>
      method === 'Page.reload'
        ? {}
        : standardCommand(method, parameters)
    )
    const driver = new CdpBrowserDriver(harness.webContents)
    const reload = driver.reload(new AbortController().signal)
    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenCalledWith(
        'Page.reload',
        undefined
      )
    )
    harness.setUrl('https://example.com/reloaded')
    harness.contentEvents.emit(
      'did-navigate',
      {},
      'https://example.com/reloaded'
    )

    await expect(reload).resolves.toEqual({
      url: 'https://example.com/reloaded'
    })
    expect(harness.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'document.readyState' })
    )
    driver.dispose()
  })

  it('reports committed URL and actual back availability from history', async () => {
    const harness = createHarness(standardCommand)
    const driver = new CdpBrowserDriver(harness.webContents)
    const historyQuery = vi.spyOn(
      driver as unknown as {
        getNavigationHistory(signal: AbortSignal): Promise<unknown>
      },
      'getNavigationHistory'
    )

    await expect(
      driver.getNavigationMetadata(new AbortController().signal)
    ).resolves.toEqual({
      url: 'https://example.com/page',
      canGoBack: true
    })
    await expect(
      driver.getBackTarget(new AbortController().signal)
    ).resolves.toEqual({
      entryId: 4,
      url: 'https://previous.example/'
    })
    expect(historyQuery).toHaveBeenCalledTimes(2)
    driver.dispose()
  })

  it('bounds hung commands and removes listeners on disposal', async () => {
    const harness = createHarness(async () => new Promise(() => undefined))
    const driver = new CdpBrowserDriver(harness.webContents, { timeoutMs: 5 })
    await expect(
      driver.screenshot(new AbortController().signal)
    ).rejects.toThrow('超时')
    driver.dispose()
    expect(harness.contentEvents.listenerCount('did-start-navigation')).toBe(0)
    expect(harness.debuggerEvents.listenerCount('detach')).toBe(0)
    await expect(
      driver.screenshot(new AbortController().signal)
    ).rejects.toThrow('不可用')
  })

  it('cancels an uncommitted navigation and removes temporary listeners on disposal', async () => {
    const harness = createHarness(async (method, parameters) =>
      method === 'Page.navigate'
        ? { frameId: 'main', loaderId: 'loader-1' }
        : standardCommand(method, parameters)
    )
    const driver = new CdpBrowserDriver(harness.webContents)
    const navigation = driver.navigate(
      'https://example.com/page',
      new AbortController().signal
    )
    await vi.waitFor(() =>
      expect(harness.contentEvents.listenerCount('did-navigate')).toBe(1)
    )

    driver.dispose()

    await expect(navigation).rejects.toThrow('驱动已关闭')
    expect(harness.contentEvents.listenerCount('did-navigate')).toBe(0)
    expect(harness.contentEvents.listenerCount('did-fail-load')).toBe(0)
  })
})
