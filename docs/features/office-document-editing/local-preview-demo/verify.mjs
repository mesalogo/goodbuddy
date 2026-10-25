// Start the demo first, then: node verify.mjs (uses installed Microsoft Edge).
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:5188')
  const ready = () => page.locator('#status').filter({ hasText: '已打开' }).waitFor()
  await ready()
  assert.ok(await page.locator('section.docx').count())
  assert.match(await page.locator('#viewer').innerText(), /项目协作方案/)
  for (const [type, name] of [['xlsx', '项目预算.xlsx'], ['pptx', '产品介绍.pptx'], ['pdf', '阅读样张.pdf']]) {
    await page.locator('#samples button').filter({ hasText: name }).click()
    await ready()
    assert.equal(await page.locator('#filename').innerText(), name)
    if (type === 'xlsx') {
      await page.getByRole('cell', { name: 'D2 9600', exact: true }).click()
      assert.match(await page.locator('.formula').innerText(), /B2\*C2/)
      await page.getByLabel('工作表', { exact: true }).selectOption('实施计划')
      assert.match(await page.locator('.sheet').innerText(), /测试团队/)
    } else if (type === 'pptx') {
      await page.locator('.ppt-host').filter({ hasText: '文档，就在工作区' }).waitFor()
      assert.match(await page.locator('.ppt-host').innerText(), /文档，就在工作区/)
    } else {
      assert.ok(await page.locator('canvas').evaluate(el => el.width > 0))
      await page.getByRole('button', { name: '下一页', exact: true }).click()
      await page.locator('.pdf-controls').filter({ hasText: '2 / 3' }).waitFor()
      await page.getByLabel('PDF 缩放').selectOption('1.5')
      await page.waitForFunction(() => !document.querySelector('.pdf-controls select').disabled)
    }
    console.log(`PASS ${type} sample and controls`)
  }
  // Feed real binaries through the file input; sample shortcuts are not sufficient.
  for (const type of ['docx', 'xlsx', 'pptx', 'pdf']) {
    const bytes = await page.evaluate(async type => {
      const { createSample } = await import('/samples.js')
      return Array.from(new Uint8Array(await (await createSample(type)).arrayBuffer()))
    }, type)
    await page.locator('#file').setInputFiles({ name: `imported.${type}`, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })
    await ready()
    assert.equal(await page.locator('#filename').innerText(), `imported.${type}`)
    console.log(`PASS ${type} real file input`)
  }
  await page.locator('#file').setInputFiles({ name: 'broken.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid zip') })
  await page.getByRole('button', { name: '重新尝试' }).waitFor()
  await page.getByRole('button', { name: '关闭 broken.docx', exact: true }).click()
  await ready()
  await page.getByRole('button', { name: '切换浅色或深色主题' }).click()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  await page.getByRole('button', { name: '展开阅读', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '收起阅读' }).getAttribute('aria-pressed'), 'true')
  await page.setViewportSize({ width: 600, height: 900 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.deepEqual(errors, [])
  console.log('PASS damaged file, close, theme, expanded reading, narrow layout; no uncaught browser errors')
} finally {
  await browser.close()
}
