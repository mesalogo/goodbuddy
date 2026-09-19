import { convert } from 'html-to-text'

export function hasExtractedDocumentText(content: string): boolean {
  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[第 \d+ 页图片未保存：[^\]]*\]/gu, '')
  return Boolean(convert(text, { wordwrap: false }).trim())
}
