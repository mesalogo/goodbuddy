import type { Page, CDPSession, FileChooser, Dialog } from 'playwright'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserDriverLike } from './browser-service'
import { BrowserStaleReferenceError, type BrowserHistoryTarget, type BrowserSnapshot } from './cdp-browser-driver'
import type { BrowserAction } from '../../shared/browser-interaction'
import { MAX_BROWSER_SCREENSHOT_BYTES } from './browser-screenshot'

export class PlaywrightBrowserDriver implements BrowserDriverLike {
  private readonly refs = new Map<string, string>()
  private generation = 0
  private readonly refScope = randomUUID().replaceAll('-', '').slice(0, 12)
  private chooser?: FileChooser
  private dialog?: Dialog
  constructor(readonly page: Page, readonly cdp: CDPSession, private readonly integration: { downloads: () => unknown[]; dispose: () => void }) {
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(30_000)
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) this.refs.clear() })
    page.on('dialog', (dialog) => { this.dialog = dialog })
    cdp.on('Page.javascriptDialogClosed', () => { this.dialog = undefined })
  }

  private target(ref: string) {
    const upstream = this.refs.get(ref)
    if (!upstream) throw new BrowserStaleReferenceError()
    return this.page.getByRef(upstream)
  }

  async snapshot(signal: AbortSignal): Promise<BrowserSnapshot> {
    if (this.dialog) return { url: this.page.url(), title: '', nodes: [], tree: `网页对话框（${this.dialog.type()}）：${this.dialog.message()}。请使用 browser_action 的 dialog 操作处理。`, truncated: false }
    const fullTree = await this.page.ariaSnapshot({ mode: 'ai', signal, depth: 30 })
    const truncated = fullTree.length > 100_000
    const tree = truncated ? fullTree.slice(0, Math.max(0, fullTree.lastIndexOf('\n', 100_000))) : fullTree
    this.refs.clear()
    const generation = ++this.generation
    const nodes: BrowserSnapshot['nodes'] = []
    const snapshot = tree.replace(/\[ref=([^\]]+)\]/gu, (_match, ref: string) => {
      const id = `b_${this.refScope}_${generation}_${ref}`
      this.refs.set(id, ref)
      return `[ref=${id}]`
    })
    for (const line of snapshot.split('\n')) {
      const match = /^\s*-\s+(\w+)(?:\s+"((?:\\.|[^"\\])*)")?.*?\[ref=([^\]]+)\]/u.exec(line)
      if (match) nodes.push({ ref: match[3]!, role: match[1]!, name: match[2] ?? '' })
    }
    signal.throwIfAborted()
    return { url: this.page.url(), title: await this.page.title(), nodes, tree: snapshot, truncated }
  }

  async navigate(url: string, signal: AbortSignal) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', signal })
    return { url: this.page.url() }
  }
  async reload(signal: AbortSignal) {
    await this.page.reload({ waitUntil: 'domcontentloaded', signal })
    return { url: this.page.url() }
  }
  private async withDialog<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const modal = new AbortController()
    const opened = (): void => modal.abort(new Error('网页打开了待处理对话框'))
    this.page.on('dialog', opened)
    try {
      return await operation(AbortSignal.any([signal, modal.signal]))
    } catch (error) {
      signal.throwIfAborted()
      if (!modal.signal.aborted) throw error
      return undefined
    } finally { this.page.off('dialog', opened) }
  }
  async click(ref: string, signal: AbortSignal): Promise<void> {
    const chooserOpened = (chooser: FileChooser): void => { this.chooser = chooser }
    const target = this.target(ref)
    this.page.on('filechooser', chooserOpened)
    try {
      await this.withDialog(signal, (effective) => target.click({ signal: effective }))
      if (!this.dialog) await delay(100, undefined, { signal })
      signal.throwIfAborted()
    } finally {
      this.page.off('filechooser', chooserOpened)
    }
  }
  async type(ref: string, text: string, signal: AbortSignal): Promise<void> { await this.target(ref).fill(text, { signal }) }
  async select(ref: string, value: string, signal: AbortSignal): Promise<void> { await this.target(ref).selectOption(value, { signal }) }
  private async history(signal: AbortSignal) {
    signal.throwIfAborted()
    return await this.cdp.send('Page.getNavigationHistory')
  }
  async getBackTarget(signal: AbortSignal): Promise<BrowserHistoryTarget> {
    const history = await this.history(signal)
    const entry = history.entries[history.currentIndex - 1]
    if (!entry) throw new Error('浏览器没有上一页')
    return { entryId: entry.id, url: entry.url }
  }
  async backTo(_target: BrowserHistoryTarget, signal: AbortSignal) {
    await this.page.goBack({ waitUntil: 'domcontentloaded', signal })
    return { url: this.page.url() }
  }
  async getNavigationMetadata(signal: AbortSignal) {
    const history = await this.history(signal)
    return { url: this.page.url(), canGoBack: history.currentIndex > 1 || (history.currentIndex > 0 && history.entries[history.currentIndex - 1]?.url !== 'about:blank') }
  }
  async screenshot(signal: AbortSignal) {
    for (const quality of [80, 60, 40, 20]) {
      const image = await this.page.screenshot({ type: 'jpeg', quality, signal, timeout: 15_000 })
      if (image.length <= MAX_BROWSER_SCREENSHOT_BYTES) return { type: 'image' as const, mimeType: 'image/jpeg' as const, data: image.toString('base64') }
    }
    throw new Error('浏览器截图超过输出大小限制，请缩小视口')
  }
  async action(action: BrowserAction, signal: AbortSignal): Promise<unknown> {
    if (action.kind === 'dialog') return this.performAction(action, signal)
    const result = await this.withDialog(signal, (effective) => this.performAction(action, effective))
    return result ?? { dialog: this.dialog ? { type: this.dialog.type(), message: this.dialog.message() } : undefined }
  }
  private async performAction(action: BrowserAction, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    switch (action.kind) {
      case 'hover': await this.target(action.ref).hover({ signal }); break
      case 'press': {
        const focused = this.page.locator(':focus')
        await (await focused.count() ? focused : this.page.locator('body')).press(action.key, { signal })
        break
      }
      case 'scroll': await this.page.mouse.wheel(action.deltaX, action.deltaY); break
      case 'drag': await this.target(action.from).dragTo(this.target(action.to), { signal }); break
      case 'check': await this.target(action.ref).setChecked(action.checked, { signal }); break
      case 'wait': await this.target(action.ref).waitFor({ state: action.state, signal }); break
      case 'fill': await this.target(action.ref).fill(action.text, { signal }); break
      case 'upload':
        if (action.ref) await this.target(action.ref).setInputFiles(action.paths, { signal })
        else if (this.chooser) {
          const chooser = this.chooser
          await chooser.setFiles(action.paths, { signal })
          if (this.chooser === chooser) this.chooser = undefined
        } else if (await this.page.locator('input[type="file"]').count() === 1) {
          await this.page.locator('input[type="file"]').setInputFiles(action.paths, { signal })
        } else throw new Error('请先点击页面的上传按钮，或提供文件输入框引用')
        break
      case 'dialog': {
        const dialog = this.dialog
        if (!dialog) throw new Error('当前页面没有待处理弹框')
        if (action.accept) await dialog.accept(action.text)
        else await dialog.dismiss()
        if (this.dialog === dialog) this.dialog = undefined
        break
      }
      case 'console': return (await this.page.consoleMessages()).map((message) => ({ type: message.type(), text: message.text() }))
      case 'requests': return (await this.page.requests()).map((request) => ({ url: request.url(), method: request.method(), failure: request.failure() }))
      case 'downloads': return this.integration.downloads()
      case 'clickAt': {
        let opened!: () => void
        const modal = new Promise<void>((resolve) => { opened = resolve })
        this.page.once('dialog', opened)
        try { await Promise.race([this.page.mouse.click(action.x, action.y), modal]) }
        finally { this.page.off('dialog', opened) }
        break
      }
    }
    signal.throwIfAborted()
    return { done: true, dialog: this.dialog ? { type: this.dialog.type(), message: this.dialog.message() } : undefined, fileChooser: Boolean(this.chooser), downloads: this.integration.downloads() }
  }
  dispose(): void { this.refs.clear(); this.integration?.dispose() }
}
