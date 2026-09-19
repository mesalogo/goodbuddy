import type { MagicNoteCanvasContent } from './magic-notes-contracts'

export function magicNoteCanvasAnalysisText(content: MagicNoteCanvasContent): string {
  const flowText = (content.flow?.ops ?? [])
    .map(({ insert }) => typeof insert === 'string' ? insert : '')
    .join('').trim()
  return [
    flowText ? `连续正文（跨页）：\n${flowText}` : '',
    ...content.pages.map((page, index) => {
      const text = magicNoteCanvasPlainText({ ...content, flow: undefined, pages: [page] })
      return text ? `第 ${index + 1} 页：\n${text}` : ''
    })
  ].filter(Boolean).join('\n\n')
}

// Keep canvas text comparisons identical in the renderer and persistence layer.
export function magicNoteCanvasPlainText(content: MagicNoteCanvasContent): string {
  const flow = (content.flow?.ops ?? []).map(({ insert }) => {
    if (typeof insert === 'string') return insert
    if ('canvasPageBreak' in insert) return '\n'
    if ('image' in insert) return '[图片]'
    for (const [key, label] of [['localVideo', '视频'], ['attachment', '附件']] as const) {
      const value = insert[key]
      if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return `[${label}：${value.name}]`
    }
    return '[嵌入内容]'
  }).join('').replace(/\n{3,}/g, '\n\n').trim()
  const text = [flow]
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'text' || key === 'insert') && typeof child === 'string') text.push(child)
      else if (typeof child === 'object') visit(child)
    }
  }
  for (const page of content.pages) {
    if (page.background.type === 'pdf' && page.background.text) text.push(page.background.text)
    visit(page.objects)
  }
  return text.filter(Boolean).join('\n').trim()
}
