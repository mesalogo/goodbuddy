import { nativeImage } from 'electron'
import type { FeedbackScreenshotInput } from '../../shared/feedback-contracts'
import { feedbackLimits } from '../../shared/feedback-contracts'
import { detectSupportedImage } from '../file-media-type'

export class FeedbackScreenshotError extends Error {
  constructor(
    readonly code: 'invalid-submission' | 'screenshot-too-large'
  ) {
    super(code)
    this.name = 'FeedbackScreenshotError'
  }
}

export type NormalizedFeedbackScreenshot = {
  data: Buffer
  width: number
  height: number
}

export function normalizeFeedbackScreenshot(
  screenshot: FeedbackScreenshotInput
): NormalizedFeedbackScreenshot {
  if (
    screenshot.data.byteLength === 0 ||
    screenshot.data.byteLength >
      feedbackLimits.maximumScreenshotBytes
  ) {
    throw new FeedbackScreenshotError('screenshot-too-large')
  }
  const input = Buffer.from(
    screenshot.data.buffer,
    screenshot.data.byteOffset,
    screenshot.data.byteLength
  )
  try {
    if (detectSupportedImage(input).mimeType !== screenshot.mimeType) {
      throw new FeedbackScreenshotError('invalid-submission')
    }
  } catch {
    throw new FeedbackScreenshotError('invalid-submission')
  }

  let image
  try {
    image = nativeImage.createFromBuffer(input)
  } catch {
    throw new FeedbackScreenshotError('invalid-submission')
  }
  if (image.isEmpty()) {
    throw new FeedbackScreenshotError('invalid-submission')
  }
  const { width, height } = image.getSize()
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > feedbackLimits.maximumScreenshotDimension ||
    height > feedbackLimits.maximumScreenshotDimension ||
    width * height > feedbackLimits.maximumScreenshotPixels
  ) {
    throw new FeedbackScreenshotError('invalid-submission')
  }

  let data: Buffer
  try {
    data = image.toPNG()
  } catch {
    throw new FeedbackScreenshotError('invalid-submission')
  }
  if (
    data.byteLength === 0 ||
    data.byteLength > feedbackLimits.maximumScreenshotBytes
  ) {
    throw new FeedbackScreenshotError('screenshot-too-large')
  }
  try {
    if (detectSupportedImage(data).mimeType !== 'image/png') {
      throw new FeedbackScreenshotError('invalid-submission')
    }
  } catch {
    throw new FeedbackScreenshotError('invalid-submission')
  }
  return { data, width, height }
}
