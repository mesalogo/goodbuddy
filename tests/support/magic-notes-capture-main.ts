import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { registerIpcHandlers } from '../../src/main/ipc'
import { AssistantDatabase } from '../../src/main/assistant/assistant-database'
import { ApplicationSettingsStore } from '../../src/main/application-settings-store'
import { defaultRuntimeSettings } from '../../src/shared/contracts'
import { verifySidebarSearch } from './sidebar-search-probe'

const directory = process.env.GB_CAPTURE_DIRECTORY!
app.setPath('userData', join(directory, 'profile'))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    preload: join(directory, 'preload.cjs')
  } })
  const path = join(directory, 'assistant.sqlite')
  const database = new AssistantDatabase(path)
  database.initialize(directory)
  const project = database.listProjects()[0]!
  const header = { id: randomUUID(), title: 'Capture discussion', projectId: project.id, updatedAt: Date.now() }
  const messages = Array.from({ length: 502 }, (_, index) => ({ id: randomUUID(), role: index % 2 ? 'assistant' as const : 'user' as const,
    content: `CAPTURE_HISTORY_${index}_END`, state: 'complete' as const, createdAt: 1775000000000 + index }))
  database.saveLocalConversations([{ header, messages }])
  const existing = database.createMagicNote({ title: 'Collected answers' })
  database.createMagicNoteEntry({ noteId: existing.id, content: { version: 1, ops: [{ insert: 'Keep existing entry\n' }] }, plainText: 'Keep existing entry' })
  const applicationSettings = new ApplicationSettingsStore(join(directory, 'application.json'))
  await applicationSettings.update({ magicNotesEnabled: true, magicNoteCommentMode: 'after-save-manual', checkUpdatesOnStartup: false })
  const settings = { ...defaultRuntimeSettings, workspacePath: directory, modelProfiles: [], embeddingConnections: [] }
  // Unrelated App services are test environment dependencies. All capture-related handlers are production.
  const dispose = registerIpcHandlers(win, { capability: 'text', getStatus: async () => ({ available: true, name: 'Capture test', capability: 'text' }) } as never,
    'CommandOrControl+Shift+Space', { getResolvedSettings: async () => settings, getPublicSettings: async () => settings } as never,
    {} as never, { clear() {}, cancelImport() {}, getDraft: () => [] } as never,
    { snapshot: () => ({ libraries: [], sources: [], documents: [], entities: [], relations: [], evidence: [], tasks: [] }),
      database: { externalStore: { listBindings: () => [] } }, external: { listInstances: () => [] } } as never, database,
    {} as never, async () => {}, undefined, undefined, undefined, undefined, applicationSettings,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { getPending: async () => undefined } as never)
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
  const run = <T = unknown>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true)
  async function wait(script: string, label: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await run(script)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const focus = await run(`(() => {
      const title = document.querySelector('#compact-note-title');
      const active = document.activeElement;
      return { documentFocused: document.hasFocus(), activeId: active?.id,
        activeTag: active?.tagName, activeLabel: active?.getAttribute('aria-label'),
        titlePresent: Boolean(title), titleDisabled: title?.disabled,
        titleVisible: title?.checkVisibility(), titleInert: Boolean(title?.closest('[inert]')),
        saving: document.querySelector('.magic-note-panel')?.getAttribute('aria-busy') };
    })()`)
    throw new Error(`Timed out: ${label}; focus=${JSON.stringify(focus)}`)
  }
  function button(name: string, root = 'document'): string {
    return `[...${root}.querySelectorAll('button,[role="menuitem"]')].find(e => (e.getAttribute('aria-label') || e.textContent.trim()) === ${JSON.stringify(name)} && e.getClientRects().length)`
  }
  async function click(name: string, root?: string): Promise<void> {
    const expression = button(name, root)
    await wait(`Boolean(${expression})`, name)
    await run(`${expression}.click()`)
  }
  async function key(keyCode: string): Promise<void> {
    win.show()
    win.focus()
    win.webContents.focus()
    await wait('document.hasFocus()', 'native window focus for keyboard input')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  const panel = 'document.querySelector(".magic-note-panel")'
  const evidence: Record<string, unknown> = {}
  let closed = false
  try {
    await win.loadURL(process.env.GB_CAPTURE_URL!)
    win.focus()
    win.webContents.focus()
    await wait('document.hasFocus()', 'visible capture window focus')
    await wait('document.body.innerText.includes("CAPTURE_HISTORY_501_END")', 'App persisted history')
    evidence.sidebarSearch = await verifySidebarSearch(win)
    assert.equal(await run('document.body.innerText.includes("CAPTURE_HISTORY_0_END")'), false, 'old history must initially be folded')
    // The last assistant reply is rendered by the real ChatTimeline.
    await run(`[...document.querySelectorAll('button')].filter(e => e.getAttribute('aria-label') === 'Add to note' || e.title === 'Add to note').at(-1).click()`)
    await wait('Boolean(document.querySelector("#compact-note-text"))', 'capture preview')
    assert.equal(await run('(document.querySelector("#compact-note-text")).value'), messages[501]!.content)
    assert.equal(await run(`${button('Add to note', panel)}.disabled`), true)
    await wait(`${panel}.innerText.includes('Collected answers')`, 'existing target')
    await run(`${panel}.querySelector('.magic-note-panel__note').click()`)
    await click('Add to note', panel)
    await wait(`${panel}.innerText.includes('Keep existing entry') && !document.querySelector('#compact-note-text')`, 'saved existing entry')
    const saved = database.getMagicNote(existing.id)
    assert.equal(saved.entries.length, 2)
    const captured = saved.entries.find(entry => entry.source)!
    assert.equal(captured.plainText, messages[501]!.content)
    assert.deepEqual(captured.content, { version: 1, ops: [{ insert: `${messages[501]!.content}\n` }] })
    assert.equal(captured.source?.kind, 'message')
    assert.equal(captured.source?.conversationId, header.id)
    assert.equal(captured.source?.projectId, project.id)
    assert.deepEqual(captured.source?.messageIds, [messages[501]!.id])
    assert.equal(captured.source?.conversationTitle, header.title)
    assert.equal(captured.source?.projectName, project.name)
    evidence.existingSaved = true
    await click('Open in full workspace', `document.getElementById('compact-note-entry-${captured.id}')`)
    await wait(`Boolean(document.getElementById('magic-note-entry-${captured.id}'))`, 'full workspace exact entry')
    evidence.workspaceOpened = true
    await click('View source message', `document.getElementById('magic-note-entry-${captured.id}')`)
    await wait('document.activeElement?.matches("article.message") && document.activeElement.textContent.includes("CAPTURE_HISTORY_501_END")', 'source message focus')
    evidence.sourceOpened = true
    await click('Conversation actions')
    await click('Save conversation to note')
    await wait('Boolean(document.querySelector("#compact-note-text"))', 'full history preview')
    const expected = messages.map(message => `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.content}`).join('\n\n')
    assert.equal(await run('document.querySelector("#compact-note-text").value'), expected)
    evidence.fullHistoryCount = messages.length
    await click('New note', panel)
    await wait('document.activeElement?.id === "compact-note-title"', 'new title focus')
    assert.equal(await run('document.querySelector("#compact-note-title").value'), header.title)
    await click('Add to note', panel)
    await wait(`!document.querySelector('#compact-note-text') && ${panel}.innerText.includes('CAPTURE_HISTORY_0_END')`, 'saved full history')
    const newNote = database.listMagicNotes().find(note => note.id !== existing.id)!
    let detail = database.getMagicNote(newNote.id)
    assert.equal(detail.entries.length, 1)
    assert.equal(detail.title, header.title)
    assert.equal(detail.entries[0]!.plainText, expected)
    assert.deepEqual(detail.entries[0]!.content, { version: 1, ops: [{ insert: `${expected}\n` }] })
    assert.equal(detail.entries[0]!.source?.kind, 'conversation')
    assert.equal(detail.entries[0]!.source?.conversationId, header.id)
    assert.equal(detail.entries[0]!.source?.projectName, project.name)
    assert.deepEqual(detail.entries[0]!.source?.messageIds, messages.map(message => message.id))
    evidence.newSaved = true
    // Electron resize and the production sidebar transition settle asynchronously.
    win.setSize(760, 800)
    await wait('window.innerWidth < 900', 'narrow viewport after resize')
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (await run('document.querySelector(".assistant-sidebar-toggle").getAttribute("aria-expanded") === "false"')) {
      await click('Toggle assistant workspace')
    }
    await wait(`document.querySelector(".assistant-sidebar-toggle").getAttribute("aria-expanded") === "true" && ${panel}.getBoundingClientRect().width > 100`, 'visible narrow panel after resize')
    await run(`document.querySelector('#compact-note-append').focus()`)
    await wait('document.activeElement?.id === "compact-note-append"', 'narrow append focus')
    await key('Escape')
    await wait('document.activeElement?.id === "compact-note-search"', 'Escape returns to list and search')
    await key('Tab')
    assert.equal(await run('document.activeElement?.classList.contains("magic-note-panel__note")'), true)
    await key('Enter')
    await wait('Boolean(document.querySelector("#compact-note-append"))', 'keyboard opens note')
    const bounds = await run<{ width: number; overflow: number }>(`(() => { const p=${panel};return {width:p.getBoundingClientRect().width,overflow:p.scrollWidth-p.clientWidth} })()`)
    assert.ok(bounds.width > 0 && bounds.width <= 480, JSON.stringify(bounds))
    assert.ok(bounds.overflow <= 1, JSON.stringify(bounds))
    await run(`document.querySelector('#compact-note-append').focus()`)
    await win.webContents.insertText('Keyboard append')
    await wait(`${button('Add to note', panel)}.disabled === false`, 'keyboard draft ready')
    await key('Tab')
    await key('Tab')
    assert.equal(await run('document.activeElement?.textContent.trim()'), 'Add to note')
    await key('Enter')
    await wait(`${panel}.innerText.includes('Keyboard append') && document.querySelector('#compact-note-append').value === ''`, 'keyboard save')
    detail = database.getMagicNote(newNote.id)
    assert.equal(detail.entries.length, 2)
    assert.ok(detail.entries.some(entry => entry.plainText === 'Keyboard append' && !entry.source))
    evidence.keyboard = true
    evidence.narrowPanel = true
    evidence.panelWidth = bounds.width
    // Exercise the actual draft guard Portal outside the notes page ancestry.
    await run(`document.querySelector('#compact-note-append').focus()`)
    await win.webContents.insertText('Unsaved style regression draft')
    await key('Escape')
    await wait('Boolean(document.querySelector("#note-draft-title"))', 'draft discard Portal')
    const danger = 'document.querySelector(".custom-task-dialog .danger-solid")'
    assert.equal(await run(`${danger}.closest('.magic-notes-page') === null`), true)
    const buttonStyles = []
    win.show()
    win.focus()
    win.webContents.focus()
    await wait('document.hasFocus()', 'native window focus for button styles')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('DOM.enable')
    await win.webContents.debugger.sendCommand('CSS.enable')
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.custom-task-dialog .danger-solid' })
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme = '${theme}'`)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
      await run(`${button('Continue editing')}.focus()`)
      await key('Tab')
      await wait(`${danger} === document.activeElement && ${danger}.matches(':focus-visible')`, 'keyboard focus on discard')
      const style = await run<Record<string, string | number | boolean>>(`(() => {
        const b = ${danger}, s = getComputedStyle(b);
        const other = getComputedStyle(b.previousElementSibling);
        const token = name => s.getPropertyValue(name).trim();
        const rgb = value => { const c = document.createElement('span'); c.style.color = value; b.append(c); const v = getComputedStyle(c).color; c.remove(); return v };
        return { width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height, minHeight: s.minHeight,
          controlHeight: token('--control-height'), background: s.backgroundColor,
          expectedBackground: rgb(token('--danger-solid')), expectedHover: rgb(token('--danger-solid-hover')), color: s.color,
          expectedColor: rgb(token('--text-on-accent')), radius: s.borderRadius,
          expectedRadius: token('--radius-control'), font: s.font, siblingFont: other.font,
          padding: s.padding, siblingPadding: other.padding, display: s.display,
          focused: b === document.activeElement && b.matches(':focus-visible'),
          outline: s.outlineWidth, pixelRatio: window.devicePixelRatio, outlineStyle: s.outlineStyle, outlineOffset: s.outlineOffset,
          outlineColor: s.outlineColor, expectedOutline: rgb(token('--accent')) };
      })()`)
      assert.equal(style.background, style.expectedBackground)
      assert.equal(style.color, style.expectedColor)
      assert.equal(style.radius, style.expectedRadius)
      assert.equal(style.minHeight, style.controlHeight)
      assert.ok(Number(style.height) >= parseFloat(String(style.controlHeight)))
      assert.equal(style.font, style.siblingFont)
      assert.equal(style.padding, style.siblingPadding)
      assert.equal(style.display, 'flex') // Inline flex is blockified in the dialog's flex footer.
      assert.equal(style.focused, true)
      // Chromium snaps outline widths to physical pixels on fractional Windows scaling.
      assert.ok(Math.abs(parseFloat(String(style.outline)) - 2) < 1 / Number(style.pixelRatio))
      assert.equal(style.outlineStyle, 'solid')
      assert.ok(Math.abs(parseFloat(String(style.outlineOffset)) - 2) < 1 / Number(style.pixelRatio))
      assert.equal(style.outlineColor, style.expectedOutline)
      if (process.env.GB_CAPTURE_SCREENSHOT_DIRECTORY) {
        writeFileSync(join(process.env.GB_CAPTURE_SCREENSHOT_DIRECTORY, `draft-danger-${theme}.png`), (await win.webContents.capturePage()).toPNG())
      }
      // Force the browser pseudo-state to test CSS independently of OS pointer ownership.
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
      const hover = await run<string>(`getComputedStyle(${danger}).backgroundColor`)
      assert.equal(hover, style.expectedHover)
      assert.notEqual(hover, style.background)
      await run(`${danger}.disabled = true`)
      const disabled = await run(`(() => { const s=getComputedStyle(${danger}); return {background:s.backgroundColor,opacity:s.opacity,cursor:s.cursor} })()`)
      assert.deepEqual(disabled, { background: style.background, opacity: '0.55', cursor: 'not-allowed' })
      await run(`${danger}.disabled = false`)
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
      buttonStyles.push({ theme, ...style, hover, disabled })
    }
    evidence.dangerButtonStyles = buttonStyles
    win.webContents.debugger.detach()
    await click('Continue editing')
    await wait('!document.querySelector("#note-draft-title")', 'continue editing retains draft')
    assert.equal(await run('document.querySelector("#compact-note-append").value'), 'Unsaved style regression draft')
    await run('window.goodbuddy.magicNotes.get(' + JSON.stringify(newNote.id) + ')')
    await dispose()
    database.close()
    closed = true
    const reopened = new AssistantDatabase(path)
    reopened.initialize(directory)
    try {
      assert.deepEqual(reopened.getMagicNote(newNote.id), detail)
      assert.deepEqual(reopened.getMagicNote(existing.id), saved)
      reopened.deleteLocalConversation(header.id)
      assert.deepEqual(reopened.getMagicNote(newNote.id), detail)
      evidence.sqliteReopened = true
      evidence.sourceSurvivesDeletion = true
    } finally { reopened.close() }
    const sql = new DatabaseSync(path)
    try {
      const rows = sql.prepare('SELECT source_json FROM magic_note_entries WHERE source_json IS NOT NULL').all()
      assert.equal(rows.length, 2)
      assert.ok(rows.some(row => JSON.parse(String(row.source_json)).messageIds.length === 502))
      evidence.sqliteSourceRows = rows.length
    } finally { sql.close() }
    evidence.modelAttempts = (globalThis as typeof globalThis & { captureModelAttempts?: number }).captureModelAttempts ?? 0
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error)
    evidence.layout = await run(`(() => { let e=${panel}; const rows=[]; while(e) {rows.push({tag:e.tagName,classes:e.className,width:e.getBoundingClientRect().width,style:e.getAttribute('style')});e=e.parentElement} return rows })()`)
    evidence.body = await run('document.body.innerText')
    if (!closed) {
      await dispose()
      database.close()
    }
  } finally {
    writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence))
    win.destroy()
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
