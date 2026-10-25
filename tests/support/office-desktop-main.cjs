const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { join } = require('node:path')
const root = process.env.GB_OFFICE_PROBE_ROOT
const filename = process.env.GB_OFFICE_PROBE_FILENAME || 'source.docx'
const { OfficeService, registerOfficeIpc } = require(join(root, 'service.cjs'))
app.setPath('userData', join(root, 'user-data'))
app.commandLine.appendSwitch('remote-debugging-port', '19222')
app.whenReady().then(async () => {
  ipcMain.on('office-probe:quit', () => { setTimeout(() => app.quit(), 100) })
  ipcMain.handle('office-probe:connection', () => ({ serverUrl: process.env.GB_OFFICE_PROBE_WEB }))
  let lastError = ''
  const keys = []
  app.on('web-contents-created', (_event, contents) => contents.on('before-input-event', (_event, input) => {
    if (input.key.toLowerCase() === 's') keys.push({ type: input.type, key: input.key, control: input.control, shift: input.shift, alt: input.alt, url: contents.getURL(), busy: [...(service?.sessions.values() ?? [])].some(s => s.busy) })
  }))
  ipcMain.handle('office-probe:error', () => lastError)
  let service
  let saveDialogs = 0
  ipcMain.handle('office-probe:diagnostics', () => ({ lastError, keys, saveDialogs, sessions: [...service.sessions.values()].map(s => ({ busy: s.busy, path: s.path })) }))
  const window = new BrowserWindow({ width: 1440, height: 1000, webPreferences: {
    preload: join(__dirname, 'office-desktop-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false
  } })
  ipcMain.handle('office-probe:save-key', async (_event, saveAs) => {
    for (let attempt = 0; attempt < 100 && [...service.sessions.values()].some(s => s.busy); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    if ([...service.sessions.values()].some(s => s.busy)) throw new Error('Previous save has not settled')
    const editor = window.contentView.children.find(view => view.webContents?.getURL().includes('/office/editor?'))
    if (!editor) throw new Error('Editor view missing')
    window.focus(); editor.webContents.focus()
    for (let attempt = 0; attempt < 100 && !editor.webContents.isFocused(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    if (!editor.webContents.isFocused()) throw new Error('Editor did not acquire focus')
    const modifiers = ['control', ...(saveAs ? ['shift'] : [])]
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers })
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers })
  })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [join(root, filename)] })
  dialog.showSaveDialog = async () => { saveDialogs++; return { canceled: false, filePath: join(root, 'export.docx') } }
  dialog.showMessageBox = async (_window, options) => { if (options.type === 'error') lastError = options.detail; return { response: options.type === 'error' ? 0 : 1 } }
  service = new OfficeService(window, join(root, 'office-file-worker.js'), async () => ({ path: join(root, filename) }))
  registerOfficeIpc(window, service)
  await window.loadFile(join(root, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
