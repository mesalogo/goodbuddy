// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SpeechSettingsStore } from './speech-settings-store'

const cipher = { isAvailable: () => true, encrypt: (text: string) => Buffer.from(text).reverse(), decrypt: (bytes: Buffer) => Buffer.from(bytes).reverse().toString() }
describe('speech settings', () => {
  it('defaults to local/non-streaming, encrypts keys, preserves and clears them across restarts', async () => {
    const root = await mkdtemp(resolve('temp/speech-settings-'))
    try {
      const path = join(root, 'settings.json')
      const store = new SpeechSettingsStore(path, cipher)
      expect((await store.get()).settings).toMatchObject({ provider: 'local', stream: false })
      const settings = { provider: 'openai-compatible', baseUrl: 'http://localhost:6080/v1', model: 'asr', language: 'zh', stream: true }
      const saved = await store.update({ settings, apiKey: { action: 'replace', value: 'secret-value' } })
      expect(saved.apiKeyConfigured).toBe(true)
      expect(JSON.stringify(saved)).not.toContain('secret-value')
      expect(await readFile(path, 'utf8')).not.toContain('secret-value')
      const reloaded = new SpeechSettingsStore(path, cipher)
      expect(await reloaded.resolve()).toMatchObject({ apiKey: 'secret-value', settings: { stream: true } })
      await reloaded.update({ settings, apiKey: { action: 'keep' } })
      expect((await reloaded.resolve()).apiKey).toBe('secret-value')
      await reloaded.update({ settings, apiKey: { action: 'clear' } })
      expect((await reloaded.get()).apiKeyConfigured).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects invalid remote configuration and unavailable credential storage', async () => {
    const root = await mkdtemp(resolve('temp/speech-settings-'))
    try {
      const store = new SpeechSettingsStore(join(root, 'settings.json'), { ...cipher, isAvailable: () => false })
      expect(() => store.update({ settings: { provider: 'openai-compatible', baseUrl: 'file:///x', model: '' }, apiKey: { action: 'keep' } })).toThrow()
      await expect(store.update({ settings: {}, apiKey: { action: 'replace', value: 'key' } })).rejects.toThrow('加密存储不可用')
      expect((await store.get()).apiKeyConfigured).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
