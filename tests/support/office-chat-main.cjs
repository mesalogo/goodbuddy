const { app, dialog } = require('electron')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const root = process.env.GB_OFFICE_PROBE_ROOT
const repo = resolve(__dirname, '../..')
app.setName('goodbuddy')
app.setPath('userData', join(root, 'user-data'))
app.getAppPath = () => repo
app.getVersion = () => JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
app.commandLine.appendSwitch('remote-debugging-port', '19223')
app.on('browser-window-created', (_event, window) => {
  window.setBounds({ width: 1600, height: 1000 })
  window.webContents.on('did-fail-load', (_event, code, description, url) => console.log('OfficeChat load failure:', code, description, url))
  window.webContents.on('render-process-gone', (_event, details) => console.log('OfficeChat render exit:', details))
})
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [join(root, 'source.docx')] })
dialog.showMessageBox = async (_window, options) => ({ response: options.type === 'error' ? 0 : 1 })
void import(pathToFileURL(join(repo, 'out/main/index.js')).href).catch(error => {
  console.error(error)
  app.exit(1)
})
