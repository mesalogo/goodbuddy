const { dirname, join, resolve } = require('node:path')
const { copyFileSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') {
  const { spawnSync } = require('node:child_process')
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-obsidian-ui-'))
  const env = { ...process.env, GOODBUDDY_OBSIDIAN_ACCEPTANCE_ROOT: root }
  if (process.argv.includes('--live') || process.argv.includes('--chat')) {
    env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_LIVE = process.argv.includes('--live') ? '1' : '0'
    env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_CHAT = process.argv.includes('--chat') ? '1' : '0'
    env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_CONTINUE_ONLY = process.argv.includes('--continue-only') ? '1' : '0'
    require('esbuild').buildSync({ entryPoints: ['tests/obsidian-runtime-acceptance.ts'],
      outfile: join(root, 'runtime.cjs'), bundle: true, external: ['electron', 'ssh2', 'node-pty', 'koffi'], platform: 'node', format: 'cjs',
      banner: { js: `require = require('node:module').createRequire(${JSON.stringify(resolve('package.json'))});` } })
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const result = spawnSync(require('electron'), [__filename], {
      env, stdio: 'inherit', timeout: 300_000
    })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
} else {
  const { app, BrowserWindow } = require('electron')
  const root = process.env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_ROOT
  assert(root)
  const profile = join(root, 'profile')
  mkdirSync(profile)
  if (process.env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_LIVE === '1' || process.env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_CHAT === '1') {
    const settings = process.env.GOODBUDDY_ACCEPTANCE_SETTINGS ?? join(app.getPath('appData'), 'goodbuddy', 'runtime-settings.json')
    copyFileSync(join(dirname(settings), 'Local State'), join(profile, 'Local State'))
  }
  mkdirSync(join(root, 'Temporary Vault'))
  app.setPath('userData', profile)
  app.setAppPath(resolve('.'))
  const timer = setTimeout(() => { console.error('Acceptance timed out'); app.exit(1) }, 280_000)
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  ;(async () => {
    const chat = process.env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_CHAT === '1'
      ? await require(join(root, 'runtime.cjs')).prepareChat(root, profile) : undefined
    await import(pathToFileURL(resolve('out/main/index.js')).href)
    let window
    for (let attempt = 0; attempt < 120; attempt++) {
      window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('index.html'))
      if (window && await window.webContents.executeJavaScript('Boolean(document.querySelector("button"))')) break
      await wait(250)
    }
    assert(window, 'Production main must open its BrowserWindow')
    assert.equal(app.getPath('userData'), profile)
    const preferences = window.webContents.getLastWebPreferences()
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.nodeIntegration, false)
    const js = code => window.webContents.executeJavaScript(code).catch(error => { throw new Error(`${code}: ${error.message}`) })
    const click = async expression => {
      window.focus()
      for (let i=0;i<100;i++) { if (await js(`Boolean(${expression})`)) break; await wait(100) }
      const point = await js(`(() => { const element = ${expression}; if (!element) throw new Error('Missing control'); element.scrollIntoView({block:'center'}); const r=element.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
      await wait(500)
    }
    if (chat) {
      await js(`(async()=>{const p=(await window.goodbuddy.projects.list())[0];await window.goodbuddy.projects.update(p.id,{name:p.name,description:p.description,rootPath:${JSON.stringify(join(root,'chat-workspace'))},defaultWorkMode:'execute',runtimeSelection:{provider:'opencode'}})})()`)
      window.webContents.reload()
      await wait(1000)
    }
    await click(`document.querySelector('button[aria-label="\u8bbe\u7f6e"]')`)
    await click(`Array.from(document.querySelectorAll('button')).find(b=>b.innerText.startsWith('\u80fd\u529b\u4e0e\u5de5\u5177'))`)
    await click(`Array.from(document.querySelectorAll('[role="tab"]')).find(b=>b.innerText==='MCP' && b.getClientRects().length)`)
    const card = `Array.from(document.querySelectorAll('.capability-card')).find(c=>c.querySelector('strong')?.textContent==='Obsidian')`
    const poll = async (expression, attempts=100) => {
      for (let i=0;i<attempts;i++) { if (await js(expression)) return; await wait(200) }
      console.error('VISIBLE_TABS',await js(`JSON.stringify(Array.from(document.querySelectorAll('[role="tab"]')).map(e=>({text:e.innerText,selected:e.getAttribute('aria-selected')})))`))
      throw new Error(`Timed out: ${expression}`)
    }
    await poll(`Boolean(${card})`)
    assert.equal(await js(`(${card}).querySelector('[role="switch"]').checked`), false)
    await click(`(${card}).querySelector('select')`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' })
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await poll(`Boolean((${card}).querySelector('input:not([type="checkbox"])'))`)
    const input = `(${card}).querySelector('input:not([type="checkbox"])')`
    const vault = join(root, 'Temporary Vault')
    await click(input)
    await window.webContents.insertText(vault)
    await click(`(${card}).querySelectorAll('.capability-card__actions button')[1]`)
    await poll(`Boolean((${card}).querySelector('[role="status"]'))`)
    assert.match(await js(`(${card}).querySelector('[role="status"]').textContent`), /18/)
    assert.equal((await js('window.goodbuddy.capabilities.getSnapshot()')).obsidian.vaultPath, '')
    assert.equal(await js(`(${card}).querySelector('[role="switch"]').checked`), false)
    await click(`(${card}).querySelectorAll('.capability-card__actions button')[2]`)
    await poll(`!(${card}).querySelector('.primary-button').disabled`)
    assert.equal((await js('window.goodbuddy.capabilities.getSnapshot()')).obsidian.vaultPath, vault)
    await click(input)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await window.webContents.insertText(join(root, 'missing-vault'))
    await click(`(${card}).querySelectorAll('.capability-card__actions button')[1]`)
    await poll(`Boolean((${card}).querySelector('[role="alert"]'))`)
    assert.equal(await js(`(${input}).value`), join(root, 'missing-vault'))
    assert.equal((await js('window.goodbuddy.capabilities.getSnapshot()')).obsidian.vaultPath, vault)
    console.log('PASS: native UI draft test (18 tools), no implicit save/enable, save through IPC, missing-folder error preserves draft')
    if (process.platform === 'win32') {
      await click(`(${card}).querySelectorAll('.capability-card__actions button')[0]`)
      const user32 = require('koffi').load('user32.dll')
      const getWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint32_t command)')
      const getPid = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)')
      const postMessage = user32.func('bool __stdcall PostMessageW(uintptr_t hwnd, uint32_t message, uintptr_t wparam, intptr_t lparam)')
      const handle = Number(window.getNativeWindowHandle().readBigUInt64LE())
      const popup = getWindow(handle, 6)
      assert(popup && Number(popup) !== handle, 'Native folder dialog must open')
      const pid = [0]
      getPid(popup, pid)
      assert.equal(pid[0], process.pid, 'Only close this acceptance process dialog')
      assert(postMessage(popup, 0x10, 0, 0))
      await poll(`!(${card}).querySelector('.primary-button').disabled`)
      assert.equal(await js(`(${input}).value`), join(root, 'missing-vault'))
      console.log('PASS: real Windows folder dialog opened and cancelled without changing draft')
    }
    window.setMinimumSize(640, 480)
    window.setSize(760, 720)
    await wait(500)
    const geometry = await js(`(() => {const c=${card};const r=c.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,scroll:c.scrollWidth,client:c.clientWidth}})()`)
    assert(geometry.scroll <= geometry.client + 1 && geometry.right <= geometry.width && geometry.left >= 0, JSON.stringify(geometry))
    console.log('PASS: narrow card has no horizontal overflow', JSON.stringify(geometry))
    await click(input)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await window.webContents.insertText(vault)
    await click(`(${card}).querySelectorAll('.capability-card__actions button')[1]`)
    await poll(`Boolean((${card}).querySelector('[role="status"]'))`)
    await js(`(${card}).querySelector('[role="switch"]').focus()`)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await poll(`(${card}).querySelector('[role="switch"]').checked && !(${card}).querySelector('[role="switch"]').disabled`)
    await click(`(${card}).querySelector('button[aria-expanded]')`)
    await poll(`(${card}).querySelectorAll('.mcp-server-tools li').length === 19`)
    console.log('PASS: keyboard switch enables Obsidian; expanded production UI lists 19 tools')
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      const bounds = await js(`(()=>{const c=${card};const r=c.getBoundingClientRect();return {right:r.right,width:innerWidth,scroll:c.scrollWidth,client:c.clientWidth,background:getComputedStyle(c).backgroundColor}})()`)
      assert(bounds.right <= bounds.width && bounds.scroll <= bounds.client + 1)
      console.log(`PASS: ${theme} narrow Obsidian bounds`, JSON.stringify(bounds))
    }
    if (process.env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_LIVE === '1') {
      await require(join(root, 'runtime.cjs')).run(root, await js('window.goodbuddy.capabilities.getSnapshot()'))
    }
    if (chat) {
      await click(`document.querySelector('.settings-panel__header button')`)
      window.setSize(1280, 850)
      try {
        const providers = process.env.GOODBUDDY_OBSIDIAN_ACCEPTANCE_CONTINUE_ONLY === '1' ? ['Continue'] : ['OpenCode', 'Continue']
        for (const provider of providers) {
          if (provider === 'Continue') {
            await poll(`!document.querySelector('button[title^="Runtime \u548c\u6a21\u578b"]').disabled`)
            await js(`document.querySelector('button[title^="Runtime \u548c\u6a21\u578b"]').click()`)
            await click(`Array.from(document.querySelectorAll('.runtime-picker__menu strong')).find(b=>b.innerText==='Continue Runtime')?.nextElementSibling`)
          }
          await poll(`!document.querySelector('button[title^="Runtime \u548c\u6a21\u578b"]').disabled`)
          const mode = `document.querySelector('button[aria-label^="\u5de5\u4f5c\u6a21\u5f0f"]')`
          if (!(await js(`(${mode}).innerText.includes('Execute')`))) {
            await click(mode)
            await click(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(b=>b.innerText.startsWith('Execute'))`)
          }
          const marker = `CHAT_${provider}_${require('node:crypto').randomUUID()}`
          const before = chat.observations.length
          await click(`document.querySelector('textarea')`)
          await window.webContents.insertText(`Use only Obsidian tools. Write ${provider}-chat.md containing ${marker} using obsidian_write_note, then read it using obsidian_read_note. Reply with the content read. Do not use other tools.`)
          await click(`document.querySelector('button[aria-label="\u53d1\u9001"]')`)
          await poll(`Array.from(document.querySelectorAll('.message--assistant')).some(e=>e.innerText.includes(${JSON.stringify(marker)}))`,450)
          await poll(`!document.querySelector('button[title^="Runtime \u548c\u6a21\u578b"]').disabled`,450)
          assert((require('node:fs').readFileSync(join(vault,`${provider}-chat.md`),'utf8')).includes(marker))
          console.log(JSON.stringify({ provider, fullChatUi: 'passed', realModelHttpRequests: chat.observations.length-before }))
        }
      } finally {
        console.log(JSON.stringify({ chatModelHttpRequests: chat.observations.length }))
        await chat.close()
      }
    }
    await wait(1000)
    clearTimeout(timer)
    app.exit(0)
  })().catch(error => { console.error(error); clearTimeout(timer); app.exit(1) })
}
