import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SupervisionReviewSettings } from './SupervisionReviewSettings'
import { applicationSettingsSchema, defaultLocalToolEnvironmentSettings } from '../../shared/application-settings-contracts'
import i18n, { changeUiLocale, i18nResources } from './i18n'

afterEach(async () => { cleanup(); await changeUiLocale('zh-CN') })
it.each(['zh-CN', 'en-US'] as const)('shows actionable supervisor help without delivery status in %s', async locale => {
  await changeUiLocale(locale)
  render(<SupervisionReviewSettings />)
  const copy = i18nResources[locale].heartbeat
  expect(screen.getByText(copy.reviewSettings.pauseHelp)).toBeVisible()
  expect(i18n.exists('reviewSettings.pauseHelp', { ns: 'heartbeat', lng: locale })).toBe(true)
  expect(JSON.stringify(copy)).not.toMatch(/RPM|TPM|Retry-After|尚未实现|not implemented|没有按时间保存的操作审计|chronological audit log|暂不支持按分钟|Minute intervals are not supported/)
  expect(copy.timeouts.concurrencyHelp).toContain(locale === 'zh-CN' ? '仅限制监督请求' : 'This limits supervision only')
  expect(copy.reviewSettings.factsHelp).toContain(locale === 'zh-CN' ? '对照来源核对' : 'against the sources')
})

it('saves validated algorithm controls and retains the draft until saved settings arrive', () => {
  const save = vi.fn()
  const defaultApplicationSettings = applicationSettingsSchema.parse({ checkUpdatesOnStartup: true, updateSource: 'github', modelDownloadSource: 'modelscope', localToolEnvironment: defaultLocalToolEnvironmentSettings, conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false })
  render(<SupervisionReviewSettings settings={defaultApplicationSettings} onSave={save} />)
  fireEvent.change(screen.getByLabelText(/每次读取来源条数/), { target: { value: '0' } })
  expect(screen.getByRole('button', { name: '保存回顾算法' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(/每次读取来源条数/), { target: { value: '17' } })
  fireEvent.change(screen.getByLabelText(/每批消息数/), { target: { value: '30' } })
  fireEvent.change(screen.getByLabelText(/单次响应容量/), { target: { value: '2048' } })
  fireEvent.click(screen.getByRole('button', { name: '保存回顾算法' }))
  expect(save).toHaveBeenCalledWith({ supervisionReview: { pageSize: 17, batchCharacters: 8000, batchMessages: 30, executionSeconds: 300, responseKiB: 2048 } })
  expect(screen.getByLabelText(/每次读取来源条数/)).toHaveValue(17)
})
