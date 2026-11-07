export type ComposerInputElement = HTMLTextAreaElement | HTMLDivElement

/** Editable DOM contains only text, line breaks and atomic reference spans. */
export function readComposerDom(node: Node): string {
  if (node instanceof HTMLDivElement && node.childNodes.length === 1 && node.firstChild instanceof HTMLBRElement) return ''
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof HTMLElement) {
    if (node.hasAttribute('data-composer-tail')) return ''
    if (node.dataset.referenceToken) return node.dataset.referenceToken
    if (node.tagName === 'BR') return '\n'
  }
  return Array.from(node.childNodes).map(readComposerDom).join('')
}

export function composerInputValue(element: ComposerInputElement): string {
  return element instanceof HTMLTextAreaElement ? element.value : readComposerDom(element)
}

export function composerSelection(element: ComposerInputElement): { start: number; end: number } {
  if (element instanceof HTMLTextAreaElement) return { start: element.selectionStart, end: element.selectionEnd }
  const selection = element.ownerDocument.getSelection()
  if (!selection?.rangeCount || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) {
    const end = readComposerDom(element).length
    return { start: end, end }
  }
  const range = selection.getRangeAt(0)
  const before = range.cloneRange()
  before.selectNodeContents(element)
  before.setEnd(range.startContainer, range.startOffset)
  const start = readComposerDom(before.cloneContents()).length
  before.setEnd(range.endContainer, range.endOffset)
  return { start, end: readComposerDom(before.cloneContents()).length }
}

export function composerRange(element: HTMLDivElement, start: number, end = start): Range {
  const point = (position: number): [Node, number] => {
    let remaining = position
    const visit = (node: Node): [Node, number] | undefined => {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0
        if (remaining <= length) return [node, Math.max(0, remaining)]
        remaining -= length
        return undefined
      }
      if (node instanceof HTMLElement && (node.dataset.referenceToken || node.tagName === 'BR')) {
        const length = node.dataset.referenceToken?.length ?? 1
        if (remaining <= length) {
          const parent = node.parentNode!
          const index = Array.prototype.indexOf.call(parent.childNodes, node) as number
          return [parent, index + (remaining > 0 ? 1 : 0)]
        }
        remaining -= length
        return undefined
      }
      for (const child of node.childNodes) {
        const found = visit(child)
        if (found) return found
      }
      return undefined
    }
    return visit(element) ?? [element, element.childNodes.length]
  }
  const range = element.ownerDocument.createRange()
  range.setStart(...point(start))
  range.setEnd(...point(end))
  return range
}

export function setComposerSelection(element: ComposerInputElement | null, start: number, end = start): void {
  if (!element) return
  if (element instanceof HTMLTextAreaElement) element.setSelectionRange(start, end)
  else {
    const selection = element.ownerDocument.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(composerRange(element, start, end))
  }
}
