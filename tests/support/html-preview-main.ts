import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { registerHtmlPreviewProtocol } from '../../src/main/html-preview-protocol'

app.setPath('userData', process.env.GB_HTML_DIRECTORY!)
app.whenReady().then(async () => {
  registerHtmlPreviewProtocol()
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    await win.loadURL(process.env.GB_HTML_URL!)
    for (let attempt = 0; attempt < 200; attempt++) {
      const frame = win.webContents.mainFrame.frames[0]
      if (frame && await frame.executeJavaScript('document.body?.dataset.network === "connected"')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const frame = win.webContents.mainFrame.frames[0]!
    assert(frame, 'Preview must load')
    assert.deepEqual(await frame.executeJavaScript(`({ ...document.body.dataset })`), {
      inline: 'yes', external: 'yes', isolated: 'yes', network: 'connected'
    })
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).color'), 'rgb(1, 2, 3)')
    assert.equal(await frame.executeJavaScript('document.querySelector("img").naturalWidth'), 10)
    assert.equal(await frame.executeJavaScript('typeof window.goodbuddy'), 'undefined')
    assert.equal(await frame.executeJavaScript('typeof require'), 'undefined')
    await frame.executeJavaScript('document.querySelector("button").click()')
    assert.equal(await frame.executeJavaScript('document.querySelector("button").textContent'), 'Clicked')
    assert.equal(await win.webContents.executeJavaScript('document.body.dataset.escaped'), undefined)
    console.log('HTML preview: inline/external scripts, events, CSS, images, fetch and app isolation passed')
  } finally { win.destroy() }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
