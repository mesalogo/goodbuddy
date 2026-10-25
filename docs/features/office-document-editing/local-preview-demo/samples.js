// Real binary documents: every sample uses exactly the same parser as an imported file.
export const samples = [
  { type: 'docx', name: '项目协作方案.docx', detail: 'Word · 段落 / 表格 / 分页', icon: 'W' },
  { type: 'xlsx', name: '项目预算.xlsx', detail: 'Excel · 工作表 / 单元格 / 公式', icon: 'X' },
  { type: 'pptx', name: '产品介绍.pptx', detail: 'PowerPoint · 实验预览', icon: 'P' },
  { type: 'pdf', name: '阅读样张.pdf', detail: 'PDF · 分页 / 缩放', icon: 'F' }
]

export async function createSample(type) {
  if (type === 'docx') {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } = await import('docx')
    const paragraph = (text) => new Paragraph({ children: [new TextRun(text)], spacing: { after: 240 } })
    const table = new Table({ rows: [['阶段', '交付内容', '预计时间'], ['本地阅读', 'DOCX、XLSX、PDF 预览', '第 1 阶段'], ['演示文稿', 'PPTX 兼容性评估', '第 2 阶段'], ['协同编辑', 'ONLYOFFICE 接入', '第 3 阶段']].map(row => new TableRow({ children: row.map(text => new TableCell({ children: [paragraph(text)] })) })) })
    return Packer.toBlob(new Document({ sections: [{ children: [
      new Paragraph({ text: '项目协作方案', heading: HeadingLevel.TITLE }),
      paragraph('GOODBUDDY  /  OFFICE WORKSPACE  /  2026'),
      new Paragraph({ text: '01  阅读先行，编辑按需', heading: HeadingLevel.HEADING_1 }),
      paragraph('在对话中收到一份方案后，点击文件即可在右侧工作区阅读。当前会话保留在左侧，文档以文件名打开独立页签。'),
      paragraph('本地预览通过浏览器解析文档。无需连接 ShareServer，也无需安装 Microsoft Office。需要协同编辑时，再进入 ONLYOFFICE 编辑会话。'),
      new Paragraph({ text: '02  分阶段验证', heading: HeadingLevel.HEADING_1 }), table,
      paragraph('样例中的文字和表格来自真实 DOCX 文件，可以下载后使用 Word 或 LibreOffice 对照查看。'),
      new Paragraph({ text: '03  需要关注的版式', pageBreakBefore: true, heading: HeadingLevel.HEADING_1 }),
      paragraph('请用实际业务文件检查页眉页脚、跨页表格、浮动图片、字体替换和目录。浏览器预览的分页可能与 Microsoft Word 不同。'),
      paragraph('这是一份演示文档。预览不修改源文件，文档编辑与保存仍属于后续集成范围。')
    ] }] }))
  }
  if (type === 'xlsx') {
    const XLSX = await import('xlsx')
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([['项目', '数量', '单价（元）', '金额（元）'], ['设计与交互', 8, 1200, 9600], ['文档预览开发', 15, 1600, 24000], ['兼容性验证', 6, 1400, 8400], ['合计', '', '', 42000]])
    sheet.D2.f = 'B2*C2'; sheet.D3.f = 'B3*C3'; sheet.D4.f = 'B4*C4'; sheet.D5.f = 'SUM(D2:D4)'
    XLSX.utils.book_append_sheet(book, sheet, '预算明细')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['里程碑', '负责人', '状态'], ['阅读 Demo', '产品与研发', '评审中'], ['真实文件验证', '测试团队', '待开始'], ['编辑能力', '平台团队', '设计中']]), '实施计划')
    return new Blob([XLSX.write(book, { type: 'array', bookType: 'xlsx' })])
  }
  if (type === 'pptx') {
    const { default: PptxGenJS } = await import('pptxgenjs')
    const deck = new PptxGenJS(); deck.layout = 'LAYOUT_WIDE'; deck.author = 'GoodBuddy Demo'
    for (const [i, title, body] of [[1, '文档，就在工作区', 'GOODBUDDY  /  LOCAL OFFICE PREVIEW'], [2, '阅读与编辑分开接入', '本地阅读：浏览器解析文件\n协同编辑：ShareServer + ONLYOFFICE'], [3, '用真实文件验证效果', '检查字体、图片、母版、图表和复杂形状\n动画与切换效果不作为本地预览验收目标']]) {
      const slide = deck.addSlide(); slide.background = { color: 'EFF4FA' }
      slide.addText(`0${i}  /  OFFICE WORKSPACE`, { x: .8, y: .7, w: 10, h: .4, fontSize: 14, color: '315FC5' })
      slide.addText(title, { x: .8, y: 2, w: 11.6, h: 1, fontSize: 36, bold: true, color: '23334D', fontFace: 'Microsoft YaHei' })
      slide.addText(body, { x: .8, y: 3.5, w: 11.6, h: 1.3, fontSize: 20, color: '5B6B83', fontFace: 'Microsoft YaHei' })
      slide.addText('GoodBuddy  ·  本地预览实验', { x: .8, y: 6.6, w: 10, h: .3, fontSize: 12, color: '5B6B83' })
    }
    // PptxGenJS 4.0.1 declares one master per slide but writes only master1.
    // Remove dangling declarations from this generated fixture, not from user files.
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(await deck.write({ outputType: 'arraybuffer' }))
    const manifest = await zip.file('[Content_Types].xml').async('text')
    zip.file('[Content_Types].xml', manifest.replace(/<Override PartName="([^"]+)"[^>]*\/>/g, (entry, path) => zip.file(path.slice(1)) ? entry : ''))
    return zip.generateAsync({ type: 'blob' })
  }
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF()
  for (let i = 1; i <= 3; i++) {
    if (i > 1) pdf.addPage()
    pdf.setTextColor('#315fc5'); pdf.setFontSize(12); pdf.text('GOODBUDDY / LOCAL DOCUMENTS', 24, 28)
    pdf.setTextColor('#23334d'); pdf.setFontSize(28); pdf.text(['Read in your workspace', 'Keep the conversation', 'Edit when you need to'][i - 1], 24, 65)
    pdf.setFontSize(12); pdf.text('This is a real PDF rendered locally with PDF.js.', 24, 90)
    pdf.text('Use the page and zoom controls to explore this sample.', 24, 100)
    pdf.setFillColor('#eaf0ff'); pdf.roundedRect(24, 120, 162, 70, 4, 4, 'F')
    pdf.text('DOCX  /  XLSX  /  PPTX  /  PDF', 36, 146)
    pdf.text('Local preview first. ONLYOFFICE editing later.', 36, 166)
    pdf.setFontSize(10); pdf.text(`${i} / 3`, 176, 275)
  }
  return pdf.output('blob')
}
