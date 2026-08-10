import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto'
import type { ChannelMediaAttachment } from '../../shared/channel-contracts'
import { CHANNEL_LIMITS } from '../../shared/channel-contracts'
import {
  detectSupportedImage,
  mimeTypeFromFileName
} from '../file-media-type'
import { isAllowedWechatUrl } from './wechat-sidecar-security'

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MEDIA_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 3
const MAX_ENCRYPTED_BYTES =
  CHANNEL_LIMITS.maximumAttachmentBytes + 16

type CdnMedia = {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

export type WechatImageItem = {
  media?: CdnMedia
  aeskey?: string
  mid_size?: number
  hd_size?: number
}

export type WechatFileItem = {
  media?: CdnMedia
  file_name?: string
  len?: string
}

export type WechatUploadUrlResponse = {
  upload_param?: string
  upload_full_url?: string
}

export type WechatOutboundMediaItem =
  | {
      type: 2
      image_item: {
        media: {
          encrypt_query_param: string
          aes_key: string
          encrypt_type: 1
        }
        mid_size: number
      }
    }
  | {
      type: 4
      file_item: {
        media: {
          encrypt_query_param: string
          aes_key: string
          encrypt_type: 1
        }
        file_name: string
        len: string
      }
    }

function assertAllowedUrl(raw: string): URL {
  if (!isAllowedWechatUrl(raw)) {
    throw new Error('微信媒体地址不受信任')
  }
  return new URL(raw)
}

function safeFileName(value: string | undefined, fallback: string): string {
  const candidate = [...(value ?? '')]
    .map((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 31 || code === 127)
        ? '_'
        : character
    })
    .join('')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .trim()
    .slice(0, CHANNEL_LIMITS.maximumAttachmentNameLength)
  return candidate && candidate !== '.' && candidate !== '..'
    ? candidate
    : fallback
}

function parseAesKey(value: string, encoding: 'hex' | 'base64'): Buffer {
  if (value.length > 128) {
    throw new Error('微信媒体密钥无效')
  }
  const decoded = Buffer.from(value, encoding)
  if (decoded.byteLength === 16) {
    return decoded
  }
  if (
    encoding === 'base64' &&
    decoded.byteLength === 32 &&
    /^[0-9a-f]{32}$/iu.test(decoded.toString('ascii'))
  ) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error('微信媒体密钥无效')
}

function resolveDownloadUrl(media: CdnMedia): URL {
  if (media.full_url?.trim()) {
    return assertAllowedUrl(media.full_url.trim())
  }
  const parameter = media.encrypt_query_param?.trim()
  if (!parameter || parameter.length > 8_192) {
    throw new Error('微信媒体下载参数无效')
  }
  const url = new URL('/c2c/download', `${CDN_BASE_URL}/`)
  url.searchParams.set('encrypted_query_param', parameter)
  return assertAllowedUrl(url.toString())
}

function withTimeout(
  inputSignal: AbortSignal,
  timeoutMs = MEDIA_TIMEOUT_MS
): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const abort = (): void => controller.abort(inputSignal.reason)
  inputSignal.addEventListener('abort', abort, { once: true })
  if (inputSignal.aborted) {
    abort()
  }
  const timeout = setTimeout(
    () => controller.abort(new Error('微信媒体传输超时')),
    timeoutMs
  )
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      inputSignal.removeEventListener('abort', abort)
    }
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new Error('微信媒体超过 12MB 限制')
  }
  if (!response.body) {
    return Buffer.alloc(0)
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      total += chunk.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new Error('微信媒体超过 12MB 限制')
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function fetchWechatBytes(
  initialUrl: URL,
  signal: AbortSignal
): Promise<Buffer> {
  let url = initialUrl
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error('微信媒体重定向无效')
      }
      url = assertAllowedUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok) {
      throw new Error(`微信媒体下载失败（${response.status}）`)
    }
    return readBoundedBody(response, MAX_ENCRYPTED_BYTES)
  }
  throw new Error('微信媒体重定向过多')
}

async function downloadMedia(
  media: CdnMedia,
  key: Buffer | undefined,
  signal: AbortSignal
): Promise<Buffer> {
  const timed = withTimeout(signal)
  try {
    const encrypted = await fetchWechatBytes(
      resolveDownloadUrl(media),
      timed.signal
    )
    timed.signal.throwIfAborted()
    if (!key) {
      if (encrypted.byteLength > CHANNEL_LIMITS.maximumAttachmentBytes) {
        throw new Error('微信媒体超过 12MB 限制')
      }
      return encrypted
    }
    if (encrypted.byteLength === 0 || encrypted.byteLength % 16 !== 0) {
      throw new Error('微信媒体密文无效')
    }
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ])
    if (
      decrypted.byteLength === 0 ||
      decrypted.byteLength > CHANNEL_LIMITS.maximumAttachmentBytes
    ) {
      throw new Error('微信媒体超过 12MB 限制')
    }
    return decrypted
  } finally {
    timed.dispose()
  }
}

