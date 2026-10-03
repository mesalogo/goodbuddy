import { createLazyRequire } from './lazy-require'

/**
 * Loads html-to-text on first use instead of at Main startup (P6, ~45 ms).
 * Synchronous so the text checks keep their signatures.
 */
export const loadHtmlToText =
  createLazyRequire<typeof import('html-to-text')>('html-to-text')

export function hasExtractedDocumentText(content: string): boolean {
  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[第 \d+ 页图片未保存：[^\]]*\]/gu, '')
  return Boolean(loadHtmlToText().convert(text, { wordwrap: false }).trim())
}
