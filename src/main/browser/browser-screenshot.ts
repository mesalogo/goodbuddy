export {
  BOUNDED_JPEG_QUALITIES as BROWSER_JPEG_QUALITIES,
  isValidJpeg as isValidBrowserJpeg,
  MAX_BOUNDED_JPEG_BYTES as MAX_BROWSER_SCREENSHOT_BYTES
} from '../bounded-jpeg'

export type BrowserScreenshot = {
  type: 'image'
  mimeType: 'image/jpeg'
  data: string
}
