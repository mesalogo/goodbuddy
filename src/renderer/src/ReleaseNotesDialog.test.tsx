import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { ReleaseNotesSnapshot } from '../../shared/release-notes-contracts'
import { changeUiLocale } from './i18n'
import { ReleaseNotesDialog } from './ReleaseNotesDialog'

const snapshot: ReleaseNotesSnapshot = {
  currentVersion: '0.8.18',
  releases: [
    {
      version: '0.8.18',
      releasedAt: '2026-08-11',
      notes: {
        'zh-CN': {
          highlights: ['多 Runtime 工作流更加连贯。'],
          features: ['**Runtime 能力概览。** 查看实际可用能力。'],
          fixes: ['**设置界面一致性。** 修复开关尺寸。'],
          notices: ['**工作模式权限。** Ask 模式保持只读。']
        },
        'en-US': {
          highlights: ['Multi-Runtime workflows are more cohesive.'],
          features: [
            '**Runtime capability overview.** View actual capabilities.'
          ],
          fixes: ['**Settings consistency.** Fixed switch dimensions.'],
          notices: ['**Work mode permissions.** Ask remains read-only.']
        }
      }
    }
  ]
}

function Harness({
  acknowledge,
  locale = 'zh-CN'
}: {
  acknowledge: (version: string) => Promise<void>
  locale?: 'zh-CN' | 'en-US'
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <>
      <div className="app-shell">
        <button type="button">Background</button>
      </div>
      {open && (
        <ReleaseNotesDialog
          locale={locale}
          onAcknowledge={acknowledge}
          onClose={() => setOpen(false)}
          snapshot={snapshot}
        />
      )}
    </>
  )
}

afterEach(async () => {
  cleanup()
  await changeUiLocale('zh-CN')
})

describe('ReleaseNotesDialog', () => {
  it('shows localized notes once and acknowledges before closing', async () => {
    const acknowledge = vi.fn(async () => {})
    const { container } = render(<Harness acknowledge={acknowledge} />)

    expect(
      screen.getByRole('dialog', {
        name: 'GoodBuddy 0.8.18 更新内容'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '本次亮点' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('多 Runtime 工作流更加连贯。')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '功能更新' })
    ).toBeInTheDocument()
    expect(screen.getByText('Runtime 能力概览。').tagName).toBe(
      'STRONG'
    )
    expect(screen.getByText('查看实际可用能力。')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '问题修复' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '使用前请留意' })
    ).toBeInTheDocument()
    expect(screen.getByText('工作模式权限。').tagName).toBe('STRONG')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(
      container.querySelector<HTMLElement>('.app-shell')?.inert
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '开始使用' }))

    await waitFor(() =>
      expect(acknowledge).toHaveBeenCalledWith('0.8.18')
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(
      container.querySelector<HTMLElement>('.app-shell')?.inert
    ).toBe(false)
  })

  it('keeps the dialog open when acknowledgement fails', async () => {
    const acknowledge = vi.fn(async () => {
      throw new Error('disk failed')
    })
    render(<Harness acknowledge={acknowledge} />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(
      await screen.findByRole('alert')
    ).toHaveTextContent('无法保存已读状态，请重试。')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders the approved English release notes', async () => {
    await changeUiLocale('en-US')
    render(<Harness acknowledge={vi.fn(async () => {})} locale="en-US" />)

    expect(
      screen.getByRole('dialog', {
        name: "What's New in GoodBuddy 0.8.18"
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Highlights' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('Multi-Runtime workflows are more cohesive.')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Runtime capability overview.').tagName
    ).toBe('STRONG')
    expect(
      screen.getByRole('heading', { name: 'Before You Start' })
    ).toBeInTheDocument()
    expect(screen.getByText('Work mode permissions.').tagName).toBe(
      'STRONG'
    )
    expect(
      screen.getByRole('button', { name: 'Get Started' })
    ).toBeInTheDocument()
  })
})
