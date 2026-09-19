// Exploratory HTTP probe only; no product settings or user documents are read.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
const { fetch, AbortSignal } = globalThis;

async function main() {
  const { values } = parseArgs({ options: {
    endpoint: { type: 'string' }, out: { type: 'string' },
    mode: { type: 'string', default: 'discover' },
    'timeout-ms': { type: 'string', default: '60000' },
    help: { type: 'boolean', default: false }
  } });
  if (values.help) {
    console.log('node scripts/paddleocr-vl-probe.mjs --endpoint <http(s) base URL> --out <existing temp/ignored directory> [--mode discover|full] [--timeout-ms 60000]\nCreates an exclusive run directory. discover: 2 GETs; full: additionally 4 layout calls and 2 restructure calls. No retries, redirects, URL image fetches, credentials, or user files.');
    return;
  }
  if (!values.endpoint || !values.out) throw new Error('--endpoint and --out are required');
  const endpoint = new URL(values.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Use an HTTP(S) base URL without credentials, query or fragment');
  if (!['discover', 'full'].includes(values.mode)) throw new Error('Invalid mode');
  const timeout = Number(values['timeout-ms']);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('Timeout must be 1000..120000 ms');
  const parent = path.resolve(values.out);
  if (!(await fs.stat(parent)).isDirectory()) throw new Error('--out must already exist');
  const directory = await fs.mkdtemp(path.join(parent, 'paddleocr-vl-'));
  const report = { date: new Date().toISOString(), mode: values.mode, timeoutMs: timeout, calls: { get: 0, layout: 0, restructure: 0 }, checks: [], requests: [] };
  const save = (name, data) => fs.writeFile(path.join(directory, name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
  const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); };
  async function request(route, body) {
    report.calls[body ? (route === 'layout-parsing' ? 'layout' : 'restructure') : 'get']++;
    const started = Date.now();
    const record = { route, method: body ? 'POST' : 'GET' };
    report.requests.push(record);
    const response = await fetch(`${endpoint.href.replace(/\/$/, '')}/${route}`, {
      method: record.method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    record.status = response.status;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw new Error('Response exceeds 32 MiB');
      chunks.push(chunk);
    }
    record.bytes = size;
    record.durationMs = Date.now() - started;
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.errorCode !== undefined && data.errorCode !== 0) throw new Error(`${route}: service error code ${data.errorCode}`);
    return data;
  }
  try {
    const health = await request('health');
    check('health response', health !== null);
    const schema = await request('openapi.json');
    await save('openapi.json', schema);
    const schemas = schema.components?.schemas ?? {};
    await save('options.json', Object.fromEntries(Object.entries(schemas).filter(([name]) => /layout|restructure|InferRequest|^Page$|MarkdownData/i.test(name))));
    check('layout route advertised', schema.paths?.['/layout-parsing']?.post);
    check('restructure route advertised', schema.paths?.['/restructure-pages']?.post);
    if (values.mode === 'full') await runFixtures(request, save, check, report);
  } catch (error) {
    // Do not print server bodies, endpoint URLs, or arbitrary fetch errors.
    report.failure = error instanceof Error && /^(Response exceeds|layout-parsing:|restructure-pages:)/.test(error.message) ? error.message : `Probe failed (${error.name ?? 'Error'}); inspect request status and local fixture assertions`;
    process.exitCode = 1;
  } finally {
    if (report.checks.some(item => !item.passed)) process.exitCode = 1;
    await save('report.json', report);
    console.log(JSON.stringify({ directory, ...report }, null, 2));
  }
}

async function runFixtures(request, save, check, report) {
  const canvas = createCanvas(1200, 1600);
  const ctx = canvas.getContext('2d');
  function draw(page) {
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 1600);
    ctx.fillStyle = 'black'; ctx.font = '22px sans-serif';
    ctx.fillText('SYNTHETIC HEADER - GOODBUDDY LAB', 100, 55);
    ctx.font = 'bold 40px sans-serif'; ctx.fillText('GoodBuddy OCR Report', 100, 170);
    ctx.font = '30px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    ctx.fillText('Bilingual test: \u6587\u6863\u89e3\u6790\u6d4b\u8bd5', 100, 250);
    ctx.fillText(`Page ${page} body marker: Amount 1234.56 USD`, 100, 320);
    ctx.fillText('Figure 1. Synthetic landscape illustration', 100, 390);
    ctx.fillStyle = '#a7d8ed'; ctx.fillRect(150, 430, 900, 480);
    ctx.fillStyle = '#ffd35a'; ctx.beginPath(); ctx.arc(830, 535, 65, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#507e4d'; ctx.beginPath(); ctx.moveTo(150, 910); ctx.lineTo(450, 560); ctx.lineTo(740, 910); ctx.fill();
    ctx.fillStyle = '#366443'; ctx.beginPath(); ctx.moveTo(480, 910); ctx.lineTo(800, 650); ctx.lineTo(1050, 910); ctx.fill();
    ctx.fillStyle = 'black'; ctx.fillText(`Table 1${page === 2 ? ' (continued)' : ''}. Inventory`, 100, 1020);
    ctx.lineWidth = 2;
    for (let row = 0; row <= 3; row++) { ctx.beginPath(); ctx.moveTo(100, 1060 + row * 90); ctx.lineTo(1100, 1060 + row * 90); ctx.stroke(); }
    for (const x of [100, 650, 1100]) { ctx.beginPath(); ctx.moveTo(x, 1060); ctx.lineTo(x, 1330); ctx.stroke(); }
    for (const [i, cells] of [['Item', 'Quantity'], [`Sample ${page * 2 - 1}`, '12'], [`Sample ${page * 2}`, '24']].entries()) {
      ctx.fillText(cells[0], 120, 1120 + i * 90); ctx.fillText(cells[1], 680, 1120 + i * 90);
    }
    ctx.font = '22px sans-serif'; ctx.fillText('SYNTHETIC FOOTER - INTERNAL TEST', 100, 1520); ctx.fillText(String(page), 1080, 1520);
  }
  draw(1);
  const png = canvas.toBuffer('image/png');
  await save('fixture.png', png);
  const jpeg1 = canvas.toBuffer('image/jpeg');
  draw(2);
  const pdf = makePdf([jpeg1, canvas.toBuffer('image/jpeg')]);
  await save('fixture.pdf', pdf);
  async function summarize(name, data) {
    const pages = data.result?.layoutParsingResults;
    check(`${name}: page results`, Array.isArray(pages) && pages.length > 0);
    if (!Array.isArray(pages) || pages.length > 2) throw new Error('Unexpected page results');
    const summary = [];
    for (const [index, page] of pages.entries()) {
      const markdown = page.markdown?.text ?? '';
      await save(`${name}-page-${index + 1}.md`, markdown);
      const images = [];
      for (const [key, value] of Object.entries(page.markdown?.images ?? {})) {
        const item = { key, kind: typeof value };
        if (typeof value === 'string' && /^https?:\/\//i.test(value)) item.kind = 'url-not-fetched';
        else if (typeof value === 'string') {
          const encoded = value.replace(/^data:image\/[\w.+-]+;base64,/, '');
          if (/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length % 4 === 0) {
            const bytes = Buffer.from(encoded, 'base64');
            const image = await loadImage(bytes);
            item.kind = value.startsWith('data:') ? 'data-uri' : 'base64';
            item.bytes = bytes.length; item.width = image.width; item.height = image.height;
            item.sha256 = createHash('sha256').update(bytes).digest('hex');
            const extension = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'jpg' : 'png';
            item.file = `${name}-page-${index + 1}-image-${images.length + 1}.${extension}`;
            await save(item.file, bytes);
          } else item.kind = 'unrecognized-string';
        }
        item.linked = markdown.includes(key);
        images.push(item);
      }
      summary.push({ responseOrdinal: index + 1, pageIndex: page.prunedResult?.page_index ?? null, pageCount: page.prunedResult?.page_count,
        keys: Object.keys(page), prunedKeys: Object.keys(page.prunedResult ?? {}),
        labels: page.prunedResult?.parsing_res_list?.map(block => block.block_label),
        characters: markdown.length, textPreview: markdown.slice(0, 180),
        header: markdown.includes('SYNTHETIC HEADER'), footer: markdown.includes('SYNTHETIC FOOTER'),
        table: /<table|\|.*\|/.test(markdown), images });
    }
    await save(`${name}-summary.json`, summary);
    report[name] = summary;
    return pages;
  }
  async function parse(name, bytes, fileType, options = {}) {
    await save(`${name}-options.json`, { fileType, returnMarkdownImages: true, visualize: false, ...options });
    return summarize(name, await request('layout-parsing', { file: bytes.toString('base64'), fileType, returnMarkdownImages: true, visualize: false, ...options }));
  }
  const baseline = await parse('image-default', png, 1);
  check('image: body recognized', baseline[0].markdown.text.includes('1234.56'));
  check('image: Chinese recognized', baseline[0].markdown.text.includes('\u6587\u6863\u89e3\u6790\u6d4b\u8bd5'));
  check('default: header and footer omitted', !report['image-default'][0].header && !report['image-default'][0].footer);
  const retained = await parse('image-keep-labels', png, 1, { markdownIgnoreLabels: [] });
  check('keep labels: header and footer retained', retained[0].markdown.text.includes('SYNTHETIC HEADER') && retained[0].markdown.text.includes('SYNTHETIC FOOTER'));
  const filtered = await parse('image-drop-text', png, 1, { markdownIgnoreLabels: ['text', 'header', 'footer', 'number'] });
  check('ignore labels changes markdown', filtered[0].markdown.text !== retained[0].markdown.text);
  check('ignore text: body omitted', !filtered[0].markdown.text.includes('1234.56'));
  const pages = await parse('pdf', pdf, 0, { markdownIgnoreLabels: [] });
  check('PDF: two pages', pages.length === 2);
  check('PDF: page markers', pages.every((page, index) => page.markdown.text.includes(`Page ${index + 1}`)));
  check('fixture: table recognized', report.pdf.some(page => page.table));
  check('fixture: image artifact returned', [...report.pdf, ...report['image-default']].some(page => page.images.some(image => image.linked)));
  const restructureTexts = [];
  for (const enabled of [false, true]) {
    const name = `restructure-${enabled}`;
    const body = { pages: pages.map(page => ({ prunedResult: page.prunedResult, markdownImages: page.markdown.images })), mergeTables: enabled, relevelTitles: enabled };
    await save(`${name}-options.json`, { mergeTables: enabled, relevelTitles: enabled });
    const data = await request('restructure-pages', body);
    const restructured = await summarize(name, data);
    restructureTexts.push(restructured.map(page => page.markdown.text).join('\n\n'));
    check(`${name}: page markers retained`, [1, 2].every(index => restructured.some(page => page.markdown.text.includes(`Page ${index}`))));
    check(`${name}: images retained`, report[name].every(page => page.images.some(image => image.linked)));
  }
  report.restructureMarkdownChanged = restructureTexts[0] !== restructureTexts[1];
}

function makePdf(images) {
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>')];
  for (const [i, image] of images.entries()) {
    const first = 3 + i * 3;
    const stream = 'q 600 0 0 800 0 0 cm /Im0 Do Q';
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im0 ${first + 2} 0 R >> >> /Contents ${first + 1} 0 R >>`));
    objects.push(Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 1600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]));
  }
  const parts = [Buffer.from('%PDF-1.4\n')]; const offsets = []; let length = parts[0].length;
  objects.forEach((object, index) => { offsets.push(length); const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); parts.push(part); length += part.length; });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

main().catch(() => { console.error('Invalid probe arguments or output directory; use --help.'); process.exitCode = 1; });
