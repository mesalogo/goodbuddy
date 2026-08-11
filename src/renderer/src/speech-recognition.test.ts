import { describe, expect, it, vi } from 'vitest'
import {
  describeSpeechRecognitionError,
  getSpeechRecognitionConstructor,
  isElectronUserAgent,
  prepareSpeechRecognition,
  resamplePcm,
  type SpeechRecognitionConstructor,
  type SpeechRecognitionInstance
} from './speech-recognition'
import { changeUiLocale } from './i18n'

function createRecognitionConstructor(): {
  Recognition: SpeechRecognitionConstructor
  instance: SpeechRecognitionInstance
} {
  const instance: SpeechRecognitionInstance = {
    lang: '',
    interimResults: true,
    continuous: true,
    start: vi.fn(),
    stop: vi.fn()
  }
  const Recognition = vi.fn(function RecognitionMock() {
    return instance
  }) as unknown as SpeechRecognitionConstructor
  return { Recognition, instance }
}

describe('speech recognition', () => {
  it('prefers the standard constructor over the prefixed constructor', () => {
    const standard = createRecognitionConstructor().Recognition
    const prefixed = createRecognitionConstructor().Recognition

    expect(
      getSpeechRecognitionConstructor({
        SpeechRecognition: standard,
        webkitSpeechRecognition: prefixed
      } as unknown as Window)
    ).toBe(standard)
  })

  it('enables local processing when the language pack is available', async () => {
    const { Recognition, instance } =
      createRecognitionConstructor()
    Recognition.available = vi.fn(
      async () => 'available' as const
    )

    await expect(
      prepareSpeechRecognition(Recognition, 'zh-CN')
    ).resolves.toEqual({
      recognition: instance,
      local: true
    })
    expect(instance).toMatchObject({
      processLocally: true,
      lang: 'zh-CN',
      interimResults: false,
      continuous: false
    })
  })

  it('installs a downloadable local language pack before listening', async () => {
    const { Recognition, instance } =
      createRecognitionConstructor()
    const onDownload = vi.fn()
    Recognition.available = vi.fn(
      async () => 'downloadable' as const
    )
    Recognition.install = vi.fn(async () => true)

    await expect(
      prepareSpeechRecognition(
        Recognition,
        'zh-CN',
        onDownload
      )
    ).resolves.toEqual({
      recognition: instance,
      local: true
    })
    expect(onDownload).toHaveBeenCalledOnce()
    expect(Recognition.install).toHaveBeenCalledWith({
      langs: ['zh-CN'],
      processLocally: true
    })
  })

  it('does not claim local processing when local APIs are unavailable', async () => {
    const { Recognition, instance } =
      createRecognitionConstructor()

    await expect(
      prepareSpeechRecognition(Recognition, 'zh-CN')
    ).resolves.toEqual({
      recognition: instance,
      local: false
    })
    expect(instance.processLocally).toBeUndefined()
  })

  it('keeps the unsafe Web Speech fallback disabled in Electron', async () => {
    const { Recognition } = createRecognitionConstructor()
    Recognition.available = vi.fn(
      async () => 'available' as const
    )

    await expect(
      prepareSpeechRecognition(
        Recognition,
        'zh-CN',
        undefined,
        {},
        'Mozilla/5.0 Electron/43.2.0'
      )
    ).rejects.toThrow('本地语音识别服务未加载')
    expect(Recognition).not.toHaveBeenCalled()
    expect(Recognition.available).not.toHaveBeenCalled()
  })

  it('resamples bounded microphone PCM to the local runtime rate', () => {
    const result = resamplePcm(
      new Float32Array([0, 0.5, 1, 0.5]),
      32_000,
      16_000
    )

    expect([...result]).toEqual([0, 1])
  })

  it('reports a language pack that is still downloading', async () => {
    const { Recognition } = createRecognitionConstructor()
    Recognition.available = vi.fn(
      async () => 'downloading' as const
    )

    await expect(
      prepareSpeechRecognition(Recognition, 'zh-CN')
    ).rejects.toThrow('中文离线语音包正在下载')
  })

  it('bounds a stalled local language availability check', async () => {
    const { Recognition } = createRecognitionConstructor()
    Recognition.available = vi.fn(
      () => new Promise<never>(() => undefined)
    )

    await expect(
      prepareSpeechRecognition(
        Recognition,
        'zh-CN',
        undefined,
        { availabilityMs: 5 }
      )
    ).rejects.toThrow('检查中文离线语音包超时')
  })

  it('bounds a stalled local language pack installation', async () => {
    const { Recognition } = createRecognitionConstructor()
    Recognition.available = vi.fn(
      async () => 'downloadable' as const
    )
    Recognition.install = vi.fn(
      () => new Promise<never>(() => undefined)
    )

    await expect(
      prepareSpeechRecognition(
        Recognition,
        'zh-CN',
        undefined,
        { installMs: 5 }
      )
    ).rejects.toThrow('中文离线语音包下载超时')
  })

  it.each([
    ['GoodBuddy Electron/43.2.0', true],
    [
      'Mozilla/5.0 Chrome/144.0.0.0 Electron/43.2.0 Safari/537.36',
      true
    ],
    ['Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36', false]
  ])('detects Electron user agent %s', (userAgent, expected) => {
    expect(isElectronUserAgent(userAgent)).toBe(expected)
  })

  it.each([
    ['audio-capture', '未检测到可用麦克风'],
    ['language-not-supported', '中文语音识别包'],
    ['network', 'Electron 在线语音服务不可用'],
    ['no-speech', '没有检测到语音'],
    ['not-allowed', '麦克风权限被拒绝'],
    ['service-not-allowed', '麦克风权限被拒绝']
  ])('maps %s errors to actionable copy', (error, copy) => {
    expect(describeSpeechRecognitionError({ error })).toContain(copy)
  })

  it('reports renderer-owned speech errors in English', async () => {
    await changeUiLocale('en-US')
    expect(
      describeSpeechRecognitionError({ error: 'audio-capture' })
    ).toContain('No microphone is available')
    await changeUiLocale('zh-CN')
  })
})
