/// <reference types="node" />

import {
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DestructiveConfirmActions,
  EmptyState,
  PageHeader,
  PageShell,
  PageTabs,
  SegmentedControl
} from './WorkspacePrimitives'

const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
)
const rendererEntry = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'main.tsx'),
  'utf8'
)
const fontSetup = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'fonts.ts'),
  'utf8'
)

function themeTokens(selector: string): Record<string, string> {
  const selectorIndex = stylesheet.indexOf(selector)
  const blockStart = stylesheet.indexOf('{', selectorIndex)
  const blockEnd = stylesheet.indexOf('}', blockStart)
  if (selectorIndex < 0 || blockStart < 0 || blockEnd < 0) {
    throw new Error(`Missing token block ${selector}`)
  }
  const block = stylesheet.slice(blockStart + 1, blockEnd)
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[\da-f]{3,6});/giu)].map(
      ([, name, value]) => [name, value]
    )
  )
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const compact = hex.slice(1)
    const expanded =
      compact.length === 3
        ? compact
            .split('')
            .map((value) => `${value}${value}`)
            .join('')
        : compact
    const [red, green, blue] = expanded
      .match(/../gu)!
      .map((value) => Number.parseInt(value, 16) / 255)
      .map((value) =>
        value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4
      )
    return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722
  }
  const first = luminance(foreground)
  const second = luminance(background)
  return (
    (Math.max(first, second) + 0.05) /
    (Math.min(first, second) + 0.05)
  )
}

