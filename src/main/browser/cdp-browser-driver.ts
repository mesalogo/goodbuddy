import { createHash, randomBytes } from 'node:crypto'
import type {
  BrowserDebugger,
  BrowserEventListener,
  BrowserWebContents
} from './electron-browser-session'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_AX_NODES = 500
const MAX_AX_DEPTH = 20
const MAX_AX_BYTES = 1024 * 1024
const MAX_SNAPSHOT_BYTES = 128 * 1024
const MAX_SCREENSHOT_BYTES = 512 * 1024
const MAX_INPUT_LENGTH = 16_384
const MAX_SELECT_LENGTH = 1_024
const SELECT_OPTION_FUNCTION = `function (expectedValue) {
  const options = Array.from(this.options);
  const option = options.find((candidate) => candidate.value === expectedValue);
  if (!option) {
    return { selected: false, value: this.value };
  }
  this.value = expectedValue;
  const selected = this.value === expectedValue;
  if (selected) {
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { selected, value: this.value };
}`

type CdpAxValue = {
  type?: string
  value?: unknown
}

type CdpAxProperty = {
  name?: string
  value?: CdpAxValue
}

type CdpAxNode = {
  nodeId?: string
  backendDOMNodeId?: number
  parentId?: string
  ignored?: boolean
  role?: CdpAxValue
  name?: CdpAxValue
  value?: CdpAxValue
  properties?: CdpAxProperty[]
}

export type BrowserSnapshotNode = {
  ref: string
  role: string
  name: string
  value?: string
  disabled?: boolean
  focused?: boolean
  editable?: boolean
}

export type BrowserSnapshot = {
  url: string
  title: string
  nodes: BrowserSnapshotNode[]
  truncated: boolean
}

export type BrowserScreenshot = {
  type: 'image'
  mimeType: 'image/png'
  data: string
}

export class BrowserStaleReferenceError extends Error {
  constructor(message = '浏览器元素引用已失效，请重新获取快照') {
    super(message)
    this.name = 'BrowserStaleReferenceError'
  }
}

export type BrowserHistoryTarget = {
  entryId: number
  url: string
}

type RefBinding = {
  backendNodeId: number
  generation: number
  role: string
  protected: boolean
}

export type CdpBrowserDriverOptions = {
  timeoutMs?: number
  maximumAxNodes?: number
  maximumAxDepth?: number
  maximumAxBytes?: number
  maximumSnapshotBytes?: number
  maximumScreenshotBytes?: number
}

type ResolvedTarget = {
  backendNodeId: number
  bounds: { x: number; y: number; width: number; height: number }
}

function stringValue(value: CdpAxValue | undefined): string {
  return typeof value?.value === 'string'
    ? value.value.slice(0, 2_000)
    : value?.value === undefined
      ? ''
      : String(value.value).slice(0, 2_000)
}

function propertyBoolean(
  node: CdpAxNode,
  name: string
): boolean | undefined {
  const value = node.properties?.find((property) => property.name === name)?.value
    ?.value
  return typeof value === 'boolean' ? value : undefined
}

function isProtectedAxNode(node: CdpAxNode): boolean {
  const role = stringValue(node.role).toLowerCase()
  const properties = new Map(
    node.properties?.map((property) => [
      property.name,
      property.value?.value
    ])
  )
  return (
    role === 'password' ||
    properties.get('hidden') === true ||
    properties.get('protected') === true ||
    properties.get('valuetext') === '••••••••'
  )
}

function delayAbortable(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds)
    function finish(): void {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
  })
}

function jsonStringBytes(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d ||
      code === 0x22 ||
      code === 0x5c
    ) {
      bytes += 2
    } else if (code < 0x20) {
      bytes += 6
    } else if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index += 1
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
  }
  return bytes
}

