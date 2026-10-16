/** Styles that affect where text wraps inside a textarea. */
const mirroredProperties = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize'
] as const

/**
 * Position of a character inside a textarea, relative to the textarea's
 * border box and already adjusted for its scroll offset. Measured with a
 * hidden mirror element that wraps text the same way.
 */
export function textareaCaretPosition(
  textarea: HTMLTextAreaElement,
  position: number
): { top: number; left: number; height: number } {
  const style = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  const target = mirror.style
  for (const property of mirroredProperties) target[property] = style[property]
  target.position = 'absolute'
  target.visibility = 'hidden'
  target.top = '0'
  target.left = '-9999px'
  target.whiteSpace = 'pre-wrap'
  target.overflowWrap = 'break-word'
  target.overflow = 'hidden'
  target.height = 'auto'
  mirror.textContent = textarea.value.slice(0, position)
  const marker = document.createElement('span')
  marker.textContent = textarea.value.slice(position, position + 1) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 18
  const result = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    height: lineHeight
  }
  mirror.remove()
  return result
}
