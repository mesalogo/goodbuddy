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
          features: ['新增双语界面'],
          fixes: ['修复开关尺寸']
        },
        'en-US': {
          features: ['Added a bilingual interface'],
          fixes: ['Fixed switch dimensions']
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
    expect(screen.getByText('新增双语界面')).toBeInTheDocument()
    expect(screen.getByText('修复开关尺寸')).toBeInTheDocument()
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
      screen.getByText('Added a bilingual interface')
    ).toBeInTheDocument()
    expect(screen.getByText('Fixed switch dimensions')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Get Started' })
    ).toBeInTheDocument()
  })
})