function exceedsJsonByteLimit(value: unknown, maximumBytes: number): boolean {
  let bytes = 0
  const stack = [value]
  const seen = new WeakSet<object>()
  const add = (amount: number): boolean => {
    bytes += amount
    return bytes > maximumBytes
  }

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === null) {
      if (add(4)) return true
    } else if (typeof current === 'string') {
      if (add(jsonStringBytes(current))) return true
    } else if (typeof current === 'number') {
      if (add(Number.isFinite(current) ? String(current).length : 4)) {
        return true
      }
    } else if (typeof current === 'boolean') {
      if (add(current ? 4 : 5)) return true
    } else if (Array.isArray(current)) {
      if (seen.has(current) || add(current.length > 0 ? current.length + 1 : 2)) {
        return true
      }
      seen.add(current)
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index])
      }
    } else if (typeof current === 'object') {
      if (seen.has(current)) return true
      seen.add(current)
      const entries = Object.entries(current).filter(
        ([, entryValue]) => entryValue !== undefined
      )
      if (add(entries.length > 0 ? entries.length + 1 : 2)) return true
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, entryValue] = entries[index]!
        if (add(jsonStringBytes(key) + 1)) return true
        stack.push(entryValue)
      }
    } else {
      return true
    }
  }
  return false
}

export class CdpBrowserDriver {
  private readonly debugger: BrowserDebugger
  private readonly timeoutMs: number
  private readonly maximumAxNodes: number
  private readonly maximumAxDepth: number
  private readonly maximumAxBytes: number
  private readonly maximumSnapshotBytes: number
  private readonly maximumScreenshotBytes: number
  private readonly refSecret = randomBytes(16)
  private readonly refs = new Map<string, RefBinding>()
  private readonly listeners: Array<{
    target: { off(event: string, listener: BrowserEventListener): unknown }
    event: string
    listener: BrowserEventListener
  }> = []
  private generation = 0
  private disposed = false

  constructor(
    private readonly webContents: BrowserWebContents,
    options: CdpBrowserDriverOptions = {}
  ) {
    this.debugger = webContents.debugger
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maximumAxNodes = options.maximumAxNodes ?? MAX_AX_NODES
    this.maximumAxDepth = options.maximumAxDepth ?? MAX_AX_DEPTH
    this.maximumAxBytes = options.maximumAxBytes ?? MAX_AX_BYTES
    this.maximumSnapshotBytes =
      options.maximumSnapshotBytes ?? MAX_SNAPSHOT_BYTES
    this.maximumScreenshotBytes =
      options.maximumScreenshotBytes ?? MAX_SCREENSHOT_BYTES
    this.listen(
      webContents,
      'did-start-navigation',
      (
        _event: unknown,
        _url: string,
        _isInPlace: boolean,
        isMainFrame: boolean | undefined
      ) => {
        if (isMainFrame !== false) {
          this.invalidate()
        }
      }
    )
    this.listen(
      webContents,
      'will-redirect',
      (
        _event: unknown,
        _url: string,
        _isInPlace: boolean,
        isMainFrame: boolean | undefined
      ) => {
        if (isMainFrame !== false) {
          this.invalidate()
        }
      }
    )
    this.listen(webContents, 'render-process-gone', () => this.invalidate())
    this.listen(this.debugger, 'detach', () => this.invalidate())
  }

  private listen(
    target: {
      on(event: string, listener: BrowserEventListener): unknown
      off(event: string, listener: BrowserEventListener): unknown
    },
    event: string,
    listener: BrowserEventListener
  ): void {
    target.on(event, listener)
    this.listeners.push({ target, event, listener })
  }

  private invalidate(): void {
    this.generation += 1
    this.refs.clear()
  }

