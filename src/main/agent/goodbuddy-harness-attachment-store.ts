import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { crc32 } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageMediaType,
  type SaveImageAttachment,
  type StoredImageAttachment
} from '@deepseek-ai/dsh-attachment'

const DEFAULT_MAX_STORE_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_STORED_IMAGES = 256
const DEFAULT_MAX_BATCH_IMAGE_PIXELS = 32_000_000

export const GOODBUDDY_HARNESS_IMAGE_LIMITS: ImageAttachmentLimits =
  Object.freeze({
    maxImageBytes: 1024 * 1024,
    maxImagesPerMessage: 8,
    maxMessageImageBytes: 2 * 1024 * 1024,
    maxImagePixels: 16_000_000,
    mediaTypes: Object.freeze([
      'image/png',
      'image/jpeg'
    ] satisfies ImageMediaType[])
  })

type StoredImage = {
  ref: ImageAttachmentRef
  data: Buffer
  references: number
}

type InspectedImage = {
  data: Buffer
  width: number
  height: number
}

export type GoodBuddyHarnessAttachmentStoreConfig = {
  maxStoreBytes?: number
  maxStoredImages?: number
  maxBatchImagePixels?: number
}

function invalidImage(message: string, cause?: unknown): AttachmentError {
  return new AttachmentError(message, 'INVALID_IMAGE', {
    ...(cause === undefined ? {} : { cause })
  })
}

function safeImageName(name: string | undefined): string | undefined {
  if (!name) {
    return undefined
  }
  const safe = basename(name.replaceAll('\\', '/'))
    .replace(/\p{Cc}/gu, '_')
    .trim()
    .slice(0, 200)
  return safe || undefined
}

function matchesSignature(
  data: Buffer,
  mediaType: ImageMediaType
): boolean {
  if (mediaType === 'image/png') {
    return (
      data.length >= 8 &&
      data.subarray(0, 8).equals(
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47,
          0x0d, 0x0a, 0x1a, 0x0a
        ])
      )
    )
  }
  return (
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data.at(-2) === 0xff &&
    data.at(-1) === 0xd9
  )
}

function pngDimensions(data: Buffer): {
  width: number
  height: number
} | undefined {
  let offset = 8
  let chunks = 0
  let width: number | undefined
  let height: number | undefined
  let sawImageData = false
  while (offset + 12 <= data.length && chunks < 256) {
    chunks += 1
    const length = data.readUInt32BE(offset)
    const typeStart = offset + 4
    const dataStart = typeStart + 4
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (dataEnd < dataStart || chunkEnd > data.length) {
      return undefined
    }
    const typeBytes = data.subarray(typeStart, dataStart)
    const type = typeBytes.toString('ascii')
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      return undefined
    }
    if (
      crc32(data.subarray(typeStart, dataEnd)) !==
      data.readUInt32BE(dataEnd)
    ) {
      return undefined
    }
    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) {
        return undefined
      }
      width = data.readUInt32BE(dataStart)
      height = data.readUInt32BE(dataStart + 4)
    } else if (type === 'IHDR') {
      return undefined
    }
    if (type === 'IDAT') {
      sawImageData = true
    }
    if (type === 'IEND') {
      return (
        length === 0 &&
        chunkEnd === data.length &&
        sawImageData &&
        width !== undefined &&
        height !== undefined
      )
        ? { width, height }
        : undefined
    }
    offset = chunkEnd
  }
  return undefined
}

function jpegDimensions(data: Buffer): {
  width: number
  height: number
} | undefined {
  let offset = 2
  while (offset + 4 <= data.length - 2) {
    if (data[offset] !== 0xff) {
      return undefined
    }
    while (data[offset] === 0xff) {
      offset += 1
    }
    const marker = data[offset]
    offset += 1
    if (marker === undefined || marker === 0x00 || marker === 0xd9) {
      return undefined
    }
    if (marker === 0xda) {
      return undefined
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue
    }
    if (offset + 2 > data.length - 2) {
      return undefined
    }
    const length = data.readUInt16BE(offset)
    if (length < 2 || offset + length > data.length - 2) {
      return undefined
    }
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    if (isStartOfFrame) {
      if (length < 7) {
        return undefined
      }
      return {
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5)
      }
    }
    offset += length
  }
  return undefined
}

