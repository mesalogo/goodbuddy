const { app, BrowserWindow, dialog } = require('electron')
const { join } = require('node:path')
const root = process.env.GB_OFFICE_PROBE_ROOT
const { OfficeService, registerOfficeIpc } = require(join(root, 'service.cjs'))
app.setPath('userData', join(root, 'user-data'))
app.commandLine.appendSwitch('remote-debugging-port', '19222')
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 1000, webPreferences: {
    preload: join(__dirname, 'office-desktop-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false
  } })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [join(root, 'source.docx')] })
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(root, 'export.docx') })
  dialog.showMessageBox = async (_window, options) => ({ response: options.type === 'error' ? 0 : 1 })
  registerOfficeIpc(window, new OfficeService(window, join(root, 'office-file-worker.js')))
  await window.loadFile(join(root, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