  private command<T>(
    method: string,
    parameters: Record<string, unknown> | undefined,
    signal: AbortSignal
  ): Promise<T> {
    if (this.disposed || !this.debugger.isAttached()) {
      return Promise.reject(new Error('浏览器调试连接不可用'))
    }
    signal.throwIfAborted()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const effectiveSignal = AbortSignal.any([signal, timeout])
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        reject(
          signal.aborted
            ? signal.reason
            : new Error(`浏览器操作超时（${this.timeoutMs}ms）`)
        )
      }
      effectiveSignal.addEventListener('abort', abort, { once: true })
      void this.debugger
        .sendCommand(method, parameters)
        .then((result) => {
          effectiveSignal.removeEventListener('abort', abort)
          if (effectiveSignal.aborted) {
            abort()
          } else {
            resolve(result as T)
          }
        })
        .catch((error: unknown) => {
          effectiveSignal.removeEventListener('abort', abort)
          reject(new Error(`浏览器命令失败：${method}`, { cause: error }))
        })
    })
  }

  async navigate(url: string, signal: AbortSignal): Promise<{ url: string }> {
    this.invalidate()
    const result = await this.command<{
      errorText?: string
    }>('Page.navigate', { url }, signal)
    if (result.errorText) {
      throw new Error(`浏览器导航失败：${result.errorText.slice(0, 200)}`)
    }
    await this.waitForDocument(signal)
    return { url: this.webContents.getURL() || url }
  }

  private async waitForDocument(signal: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await this.command<{
        result?: { value?: string }
      }>(
        'Runtime.evaluate',
        {
          expression: 'document.readyState',
          returnByValue: true,
          awaitPromise: false
        },
        signal
      )
      if (
        result.result?.value === 'interactive' ||
        result.result?.value === 'complete'
      ) {
        return
      }
      await delayAbortable(50, signal)
    }
    throw new Error('浏览器页面未在安全期限内就绪')
  }

  private refFor(backendNodeId: number): string {
    return `b_${createHash('sha256')
      .update(this.refSecret)
      .update(String(this.generation))
      .update(':')
      .update(String(backendNodeId))
      .digest('base64url')
      .slice(0, 18)}`
  }

  async snapshot(signal: AbortSignal): Promise<BrowserSnapshot> {
    this.invalidate()
    const response = await this.command<{ nodes?: CdpAxNode[] }>(
      'Accessibility.getFullAXTree',
      { depth: this.maximumAxDepth },
      signal
    )
    if (exceedsJsonByteLimit(response, this.maximumAxBytes)) {
      throw new Error('浏览器可访问性树超过安全限制')
    }
    const allNodes = response.nodes ?? []
    const limited = allNodes.slice(0, this.maximumAxNodes)
    const knownDepth = new Map<string, number>()
    const output: BrowserSnapshotNode[] = []
    for (const node of limited) {
      const parentDepth = node.parentId
        ? knownDepth.get(node.parentId)
        : -1
      const depth = (parentDepth ?? this.maximumAxDepth) + 1
      if (node.nodeId) {
        knownDepth.set(node.nodeId, depth)
      }
      if (
        depth > this.maximumAxDepth ||
        node.ignored ||
        !node.backendDOMNodeId
      ) {
        continue
      }
      const role = stringValue(node.role) || 'unknown'
      const ref = this.refFor(node.backendDOMNodeId)
      const protectedNode = isProtectedAxNode(node)
      this.refs.set(ref, {
        backendNodeId: node.backendDOMNodeId,
        generation: this.generation,
        role,
        protected: protectedNode
      })
      const item: BrowserSnapshotNode = {
        ref,
        role,
        name: stringValue(node.name),
        disabled: propertyBoolean(node, 'disabled'),
        focused: propertyBoolean(node, 'focused'),
        editable: propertyBoolean(node, 'editable')
      }
      const value = stringValue(node.value)
      const redactedValue =
        protectedNode ||
        item.editable === true ||
        ['combobox', 'searchbox', 'spinbutton', 'textbox'].includes(
          role.toLowerCase()
        )
      if (value && !redactedValue) {
        item.value = value
      }
      output.push(item)
    }
    const document = await this.command<{
      result?: { value?: { title?: unknown; url?: unknown } }
    }>(
      'Runtime.evaluate',
      {
        expression: '({title: document.title, url: location.href})',
        returnByValue: true,
        awaitPromise: false
      },
      signal
    )
    const title =
      typeof document.result?.value?.title === 'string'
        ? document.result.value.title.slice(0, 500)
        : ''
    const url =
      typeof document.result?.value?.url === 'string'
        ? document.result.value.url.slice(0, 8_192)
        : this.webContents.getURL()
    const snapshot = {
      url,
      title,
      nodes: output,
      truncated: allNodes.length > limited.length
    }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > this.maximumSnapshotBytes) {
      this.refs.clear()
      throw new Error('浏览器快照超过安全限制')
    }
    return snapshot
  }

  private async resolveTarget(
    ref: string,
    action: 'click' | 'type' | 'select',
    signal: AbortSignal
  ): Promise<ResolvedTarget> {
    const binding = this.refs.get(ref)
    if (!binding || binding.generation !== this.generation) {
      throw new BrowserStaleReferenceError()
    }
    const described = await this.command<{
      node?: Record<string, unknown> & {
        attributes?: unknown
        nodeName?: unknown
        backendNodeId?: unknown
      }
    }>(
      'DOM.describeNode',
      {
        backendNodeId: binding.backendNodeId,
        depth: 0,
        pierce: false
      },
      signal
    )
    const node = described.node
    if (!node || node.backendNodeId !== binding.backendNodeId) {
      throw new Error('浏览器元素状态已改变，请重新获取快照')
    }
    const attributes = Array.isArray(node.attributes)
      ? node.attributes.filter(
          (value): value is string => typeof value === 'string'
        )
      : []
    const attributeMap = new Map<string, string>()
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      attributeMap.set(
        (attributes[index] ?? '').toLowerCase(),
        attributes[index + 1] ?? ''
      )
    }
    const nodeName =
      typeof node.nodeName === 'string' ? node.nodeName.toLowerCase() : ''
    const inputType = (attributeMap.get('type') ?? '').toLowerCase()
    const blocked =
      binding.protected ||
      attributeMap.has('hidden') ||
      attributeMap.has('disabled') ||
      attributeMap.has('inert') ||
      attributeMap.has('readonly') ||
      attributeMap.get('aria-hidden') === 'true' ||
      attributeMap.get('aria-disabled') === 'true' ||
      inputType === 'hidden' ||
      inputType === 'password' ||
      inputType === 'file'
    if (blocked) {
      throw new Error('浏览器拒绝操作受保护、隐藏或禁用字段')
    }
    if (
      action === 'type' &&
      !(
        nodeName === 'textarea' ||
        nodeName === 'input' ||
        attributeMap.get('contenteditable') === 'true'
      )
    ) {
      throw new Error('浏览器目标不是可编辑字段')
    }
    if (action === 'select' && nodeName !== 'select') {
      throw new Error('浏览器目标不是选择控件')
    }
    const model = await this.command<{
      model?: {
        content?: number[]
        border?: number[]
      }
    }>(
      'DOM.getBoxModel',
      { backendNodeId: binding.backendNodeId },
      signal
    )
    const quad = model.model?.content ?? model.model?.border
    if (!quad || quad.length !== 8 || quad.some((value) => !Number.isFinite(value))) {
      throw new Error('浏览器元素不可见或没有有效边界')
    }
    const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0]
    const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0]
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    const width = Math.max(...xs) - x
    const height = Math.max(...ys) - y
    const metrics = await this.command<{
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      layoutViewport?: { clientWidth?: number; clientHeight?: number }
    }>('Page.getLayoutMetrics', undefined, signal)
    const viewport = metrics.cssVisualViewport ?? metrics.layoutViewport
    const viewportWidth = viewport?.clientWidth ?? 0
    const viewportHeight = viewport?.clientHeight ?? 0
    if (
      width < 1 ||
      height < 1 ||
      x < 0 ||
      y < 0 ||
      x + width > viewportWidth ||
      y + height > viewportHeight
    ) {
      throw new Error('浏览器元素超出当前可见页面边界')
    }
    return {
      backendNodeId: binding.backendNodeId,
      bounds: { x, y, width, height }
    }
  }

  async click(ref: string, signal: AbortSignal): Promise<void> {
    const target = await this.resolveTarget(ref, 'click', signal)
    const x = target.bounds.x + target.bounds.width / 2
    const y = target.bounds.y + target.bounds.height / 2
    await this.command(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y },
      signal
    )
    await this.command(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      signal
    )
    await this.command(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      signal
    )
  }

  async type(
    ref: string,
    text: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!text || text.length > MAX_INPUT_LENGTH) {
      throw new Error('浏览器输入内容为空或超过安全限制')
    }
    const target = await this.resolveTarget(ref, 'type', signal)
    const x = target.bounds.x + target.bounds.width / 2
    const y = target.bounds.y + target.bounds.height / 2
    await this.command(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      signal
    )
    await this.command(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      signal
    )
    await this.command('Input.insertText', { text }, signal)
  }

  async select(
    ref: string,
    value: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!value || value.length > MAX_SELECT_LENGTH) {
      throw new Error('浏览器选择值为空或超过安全限制')
    }
    const target = await this.resolveTarget(ref, 'select', signal)
    const resolved = await this.command<{
      object?: { objectId?: string }
    }>(
      'DOM.resolveNode',
      { backendNodeId: target.backendNodeId },
      signal
    )
    const objectId = resolved.object?.objectId
    if (!objectId) {
      throw new Error('浏览器选择控件已失效')
    }
    try {
      const result = await this.command<{
        exceptionDetails?: unknown
        result?: {
          value?: { selected?: unknown; value?: unknown }
        }
      }>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: SELECT_OPTION_FUNCTION,
          arguments: [{ value }],
          returnByValue: true,
          awaitPromise: false,
          silent: true
        },
        signal
      )
      if (
        result.exceptionDetails ||
        result.result?.value?.selected !== true ||
        result.result.value.value !== value
      ) {
        throw new Error('浏览器未找到完全匹配的选择项')
      }
    } finally {
      await this.command(
        'Runtime.releaseObject',
        { objectId },
        new AbortController().signal
      ).catch(() => undefined)
    }
  }

  async getBackTarget(signal: AbortSignal): Promise<BrowserHistoryTarget> {
    const history = await this.command<{
      currentIndex?: number
      entries?: Array<{ id?: number; url?: string }>
    }>('Page.getNavigationHistory', undefined, signal)
    const index = history.currentIndex ?? -1
    const entry = history.entries?.[index - 1]
    if (
      index < 1 ||
      typeof entry?.id !== 'number' ||
      typeof entry.url !== 'string' ||
      entry.url.length === 0 ||
      entry.url.length > 8_192
    ) {
      throw new Error('浏览器没有可返回的页面')
    }
    return { entryId: entry.id, url: entry.url }
  }

  async backTo(
    target: BrowserHistoryTarget,
    signal: AbortSignal
  ): Promise<{ url: string }> {
    const current = await this.getBackTarget(signal)
    if (current.entryId !== target.entryId || current.url !== target.url) {
      throw new Error('浏览器历史记录已改变，请重试')
    }
    this.invalidate()
    await this.command(
      'Page.navigateToHistoryEntry',
      { entryId: target.entryId },
      signal
    )
    await this.waitForDocument(signal)
    return { url: this.webContents.getURL() }
  }

  async back(signal: AbortSignal): Promise<{ url: string }> {
    return this.backTo(await this.getBackTarget(signal), signal)
  }

  async screenshot(signal: AbortSignal): Promise<BrowserScreenshot> {
    const result = await this.command<{ data?: string }>(
      'Page.captureScreenshot',
      {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
      },
      signal
    )
    if (
      typeof result.data !== 'string' ||
      result.data.length === 0 ||
      result.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        result.data
      )
    ) {
      throw new Error('浏览器返回了无效截图')
    }
    const data = Buffer.from(result.data, 'base64')
    if (
      data.byteLength > this.maximumScreenshotBytes ||
      data.byteLength < 8 ||
      !data.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ) ||
      data.toString('base64') !== result.data
    ) {
      throw new Error('浏览器截图无效或超过安全限制')
    }
    return { type: 'image', mimeType: 'image/png', data: result.data }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.invalidate()
    for (const { target, event, listener } of this.listeners.splice(0)) {
      target.off(event, listener)
    }
  }
}