async function inspectImage(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits
): Promise<InspectedImage> {
  if (!limits.mediaTypes.includes(input.mediaType)) {
    throw invalidImage('Image media type is not supported')
  }
  if (
    input.data.byteLength === 0 ||
    input.data.byteLength > limits.maxImageBytes
  ) {
    throw invalidImage('Image exceeds the per-image byte limit')
  }
  const data = Buffer.from(input.data)
  if (!matchesSignature(data, input.mediaType)) {
    throw invalidImage('Image media type does not match its bytes')
  }
  const encodedDimensions =
    input.mediaType === 'image/png'
      ? pngDimensions(data)
      : jpegDimensions(data)
  if (!encodedDimensions) {
    throw invalidImage('Image container is malformed')
  }
  if (
    encodedDimensions.width < 1 ||
    encodedDimensions.height < 1 ||
    encodedDimensions.width * encodedDimensions.height >
      limits.maxImagePixels
  ) {
    throw invalidImage('Image dimensions exceed the pixel limit')
  }
  let width: number
  let height: number
  let loadImage: typeof import('@napi-rs/canvas')['loadImage']
  try {
    const canvas = await import('@napi-rs/canvas')
    loadImage = canvas.loadImage
  } catch (error) {
    throw new AttachmentError(
      'Harness image decoder is unavailable',
      'DECODER_UNAVAILABLE',
      { cause: error }
    )
  }
  try {
    const image = await loadImage(data)
    width = image.naturalWidth || image.width
    height = image.naturalHeight || image.height
  } catch (error) {
    throw invalidImage('Image bytes could not be decoded', error)
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > limits.maxImagePixels ||
    width !== encodedDimensions.width ||
    height !== encodedDimensions.height
  ) {
    throw invalidImage('Image dimensions exceed the pixel limit')
  }
  return { data, width, height }
}

/**
 * Process-local attachment storage for the non-persistent Harness sessions.
 * Images are fully decoded before an immutable content-addressed reference is
 * published. The store is bounded independently of per-message admission.
 */
export class GoodBuddyHarnessAttachmentStore extends AttachmentStore {
  readonly imageLimits = GOODBUDDY_HARNESS_IMAGE_LIMITS
  private readonly images = new Map<string, StoredImage>()
  private readonly maxBatchImagePixels: number
  private readonly maxStoreBytes: number
  private readonly maxStoredImages: number
  private storedBytes = 0

  constructor(
    ctx: Context,
    config: GoodBuddyHarnessAttachmentStoreConfig = {}
  ) {
    super(ctx)
    this.maxStoreBytes =
      config.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES
    this.maxStoredImages =
      config.maxStoredImages ?? DEFAULT_MAX_STORED_IMAGES
    this.maxBatchImagePixels =
      config.maxBatchImagePixels ??
      DEFAULT_MAX_BATCH_IMAGE_PIXELS
    if (
      !Number.isSafeInteger(this.maxStoreBytes) ||
      this.maxStoreBytes < this.imageLimits.maxImageBytes ||
      !Number.isSafeInteger(this.maxStoredImages) ||
      this.maxStoredImages < 1 ||
      !Number.isSafeInteger(this.maxBatchImagePixels) ||
      this.maxBatchImagePixels < 1
    ) {
      throw new TypeError(
        'GoodBuddy Harness attachment-store limits are invalid'
      )
    }
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await inspectImage(input, this.imageLimits)
  }

  async saveImage(
    input: SaveImageAttachment
  ): Promise<ImageAttachmentRef> {
    return (await this.saveImages([input]))[0]!
  }

