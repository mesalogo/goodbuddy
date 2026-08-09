import { describe, expect, it } from 'vitest'
import {
  isAllowedWechatUrl,
  redactWechatSidecarError
} from './wechat-sidecar-security'

describe('Weixin sidecar network boundary', () => {
  it.each([
    'https://weixin.qq.com',
    'https://ilinkai.weixin.qq.com',
    'https://sub.domain.weixin.qq.com/api'
  ])('allows Tencent Weixin HTTPS host %s', (url) => {
    expect(isAllowedWechatUrl(url)).toBe(true)
  })

  it.each([
    'http://ilinkai.weixin.qq.com',
    'https://weixin.qq.com.example.com',
    'https://evilweixin.qq.com',
    'https://user:password@ilinkai.weixin.qq.com',
    'file:///etc/passwd',
    'not-a-url'
  ])('rejects untrusted or credentialed URL %s', (url) => {
    expect(isAllowedWechatUrl(url)).toBe(false)
  })

  it('redacts credentials and full service paths from errors', () => {
    const result = redactWechatSidecarError(
      new Error(
        'token=secret-value https://ilinkai.weixin.qq.com/ilink/bot/getupdates'
      )
    )
    expect(result).not.toContain('secret-value')
    expect(result).not.toContain('/ilink/bot/getupdates')
    expect(result).toContain('[已隐藏]')
  })
})