describe('WorkspacePrimitives', () => {
  afterEach(() => {
    cleanup()
  })

  it('uses bundled variable fonts and readable shared type tokens', () => {
    expect(rendererEntry).toContain(
      "@fontsource-variable/noto-sans-sc/wght.css"
    )
    expect(rendererEntry).toContain('installBundledUiFonts()')
    expect(fontSetup).toContain(
      'inter-latin-standard-normal.woff2?url'
    )
    expect(fontSetup).toContain(
      'inter-latin-standard-italic.woff2?url'
    )
    expect(stylesheet).toMatch(/--font-body:\s*13px/u)
    expect(stylesheet).toMatch(/--font-caption:\s*11px/u)
    expect(stylesheet).toMatch(/font-synthesis:\s*style/u)
    expect(stylesheet).toContain(
      '"Inter Variable", "Noto Sans SC Variable"'
    )
  })

  it('keeps shared controls keyboard and pointer accessible at narrow widths', () => {
    expect(stylesheet).toMatch(
      /button\s*>\s*svg,\s*button\s*>\s*svg\s+\*\s*\{[^}]*pointer-events:\s*none;/u
    )
    expect(stylesheet).toMatch(
      /button\s*>\s*svg\s*\{[^}]*display:\s*block;[^}]*flex:\s*0 0 auto;/u
    )
    expect(stylesheet).toMatch(
      /\.primary-button,\s*\.secondary-button,\s*\.danger-button\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*gap:\s*var\(--space-2\);/u
    )
    expect(stylesheet).toMatch(
      /button:focus-visible,\s*input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);/u
    )
    expect(stylesheet).toMatch(
      /\.page-tabs\s*\{[^}]*overflow-x:\s*auto;[^}]*flex-wrap:\s*nowrap;/u
    )
    expect(stylesheet).toMatch(
      /\.knowledge-graph__detail > \.page-tabs--segmented\s*\{[^}]*min-height:\s*36px;[^}]*overflow:\s*hidden;[^}]*flex:\s*0 0 auto;/u
    )
    expect(stylesheet).toMatch(
      /\.knowledge-graph__detail > \.page-tabs--segmented \.page-tabs__tab\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*flex:\s*1;/u
    )
    expect(stylesheet).toMatch(
      /\.knowledge-source-row__actions > button\s*\{[^}]*height:\s*var\(--control-height\);[^}]*min-height:\s*var\(--control-height\);[^}]*padding:\s*0 var\(--space-3\);[^}]*align-self:\s*center;/u
    )
    expect(stylesheet).not.toContain(
      '.heartbeat-center > .page-tabs {\n    display: grid;'
    )
  })

  it('keeps shared switches from inheriting text-field dimensions', () => {
    expect(stylesheet).toMatch(
      /\.toggle-row input\s*\{[^}]*min-width:\s*38px;[^}]*width:\s*38px;[^}]*min-height:\s*22px;[^}]*height:\s*22px;[^}]*margin:\s*0;/u
    )
  })

  it('separates model service fields from credential status', () => {
    expect(stylesheet).toMatch(
      /\.model-service-form\s*\{[^}]*display:\s*grid;[^}]*gap:\s*var\(--space-3\);/u
    )
  })

  it('uses the design-system page gutters at each window width', () => {
    expect(stylesheet).toMatch(/--page-gutter:\s*32px;/u)
    expect(stylesheet).toMatch(
      /@media \(max-width: 1199px\)\s*\{\s*:root\s*\{\s*--page-gutter:\s*24px;/u
    )
    expect(stylesheet).toMatch(
      /@media \(max-width: 959px\)\s*\{\s*:root\s*\{\s*--page-gutter:\s*16px;/u
    )
    expect(stylesheet).toMatch(
      /\.page-shell--master-detail\s*\{[^}]*padding:\s*var\(--page-gutter\);/u
    )
  })

  it('keeps knowledge settings cards separated as page sections', () => {
    expect(stylesheet).toMatch(
      /\.knowledge-settings\s*\{[^}]*display:\s*grid;[^}]*width:\s*min\(920px,\s*100%\);[^}]*gap:\s*var\(--space-6\);/u
    )
    expect(stylesheet).toMatch(
      /\.knowledge-settings--index\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u
    )
    expect(stylesheet).toMatch(
      /\.knowledge-settings--graph\s*\{[^}]*grid-template-columns:\s*minmax\(280px,\s*0\.7fr\)\s*minmax\(0,\s*1\.3fr\);/u
    )
    expect(stylesheet).toMatch(
      /\.knowledge-settings\s*>\s*section\s*\{[^}]*display:\s*grid;[^}]*gap:\s*var\(--space-4\);/u
    )
    expect(stylesheet).toMatch(
      /\.knowledge-settings__toggle\s*\{[^}]*display:\s*grid;[^}]*align-items:\s*flex-start;[^}]*justify-content:\s*initial;[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);/u
    )
  })

  it('renders a consistent page shell and scoped header', () => {
    render(
      <PageShell variant="dashboard">
        <PageHeader
          description="跨项目记录"
          eyebrow="AUDIT"
          headingId="page-title"
          scope={{ kind: 'all-projects' }}
          title="任务与活动"
        />
      </PageShell>
    )

    expect(
      screen.getByRole('heading', { level: 1, name: '任务与活动' })
    ).toBeInTheDocument()
    expect(screen.getByText('全部项目')).toHaveClass('scope-badge')
    expect(screen.getByText('全部项目').closest('.page-shell')).toHaveClass(
      'page-shell--dashboard'
    )
  })

  it('supports arrow-key tab and segmented-control selection', () => {
    const onTabChange = vi.fn()
    const onSegmentChange = vi.fn()
    render(
      <>
        <PageTabs
          ariaLabel="视图"
          idPrefix="example"
          onChange={onTabChange}
          tabs={[
            { id: 'first', label: '第一个' },
            { id: 'second', label: '第二个' }
          ]}
          value="first"
        />
        <SegmentedControl
          ariaLabel="筛选"
          onChange={onSegmentChange}
          options={[
            { value: 'all', label: '全部' },
            { value: 'failed', label: '失败' }
          ]}
          value="all"
        />
      </>
    )

    fireEvent.keyDown(screen.getByRole('tab', { name: '第一个' }), {
      key: 'ArrowRight'
    })
    expect(onTabChange).toHaveBeenCalledWith('second')

    fireEvent.keyDown(screen.getByRole('button', { name: '全部' }), {
      key: 'End'
    })
    expect(onSegmentChange).toHaveBeenCalledWith('failed')
  })

  it('distinguishes page and section empty states', () => {
    const { rerender } = render(
      <EmptyState
        description="创建内容后会显示在这里。"
        level="page"
        title="尚无内容"
      />
    )
    expect(screen.getByText('尚无内容').parentElement).toHaveClass(
      'empty-state--page'
    )

    rerender(
      <EmptyState
        description="没有符合当前筛选的内容。"
        level="section"
        title="没有匹配结果"
      />
    )
    expect(screen.getByText('没有匹配结果').parentElement).toHaveClass(
      'empty-state--section'
    )
  })

  it('uses the shared destructive confirmation flow', () => {
    const onRequestConfirm = vi.fn()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <DestructiveConfirmActions
        confirmAriaLabel="永久删除对象"
        confirmLabel="确认删除"
        confirming={false}
        icon={<span data-testid="delete-icon">×</span>}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestConfirm={onRequestConfirm}
        triggerLabel="删除"
      />
    )

    expect(screen.getByTestId('delete-icon').parentElement).toHaveAttribute(
      'aria-hidden',
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onRequestConfirm).toHaveBeenCalledOnce()

    rerender(
      <DestructiveConfirmActions
        confirmAriaLabel="永久删除对象"
        confirmLabel="确认删除"
        confirming
        message="删除此对象？"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestConfirm={onRequestConfirm}
        triggerLabel="删除"
      />
    )
    const dialog = screen.getByRole('alertdialog', {
      name: '永久删除对象'
    })
    const cancelButton = screen.getByRole('button', { name: '取消' })
    const confirmButton = screen.getByRole('button', {
      name: '永久删除对象'
    })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('删除此对象？')
    expect(cancelButton).toHaveFocus()

    fireEvent.keyDown(cancelButton, { key: 'Tab', shiftKey: true })
    expect(confirmButton).toHaveFocus()
    fireEvent.keyDown(confirmButton, { key: 'Tab' })
    expect(cancelButton).toHaveFocus()

    fireEvent.keyDown(cancelButton, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    fireEvent.click(confirmButton)
    expect(onConfirm).toHaveBeenCalledOnce()

    rerender(
      <DestructiveConfirmActions
        confirmAriaLabel="永久删除对象"
        confirmLabel="确认删除"
        confirming={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestConfirm={onRequestConfirm}
        triggerLabel="删除"
      />
    )
    expect(screen.getByRole('button', { name: '删除' })).toHaveFocus()
  })

  it('keeps focus on the dialog while destructive actions are disabled', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <DestructiveConfirmActions
        confirmLabel="确认删除"
        confirming={false}
        onCancel={onCancel}
        onConfirm={vi.fn()}
        onRequestConfirm={vi.fn()}
        triggerLabel="删除"
      />
    )

    rerender(
      <DestructiveConfirmActions
        confirmLabel="正在删除"
        confirming
        disabled
        onCancel={onCancel}
        onConfirm={vi.fn()}
        onRequestConfirm={vi.fn()}
        triggerLabel="删除"
      />
    )

    const dialog = screen.getByRole('alertdialog', {
      name: '正在删除'
    })
    expect(dialog).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(dialog).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it.each([
    [':root', 'light'],
    [":root[data-theme='dark']", 'dark']
  ])('keeps shared %s semantic tokens contrast-safe', (selector) => {
    const tokens = themeTokens(selector)
    const textPairs = [
      ['text-muted', 'surface-raised'],
      ['accent', 'accent-subtle'],
      ['success', 'success-subtle'],
      ['danger', 'danger-subtle'],
      ['text-on-accent', 'accent-solid'],
      ['text-on-accent', 'danger-solid']
    ] as const
    for (const [foreground, background] of textPairs) {
      expect(
        contrast(tokens[foreground]!, tokens[background]!),
        `${foreground} on ${background}`
      ).toBeGreaterThanOrEqual(4.5)
    }
    expect(
      contrast(tokens['border-control']!, tokens['surface-raised']!)
    ).toBeGreaterThanOrEqual(3)
  })
})
