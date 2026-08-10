import { describe, expect, it } from 'vitest'
import {
  maximumPastedImageBytes,
  pastedImageInputSchema
} from './contracts'

describe('context contracts', () => {
  it('accepts bounded pasted image bytes in supported formats', () => {
    expect(
      pastedImageInputSchema.safeParse({
        data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        mimeType: 'image/png'
      }).success
    ).toBe(true)
  })

  it('rejects empty, oversized, and unsupported pasted images', () => {
    expect(
      pastedImageInputSchema.safeParse({
        data: new Uint8Array(),
        mimeType: 'image/png'
      }).success
    ).toBe(false)
    expect(
      pastedImageInputSchema.safeParse({
        data: new Uint8Array(maximumPastedImageBytes + 1),
        mimeType: 'image/png'
      }).success
    ).toBe(false)
    expect(
      pastedImageInputSchema.safeParse({
        data: Uint8Array.from([1]),
        mimeType: 'image/gif'
      }).success
    ).toBe(false)
  })
})