  async saveImages(
    inputs: readonly SaveImageAttachment[]
  ): Promise<ImageAttachmentRef[]> {
    const inspectedByContent = new Map<string, InspectedImage>()
    const candidates: Array<{
      input: SaveImageAttachment
      inspected: InspectedImage
      attachmentId: ImageAttachmentRef['attachmentId']
    }> = []
    let batchPixels = 0
    for (const input of inputs) {
      if (
        !this.imageLimits.mediaTypes.includes(input.mediaType) ||
        input.data.byteLength === 0 ||
        input.data.byteLength > this.imageLimits.maxImageBytes
      ) {
        throw invalidImage('Image exceeds the attachment limits')
      }
      const digest = createHash('sha256')
        .update(input.data)
        .digest('hex')
      const contentKey = `${input.mediaType}:${digest}`
      let inspected = inspectedByContent.get(contentKey)
      if (!inspected) {
        inspected = await inspectImage(input, this.imageLimits)
        inspectedByContent.set(contentKey, inspected)
      }
      batchPixels += inspected.width * inspected.height
      if (batchPixels > this.maxBatchImagePixels) {
        throw invalidImage('Images exceed the batch pixel limit')
      }
      candidates.push({
        input,
        inspected,
        attachmentId: AttachmentId(`sha256:${digest}`)
      })
    }
    const additions = new Map<
      ImageAttachmentRef['attachmentId'],
      InspectedImage
    >()
    for (const candidate of candidates) {
      if (
        !this.images.has(candidate.attachmentId) &&
        !additions.has(candidate.attachmentId)
      ) {
        additions.set(candidate.attachmentId, candidate.inspected)
      }
    }
    const additionalBytes = [...additions.values()].reduce(
      (total, inspected) => total + inspected.data.byteLength,
      0
    )
    if (
      this.images.size + additions.size > this.maxStoredImages ||
      this.storedBytes + additionalBytes > this.maxStoreBytes
    ) {
      throw new AttachmentError(
        'Harness attachment store is full',
        'STORAGE_LIMIT'
      )
    }
    return candidates.map(({ input, inspected, attachmentId }) => {
      const existing = this.images.get(attachmentId)
      if (existing) {
        existing.references += 1
        return existing.ref
      }
      const name = safeImageName(input.name)
      const ref = Object.freeze({
        attachmentId,
        mediaType: input.mediaType,
        bytes: inspected.data.byteLength,
        width: inspected.width,
        height: inspected.height,
        ...(name ? { name } : {})
      })
      this.images.set(attachmentId, {
        ref,
        data: inspected.data,
        references: 1
      })
      this.storedBytes += inspected.data.byteLength
      return ref
    })
  }

  async readImage(
    ref: ImageAttachmentRef,
    signal?: AbortSignal
  ): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const stored = this.images.get(ref.attachmentId)
    if (!stored) {
      throw new AttachmentError(
        'Harness image attachment was not found',
        'NOT_FOUND'
      )
    }
    if (
      stored.ref.attachmentId !== ref.attachmentId ||
      stored.ref.mediaType !== ref.mediaType ||
      stored.ref.bytes !== ref.bytes ||
      stored.ref.width !== ref.width ||
      stored.ref.height !== ref.height ||
      stored.ref.name !== ref.name
    ) {
      throw new AttachmentError(
        'Harness image attachment failed integrity validation',
        'INTEGRITY'
      )
    }
    return {
      ref: stored.ref,
      data: Uint8Array.from(stored.data)
    }
  }

  releaseImage(ref: ImageAttachmentRef): void {
    const stored = this.images.get(ref.attachmentId)
    if (!stored) {
      return
    }
    stored.references -= 1
    if (stored.references > 0) {
      return
    }
    this.images.delete(ref.attachmentId)
    this.storedBytes -= stored.data.byteLength
  }

  clear(): void {
    this.images.clear()
    this.storedBytes = 0
  }
}
