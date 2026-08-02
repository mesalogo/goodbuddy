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
        confirmLabel="确认删除"
        confirming={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestConfirm={onRequestConfirm}
        triggerLabel="删除"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onRequestConfirm).toHaveBeenCalledOnce()

    rerender(
      <DestructiveConfirmActions
        confirmLabel="确认删除"
        confirming
        message="删除此对象？"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onRequestConfirm={onRequestConfirm}
        triggerLabel="删除"
      />
    )
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
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
