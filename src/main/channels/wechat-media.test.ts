import {
  createCipheriv,
  createDecipheriv
} from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadWechatFile,
  uploadWechatAttachment
} from './wechat-media'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

function encrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

describe('Weixin media transport', () => {
  it('downloads from an allowed CDN host and decrypts official file keys', async () => {
    const data = Buffer.from('remote file content', 'utf8')
    const key = Buffer.from('0123456789abcdef', 'utf8')
    const encodedHexKey = Buffer.from(
      key.toString('hex'),
      'ascii'
    ).toString('base64')
    global.fetch = vi.fn(async () =>
      new Response(encrypt(data, key), {
        status: 200,
        headers: {
          'content-length': String(encrypt(data, key).byteLength)
        }
      })
    ) as typeof fetch

    await expect(
      downloadWechatFile(
        {
          media: {
            full_url:
              'https://novac2c.cdn.weixin.qq.com/c2c/download?opaque=1',
            aes_key: encodedHexKey
          },
          file_name: '..\\报告.txt',
          len: String(data.byteLength)
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      name: '.._报告.txt',
      mimeType: 'text/plain',
      size: data.byteLength,
      kind: 'file',
      dataBase64: data.toString('base64')
    })
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'novac2c.cdn.weixin.qq.com'
      }),
      expect.objectContaining({ redirect: 'manual' })
    )
  })

  it('rejects redirects outside Tencent Weixin hosts', async () => {
    global.fetch = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/media' }
      })
    ) as typeof fetch

    await expect(
      downloadWechatFile(
        {
          media: {
            full_url:
              'https://novac2c.cdn.weixin.qq.com/c2c/download?opaque=1',
            aes_key: Buffer.from(
              '0123456789abcdef',
              'utf8'
            ).toString('base64')
          },
          file_name: '报告.txt',
          len: '16'
        },
        new AbortController().signal
      )
    ).rejects.toThrow('地址不受信任')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('encrypts bounded output and builds the official file message item', async () => {
    const data = Buffer.from('generated report', 'utf8')
    let uploadedCiphertext: Buffer | undefined
    global.fetch = vi.fn(async (_url, init) => {
      uploadedCiphertext = Buffer.from(
        await new Response(init?.body).arrayBuffer()
      )
      return new Response(null, {
        status: 200,
        headers: { 'x-encrypted-param': 'download-opaque' }
      })
    }) as typeof fetch
    const getUploadUrl = vi.fn(async () => ({
      upload_full_url:
        'https://novac2c.cdn.weixin.qq.com/c2c/upload?opaque=1'
    }))

    const result = await uploadWechatAttachment({
      attachment: {
        name: '报告.txt',
        mimeType: 'text/plain',
        size: data.byteLength,
        kind: 'file',
        dataBase64: data.toString('base64')
      },
      recipientId: 'recipient-1',
      signal: new AbortController().signal,
      getUploadUrl
    })

    expect(getUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        media_type: 3,
        to_user_id: 'recipient-1',
        rawsize: data.byteLength,
        no_need_thumb: true,
        aeskey: expect.stringMatching(/^[a-f0-9]{32}$/u)
      })
    )
    expect(result).toMatchObject({
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: 'download-opaque',
          encrypt_type: 1
        },
        file_name: '报告.txt',
        len: String(data.byteLength)
      }
    })
    const encodedKey =
      result.type === 4
        ? result.file_item.media.aes_key
        : ''
    const keyHex = Buffer.from(encodedKey, 'base64').toString('ascii')
    const decipher = createDecipheriv(
      'aes-128-ecb',
      Buffer.from(keyHex, 'hex'),
      null
    )
    expect(
      Buffer.concat([
        decipher.update(uploadedCiphertext!),
        decipher.final()
      ])
    ).toEqual(data)
  })
})
