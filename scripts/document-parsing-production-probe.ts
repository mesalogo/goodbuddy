import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DocumentParsingService } from '../src/main/document-parsing-service'
import { DocumentParsingSettingsStore, defaultDocumentParsingSettings } from '../src/main/document-parsing-settings-store'
import { DocumentOcrModelManager } from '../src/main/document-ocr-model-manager'
import type { DocumentOcrBroker } from '../src/main/document-ocr-broker'
import { defaultHttpOcrSettings } from '../src/shared/document-parsing-contracts'

const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, fixture: { type: 'string' }, out: { type: 'string' }, table: { type: 'boolean' }, timeout: { type: 'string' }
} })
if (!values.endpoint || !values.fixture || !values.out) throw new Error('--endpoint, --fixture (synthetic PDF), --out required')
const root = await mkdtemp(join(values.out, 'document-production-'))
const counts = { get: 0, layout: 0, restructure: 0 }
const fetchOriginal = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.endsWith('/layout-parsing')) counts.layout++
  else if (url.endsWith('/restructure-pages')) counts.restructure++
  else counts.get++
  await writeFile(join(root, 'calls.json'), JSON.stringify(counts))
  console.log(JSON.stringify({ dispatch: url.slice(url.lastIndexOf('/')), counts }))
  return fetchOriginal(input, init)
}
const settings = new DocumentParsingSettingsStore(join(root, 'settings.json'))
const models = new DocumentOcrModelManager({ userDataDirectory: root, fetch: globalThis.fetch, getDownloadSource: async () => 'modelscope' })
// HTTP must not use the Renderer broker or installed local weights.
const service = new DocumentParsingService(settings, models, undefined as unknown as DocumentOcrBroker)
const report: Record<string, unknown> = { counts, root }
try {
  await settings.update({ ...defaultDocumentParsingSettings, ocrProvider: 'paddleocr-vl',
    httpOcr: { ...defaultHttpOcrSettings, baseUrl: values.endpoint, filterMode: 'all', timeoutSeconds: Number(values.timeout ?? 60) }, chatWorkflow: 'high-fidelity' })
  const buffer = await readFile(values.fixture)
  const high = await service.parse('synthetic.pdf', buffer, 'chat-attachment')
  if (!high.content || (!values.table && !high.images?.length) || high.sections.some((section) => section.confidence !== undefined)) throw new Error('Unexpected high-fidelity result')
  report.high = { pages: high.pageCount, characters: high.content.length, images: high.images?.length ?? 0 }
  if (values.table) {
    await settings.update({ ...(await settings.get()), httpOcr: { ...defaultHttpOcrSettings, baseUrl: values.endpoint, filterMode: 'all', timeoutSeconds: Number(values.timeout ?? 60), mergeTables: true, relevelTitles: true } })
    const merged = await service.parse('table.pdf', buffer, 'chat-attachment')
    report.restructure = { ...merged.restructure, tablesBefore: (high.content.match(/<table/gu) ?? []).length, tablesAfter: (merged.content.match(/<table/gu) ?? []).length, sections: merged.sections.map(section => ({ locator: section.locator, sourcePages: section.sourcePages })), warnings: merged.warnings }
    await writeFile(join(root, 'before.md'), high.content)
    await writeFile(join(root, 'after.md'), merged.content)
  } else {
  await settings.update({ ...(await settings.get()), chatWorkflow: 'auto' })
  const auto = await service.parse('synthetic.pdf', buffer, 'chat-attachment')
  if (!auto.images?.length || auto.sections.length !== high.sections.length) throw new Error('Unexpected auto result')
  report.auto = { pages: auto.pageCount, characters: auto.content.length, images: auto.images.length }
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : 'Unknown failure'
  process.exitCode = 1
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
