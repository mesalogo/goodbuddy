// @vitest-environment node
import { Context } from '@deepseek-ai/cordis'
import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { GoodBuddyHarnessAttachmentStore } from './goodbuddy-harness-attachment-store'

const canvas = createCanvas(1, 1)
const transparentPng = canvas.toBuffer('image/png')
const jpeg = canvas.toBuffer('image/jpeg')
const secondPng = createCanvas(2, 1).toBuffer('image/png')
const overwidePng = createCanvas(8_193, 1).toBuffer('image/png')

describe('GoodBuddy Harness attachment store', () => {
  it('decodes, stores, verifies, and releases inline images', async () => {
    const store = new GoodBuddyHarnessAttachmentStore(new Context())
    const input = {
      data: transparentPng,
      mediaType: 'image/png' as const,
      name: '..\\screenshots\\reference.png'
    }

    const first = await store.saveImage(input)
    const second = await store.saveImage(input)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      mediaType: 'image/png',
      bytes: transparentPng.byteLength,
      width: 1,
      height: 1,
      name: 'reference.png'
    })
    const stored = await store.readImage(first)
    expect(stored.ref).toBe(first)
    expect(Buffer.from(stored.data).equals(transparentPng)).toBe(true)
    await expect(
      store.readImage({
        ...first,
        width: first.width + 1
      })
    ).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })

    store.releaseImage(first)
    await expect(store.readImage(first)).resolves.toBeDefined()
    store.releaseImage(second)
    await expect(store.readImage(first)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND'
    })

    const jpegRef = await store.saveImage({
      data: jpeg,
      mediaType: 'image/jpeg'
    })
    expect(jpegRef).toMatchObject({
      mediaType: 'image/jpeg',
      bytes: jpeg.byteLength,
      width: 1,
      height: 1
    })
  })

  it('rejects mismatched, malformed, and over-capacity images', async () => {
    const store = new GoodBuddyHarnessAttachmentStore(new Context(), {
      maxStoredImages: 1
    })

    await expect(
      store.saveImage({
        data: transparentPng,
        mediaType: 'image/jpeg'
      })
    ).rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
    await expect(
      store.saveImage({
        data: Buffer.from([
          0x89, 0x50, 0x4e, 0x47,
          0x0d, 0x0a, 0x1a, 0x0a
        ]),
        mediaType: 'image/png'
      })
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    const corruptPng = Buffer.from(transparentPng)
    corruptPng[corruptPng.length - 8] =
      (corruptPng[corruptPng.length - 8] ?? 0) ^ 1
    await expect(
      store.saveImage({
        data: corruptPng,
        mediaType: 'image/png'
      })
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(
      store.saveImage({
        data: overwidePng,
        mediaType: 'image/png'
      })
    ).rejects.toMatchObject({
      code: 'IMAGE_DIMENSION_TOO_LARGE'
    })

    await store.saveImage({
      data: transparentPng,
      mediaType: 'image/png'
    })
    await expect(
      store.saveImage({
        data: secondPng,
        mediaType: 'image/png'
      })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
  })

  it('does not retain a partial batch when capacity is exceeded', async () => {
    const store = new GoodBuddyHarnessAttachmentStore(new Context(), {
      maxStoredImages: 1
    })

    await expect(
      store.saveImages([
        { data: transparentPng, mediaType: 'image/png' },
        { data: jpeg, mediaType: 'image/jpeg' }
      ])
    ).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    await expect(
      store.saveImage({
        data: jpeg,
        mediaType: 'image/jpeg'
      })
    ).resolves.toMatchObject({ mediaType: 'image/jpeg' })
  })

  it('bounds aggregate decoded pixels before retaining a batch', async () => {
    const store = new GoodBuddyHarnessAttachmentStore(new Context(), {
      maxBatchImagePixels: 1
    })
    const input = {
      data: transparentPng,
      mediaType: 'image/png' as const
    }

    await expect(
      store.saveImages([input, input])
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(store.saveImage(input)).resolves.toMatchObject({
      width: 1,
      height: 1
    })
  })

  it('enforces the upstream per-message image count', async () => {
    const store = new GoodBuddyHarnessAttachmentStore(new Context())
    const input = {
      data: transparentPng,
      mediaType: 'image/png' as const
    }

    await expect(
      store.saveImages(
        Array.from(
          { length: store.imageLimits.maxImagesPerMessage + 1 },
          () => input
        )
      )
    ).rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })
  })
})