export async function downloadWechatImage(
  item: WechatImageItem,
  fallbackName: string,
  signal: AbortSignal
): Promise<ChannelMediaAttachment> {
  if (!item.media) {
    throw new Error('微信图片缺少媒体引用')
  }
  // The size hints can describe a different image variant, such as the
  // undownloaded HD image. Enforce the limit on the fetched ciphertext and
  // decrypted image instead.
  const key = item.aeskey
    ? parseAesKey(item.aeskey, 'hex')
    : item.media.aes_key
      ? parseAesKey(item.media.aes_key, 'base64')
      : undefined
  const data = await downloadMedia(item.media, key, signal)
  const format = detectSupportedImage(data)
  return {
    name: safeFileName(
      `${fallbackName}.${format.extension}`,
      `微信图片.${format.extension}`
    ),
    mimeType: format.mimeType,
    size: data.byteLength,
    kind: 'image',
    dataBase64: data.toString('base64')
  }
}

export async function downloadWechatFile(
  item: WechatFileItem,
  signal: AbortSignal
): Promise<ChannelMediaAttachment> {
  if (!item.media?.aes_key) {
    throw new Error('微信文件缺少加密信息')
  }
  const claimedSize = Number(item.len)
  if (
    item.len !== undefined &&
    (!Number.isSafeInteger(claimedSize) ||
      claimedSize < 1 ||
      claimedSize > CHANNEL_LIMITS.maximumAttachmentBytes)
  ) {
    throw new Error('微信文件超过 12MB 限制')
  }
  const data = await downloadMedia(
    item.media,
    parseAesKey(item.media.aes_key, 'base64'),
    signal
  )
  if (item.len !== undefined && data.byteLength !== claimedSize) {
    throw new Error('微信文件大小校验失败')
  }
  const name = safeFileName(item.file_name, '微信文件.bin')
  return {
    name,
    mimeType: mimeTypeFromFileName(name),
    size: data.byteLength,
    kind: 'file',
    dataBase64: data.toString('base64')
  }
}

function encryptedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

async function uploadWechatBytes(
  url: URL,
  body: Buffer,
  signal: AbortSignal
): Promise<string> {
  const timed = withTimeout(signal)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      redirect: 'manual',
      signal: timed.signal
    })
    if (response.status >= 300 && response.status < 400) {
      throw new Error('微信媒体上传重定向无效')
    }
    if (!response.ok) {
      throw new Error(`微信媒体上传失败（${response.status}）`)
    }
    const parameter = response.headers.get('x-encrypted-param')?.trim()
    if (!parameter || parameter.length > 8_192) {
      throw new Error('微信媒体上传结果无效')
    }
    return parameter
  } finally {
    timed.dispose()
  }
}

export async function uploadWechatAttachment(input: {
  attachment: ChannelMediaAttachment
  recipientId: string
  signal: AbortSignal
  getUploadUrl: (request: {
    filekey: string
    media_type: 1 | 3
    to_user_id: string
    rawsize: number
    rawfilemd5: string
    filesize: number
    no_need_thumb: true
    aeskey: string
  }) => Promise<WechatUploadUrlResponse>
}): Promise<WechatOutboundMediaItem> {
  const attachment = input.attachment
  const plaintext = Buffer.from(attachment.dataBase64, 'base64')
  if (
    plaintext.byteLength !== attachment.size ||
    plaintext.byteLength === 0 ||
    plaintext.byteLength > CHANNEL_LIMITS.maximumAttachmentBytes
  ) {
    throw new Error('待发送附件大小无效')
  }
  if (attachment.kind === 'image') {
    detectSupportedImage(plaintext)
  }
  const filekey = randomBytes(16).toString('hex')
  const key = randomBytes(16)
  const response = await input.getUploadUrl({
    filekey,
    media_type: attachment.kind === 'image' ? 1 : 3,
    to_user_id: input.recipientId,
    rawsize: plaintext.byteLength,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: encryptedSize(plaintext.byteLength),
    no_need_thumb: true,
    aeskey: key.toString('hex')
  })
  const fullUrl = response.upload_full_url?.trim()
  const uploadParameter = response.upload_param?.trim()
  const uploadUrl = fullUrl
    ? assertAllowedUrl(fullUrl)
    : (() => {
        if (!uploadParameter || uploadParameter.length > 8_192) {
          throw new Error('微信媒体上传地址缺失')
        }
        const url = new URL('/c2c/upload', `${CDN_BASE_URL}/`)
        url.searchParams.set('encrypted_query_param', uploadParameter)
        url.searchParams.set('filekey', filekey)
        return assertAllowedUrl(url.toString())
      })()
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ])
  const downloadParameter = await uploadWechatBytes(
    uploadUrl,
    encrypted,
    input.signal
  )
  const aesKey = Buffer.from(key.toString('hex'), 'ascii').toString(
    'base64'
  )
  if (attachment.kind === 'image') {
    return {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: downloadParameter,
          aes_key: aesKey,
          encrypt_type: 1
        },
        mid_size: encrypted.byteLength
      }
    }
  }
  return {
    type: 4,
    file_item: {
      media: {
        encrypt_query_param: downloadParameter,
        aes_key: aesKey,
        encrypt_type: 1
      },
      file_name: safeFileName(attachment.name, 'GoodBuddy 文件.bin'),
      len: String(plaintext.byteLength)
    }
  }
}
