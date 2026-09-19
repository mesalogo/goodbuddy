import { describe, expect, it } from 'vitest'
import { hasExtractedDocumentText } from './document-extracted-text'

describe('extracted document text', () => {
  it.each([
    '',
    ' \n ',
    '![第 1 页图片](asset:image)',
    '[第 1 页图片未保存：未返回内联图片字节]',
    '![第 1 页图片](asset:image)\n[第 1 页图片未保存：图片格式不支持]',
    '<p>&nbsp;</p>\n[第 2 页图片未保存：Base64 无效]'
  ])('does not count image references or generated warnings as text: %s', (content) => {
    expect(hasExtractedDocumentText(content)).toBe(false)
  })

  it.each([
    'Recognized text',
    '![第 1 页图片](asset:image)\n实际正文\n[第 1 页图片未保存：Base64 无效]',
    '<table><tr><td>实际表格</td></tr></table>'
  ])('retains recognized text: %s', (content) => {
    expect(hasExtractedDocumentText(content)).toBe(true)
  })
})
