import { describe, expect, it } from 'vitest'
import { buildWechatSidecarEnvironment } from './wechat-sidecar-environment'

describe('buildWechatSidecarEnvironment', () => {
  it('enforces TLS verification without inheriting secrets or proxy hooks', () => {
    expect(
      buildWechatSidecarEnvironment({
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        LANG: 'zh_CN.UTF-8',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_OPTIONS: '--require C:\\inject.js',
        HTTPS_PROXY: 'http://proxy.invalid',
        API_KEY: 'secret'
      })
    ).toEqual({
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      LANG: 'zh_CN.UTF-8',
      NODE_TLS_REJECT_UNAUTHORIZED: '1'
    })
  })
})
