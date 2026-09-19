import { createCanvas } from '@napi-rs/canvas'
import { jsPDF } from 'jspdf'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import console from 'node:console'
const parent = process.argv[2]
if (!parent) throw new Error('An existing output directory is required')
const directory = await mkdtemp(join(parent, 'document-table-'))
const pdf = new jsPDF({ unit: 'pt', format: [600, 800] })
for (let page = 0; page < 2; page++) {
  const canvas = createCanvas(1200, 1600)
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'; context.fillRect(0, 0, 1200, 1600)
  context.fillStyle = '#111111'; context.font = '38px Arial'
  const top = page === 0 ? 170 : 30
  if (page === 0) context.fillText('Equipment invoice', 70, 80)
  const columns = [70, 550, 800, 1130]
  const height = (1560 - top) / 17
  context.lineWidth = 2
  for (const x of columns) { context.beginPath(); context.moveTo(x, top); context.lineTo(x, 1560); context.stroke() }
  for (let row = 0; row <= 17; row++) {
    const y = top + row * height
    context.beginPath(); context.moveTo(70, y); context.lineTo(1130, y); context.stroke()
    if (row === 17) continue
    const values = row === 0 ? ['Item', 'Quantity', 'Amount'] : [`Device ${String(page * 16 + row).padStart(3, '0')}`, '2', `${(page * 16 + row) * 100}.00`]
    context.font = '30px Arial'
    values.forEach((text, column) => context.fillText(text, columns[column] + 18, y + height * 0.63))
  }
  const bytes = await canvas.encode('png')
  await writeFile(join(directory, `table-page-${page + 1}.png`), bytes)
  if (page) pdf.addPage([600, 800])
  pdf.addImage(bytes, 'PNG', 0, 0, 600, 800)
}
await writeFile(join(directory, 'table.pdf'), Buffer.from(pdf.output('arraybuffer')))
console.log(directory)
