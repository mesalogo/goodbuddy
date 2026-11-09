import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpeechConnectionSettings } from './SpeechConnectionSettings'
import { speechSettingsSchema, type SpeechSettingsUpdate } from '../../shared/speech-settings-contracts'

const previous = window.goodbuddy
afterEach(() => { Object.defineProperty(window, 'goodbuddy', { configurable: true, value: previous }) })
it('defaults streaming off, validates remote fields and saves credentials without clearing the retained key', async () => {
  const settings = speechSettingsSchema.parse({})
  const updateSettings = vi.fn(async (input: SpeechSettingsUpdate) => ({ settings: input.settings, apiKeyConfigured: true, secureStorageAvailable: true }))
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { speech: {
    transcribe: vi.fn(), cancel: vi.fn(),
    getSettings: async () => ({ settings, apiKeyConfigured: true, secureStorageAvailable: true }), updateSettings
  } } })
  const onNotify = vi.fn()
  render(<SpeechConnectionSettings onDirtyChange={vi.fn()} onNotify={onNotify}><p>Local controls</p></SpeechConnectionSettings>)
  fireEvent.change(await screen.findByLabelText('识别方式'), { target: { value: 'openai-compatible' } })
  expect(screen.queryByText('Local controls')).toBeNull()
  expect(screen.getByRole('switch')).not.toBeChecked()
  fireEvent.click(screen.getByText('保存识别设置'))
  expect(await screen.findByRole('alert')).toHaveTextContent('API 基础地址')
  expect(updateSettings).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('API 基础地址'), { target: { value: 'http://localhost:6080/v1' } })
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'asr' } })
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.getByText('保存识别设置')).not.toBeDisabled())
  fireEvent.click(screen.getByText('保存识别设置'))
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ settings: { ...settings, provider: 'openai-compatible', baseUrl: 'http://localhost:6080/v1', model: 'asr', stream: true }, apiKey: { action: 'keep' } }))
  await waitFor(() => expect(onNotify).toHaveBeenCalledWith({ tone: 'success', message: '语音识别设置已保存' }))
})
