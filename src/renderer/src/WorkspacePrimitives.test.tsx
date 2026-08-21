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
  SegmentedControl,
  ScopeBadge
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
    expect(stylesheet).toMatch(
      /--text-disabled:\s*#[\da-f]{6};/iu
    )
    expect(stylesheet).toMatch(/--z-dialog:\s*130;/u)
    expect(stylesheet).toMatch(/font-synthesis:\s*style/u)
    expect(stylesheet).toContain(
      '"Inter Variable", "Segoe UI Variable", "SF Pro Text", "PingFang SC"'
    )
    expect(stylesheet).toContain(
      '"Microsoft YaHei UI", "Noto Sans SC Variable"'
    )
    expect(stylesheet).toMatch(
      /\.nav-item span:nth-child\(2\)\s*\{[^}]*font-size:\s*var\(--font-body\);[^}]*font-weight:\s*500;/u
    )
    expect(stylesheet).toMatch(
      /\.section-label\s*\{[^}]*font-size:\s*var\(--font-caption\);[^}]*font-weight:\s*600;/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-item__primary\s*\{[^}]*font-size:\s*var\(--font-body\);/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-item small\s*\{[^}]*font-size:\s*var\(--font-caption\);/u
    )
    expect(stylesheet).toMatch(
      /\.markdown-content\s*\{[^}]*font-size:\s*14px;[^}]*line-height:\s*1\.65;/u
    )
    expect(stylesheet).toMatch(
      /\.composer__input textarea\s*\{[^}]*font-size:\s*14px;[^}]*line-height:\s*1\.6;/u
    )
  })

  it('exposes an unavailable scope explanation to assistive technology', () => {
    render(
      <ScopeBadge
        scope={{
          kind: 'unavailable',
          explanation: '项目已归档，请选择其他项目。'
        }}
      />
    )

    expect(
      screen.getByText('范围不可用')
    ).toHaveAccessibleDescription('项目已归档，请选择其他项目。')
  })

  it('labels multi-project scope distinctly from mixed global scope', () => {
    const { rerender } = render(
      <ScopeBadge
        scope={{
          kind: 'projects',
          projectCount: 2
        }}
      />
    )

    expect(screen.getByLabelText('2 个项目')).toHaveTextContent(
      '2 个项目'
    )
    expect(screen.queryByText(/全局/u)).not.toBeInTheDocument()

    rerender(<ScopeBadge scope={{ kind: 'mixed' }} />)
    expect(screen.getByLabelText('项目 + 全局')).toBeInTheDocument()
  })

  it('keeps forced-color and docked split contracts authoritative', () => {
    const forcedColorsStart = stylesheet.indexOf(
      '@media (forced-colors: active)'
    )
    const forcedColorsEnd = stylesheet.indexOf(
      '@media (prefers-reduced-motion: reduce)',
      forcedColorsStart
    )
    const forcedColors = stylesheet.slice(
      forcedColorsStart,
      forcedColorsEnd
    )
    expect(forcedColors).toContain(':root :is(')
    expect(forcedColors).not.toContain(':where(')
    expect(forcedColors).toMatch(
      /html:root\s+:is\(\s*\.assistant-sidebar__tab--active,\s*\.page-tabs__tab--active\s*\),\s*html:root\[data-theme='dark'\]\s+:is\(\s*\.assistant-sidebar__tab--active,\s*\.page-tabs__tab--active\s*\)\s*\{[^}]*border:\s*2px solid Highlight;[^}]*background:\s*Highlight;[^}]*color:\s*HighlightText;[^}]*forced-color-adjust:\s*none;/u
    )
    expect(forcedColors).toMatch(
      /\.task-status-dot--failed,[\s\S]*?forced-color-adjust:\s*none;/u
    )
    expect(forcedColors).toMatch(
      /:root \.conversation-task-child__completed-status\s*\{[^}]*color:\s*Canvas;/u
    )
    expect(forcedColors).toMatch(
      /\.heartbeat-center__meter\s*\{[^}]*forced-color-adjust:\s*none;/u
    )

    expect(stylesheet).toMatch(
      /\.assistant-sidebar--open\s*\{[^}]*width:\s*var\(--assistant-sidebar-width,\s*30%\);[^}]*flex-basis:\s*var\(--assistant-sidebar-width,\s*30%\);/u
    )
    expect(stylesheet).not.toContain('@media (max-width: 719px)')
    expect(stylesheet).toMatch(
      /\.composer-wrap\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*padding:\s*var\(--space-3\)\s*max\(var\(--page-gutter\),\s*calc\(\(100% - var\(--content-reading\)\) \/ 2\)\)\s*var\(--space-2\);/u
    )
    expect(stylesheet).toMatch(
      /\.assistant-sidebar__tabs\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(max-content,\s*1fr\)\);/u
    )
    expect(stylesheet).toMatch(
      /\.assistant-sidebar__tab\s*\{[^}]*white-space:\s*nowrap;/u
    )
    expect(stylesheet).toMatch(
      /\.app-frame\s*\{[^}]*display:\s*grid;[^}]*flex:\s*1;[^}]*grid-template-rows:\s*58px minmax\(0,\s*1fr\);/u
    )
    expect(stylesheet).toMatch(
      /\.app-shell\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*height:\s*100%;/u
    )
    expect(stylesheet).toMatch(
      /\.release-notes-backdrop\s*\{[^}]*position:\s*fixed;[^}]*background:\s*var\(--overlay-backdrop\);[^}]*inset:\s*0;/u
    )
    expect(stylesheet).toMatch(
      /\.app-content\s*\{[^}]*position:\s*relative;[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*height:\s*100%;/u
    )
    expect(stylesheet).toMatch(
      /\.workspace\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/u
    )
    expect(stylesheet).toMatch(
      /\.assistant-sidebar-toggle\s*\{[^}]*position:\s*absolute;[^}]*top:\s*6px;[^}]*right:\s*6px;/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-task-strip\s*\{[^}]*min-height:\s*46px;[^}]*padding:\s*0\s+max\(/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-task-strip__header\s*\{[^}]*min-height:\s*45px;/u
    )
    expect(stylesheet).toMatch(
      /@media \(max-width: 720px\)\s*\{[\s\S]*?\.conversation-task-strip\s*\{[^}]*padding-right:\s*46px;[^}]*padding-left:\s*var\(--space-3\);/u
    )
    expect(stylesheet).not.toMatch(
      /@media \(max-width: 720px\)\s*\{[\s\S]*?\.conversation-task-strip__header\s*\{[^}]*flex-direction:\s*column;/u
    )
    expect(stylesheet).toMatch(
      /\.task-center__filters \.segmented-control\s*\{[^}]*width:\s*100%;[^}]*overflow:\s*hidden;/u
    )
    expect(stylesheet).toMatch(
      /\.task-center__filters \.segmented-control__option\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1;/u
    )
  })

  it('floats Runtime context compaction without shifting the composer', () => {
    expect(stylesheet).toMatch(
      /\.composer-wrap\s*\{[^}]*var\(--space-2\);[^}]*background:\s*var\(--surface-raised\);/u
    )
    expect(stylesheet).toMatch(
      /\.composer-meta\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*26px;[^}]*margin:\s*var\(--space-1\) 0 0;/u
    )
    expect(stylesheet).toMatch(
      /\.composer-meta--with-context-compact\s*\{[^}]*padding-left:\s*calc\(/u
    )
    expect(stylesheet).toMatch(
      /\.composer-context-compact\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*0;[^}]*left:\s*0;/u
    )
  })

  it('keeps the conversation action close to the sidebar edge', () => {
    expect(stylesheet).toMatch(
      /\.conversation-row:has\(\.conversation-task-toggle\) \.conversation-item\s*\{[^}]*padding-left:\s*34px;/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-task-toggle\s*\{[^}]*left:\s*3px;[^}]*width:\s*28px;[^}]*height:\s*28px;/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-row \.conversation-item\s*\{[^}]*padding-right:\s*36px;/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-more\s*\{[^}]*right:\s*5px;/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-row:has\(\.conversation-activity-indicator\)\s+\.conversation-item\s*\{[^}]*padding-right:\s*52px;/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-activity-indicator\s*\{[^}]*right:\s*38px;/u
    )
    expect(stylesheet).not.toContain('.conversation-delete')
  })

  it('shows conversation provenance with a horizontal fork badge', () => {
    expect(stylesheet).toMatch(
      /\.conversation-branch-badge\s*\{[^}]*width:\s*20px;[^}]*height:\s*18px;[^}]*background:\s*var\(--accent-subtle\);[^}]*color:\s*var\(--accent\);/u
    )
    expect(stylesheet).toMatch(
      /\.conversation-branch-badge svg,\s*\.conversation-branch-icon\s*\{[^}]*transform:\s*rotate\(90deg\);/u
    )
  })

  it('uses the shared control and menu surfaces for the rich project picker', () => {
    expect(stylesheet).toMatch(
      /\.project-switcher__trigger\s*\{[^}]*height:\s*var\(--control-height\);[^}]*border-radius:\s*var\(--radius-control\);[^}]*background:\s*var\(--surface-raised\);/u
    )
    expect(stylesheet).toMatch(
      /\.project-switcher__menu\s*\{[^}]*border-radius:\s*var\(--radius-card\);[^}]*background:\s*var\(--surface-raised\);[^}]*box-shadow:\s*var\(--shadow-dialog\);/u
    )
  })

  it('keeps project forms and disabled actions visually consistent', () => {
    expect(stylesheet).toMatch(
      /\.project-create-card label > span\s*\{[^}]*font-size:\s*var\(--font-caption\);/u
    )
    expect(stylesheet).toMatch(
      /\.project-create-card input,\s*\.project-create-card textarea,\s*\.project-create-card select\s*\{[^}]*font-size:\s*var\(--font-body\);/u
    )
    expect(stylesheet).toMatch(
      /\.project-create-card label > small\s*\{[^}]*font-size:\s*var\(--font-caption\);/u
    )
    expect(stylesheet).toMatch(
      /\.project-create-card__error\s*\{[^}]*font-size:\s*var\(--font-caption\);/u
    )
    expect(stylesheet).toMatch(
      /\.field > span\s*\{[^}]*font-size:\s*var\(--font-caption\);/u
    )
    expect(stylesheet).toMatch(
      /\.field input,\s*\.field textarea,\s*\.field select\s*\{[^}]*font-size:\s*var\(--font-body\);/u
    )
    expect(stylesheet).toMatch(
      /\.field small\s*\{[^}]*font-size:\s*var\(--font-caption\);/u
    )
    expect(stylesheet).toMatch(
      /\.primary-button:disabled\s*\{[^}]*cursor:\s*not-allowed;/u
    )
    expect(stylesheet).toMatch(
      /\.secondary-button:disabled\s*\{[^}]*cursor:\s*not-allowed;/u
    )
    expect(stylesheet).toMatch(
      /\.danger-button:disabled\s*\{[^}]*cursor:\s*not-allowed;/u
    )
    expect(stylesheet).toContain(
      '.primary-button:hover:not(:disabled)'
    )
    expect(stylesheet).toContain(
      '.danger-button:hover:not(:disabled)'
    )
    expect(stylesheet).not.toMatch(
      /\.primary-button:disabled\s*\{[^}]*cursor:\s*wait;/u
    )
  })

  it('separates Runtime-specific controls from the main composer toolbar', () => {
    expect(stylesheet).toMatch(
      /\.composer__toolbar--with-runtime-controls\s*\{[^}]*border-radius:\s*0;/u
    )
    expect(stylesheet).toMatch(
      /\.composer__runtime-toolbar\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*52px;[^}]*border-top:\s*1px solid var\(--border-default\);[^}]*background:\s*var\(--surface-muted\);/u
    )
    expect(stylesheet).toMatch(
      /\.composer__runtime-controls\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/u
    )
    expect(stylesheet).toMatch(
      /\.composer-picker--runtime > \.model-button,\s*\.composer-picker--runtime-action > \.model-button\s*\{[^}]*width:\s*220px;/u
    )
    expect(stylesheet).toMatch(
      /\.composer__runtime-controls \.composer-picker\s*\{[^}]*flex-basis:\s*220px;/u
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

  it('keeps DSH marketplace search text clear of its icon', () => {
    expect(stylesheet).toMatch(
      /\.field \.runtime-extension-marketplace__search-input > input\s*\{[^}]*padding-left:\s*34px;/u
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

  it('keeps full-page settings navigation readable and content fluid', () => {
    expect(stylesheet).toMatch(
      /\.settings-page \.settings-panel__header\s*\{[^}]*padding:\s*var\(--page-gutter\) var\(--page-gutter\) 0;/u
    )
    expect(stylesheet).toMatch(
      /\.settings-page \.settings-panel__header \.page-header\s*\{[^}]*padding-bottom:\s*var\(--space-4\);[^}]*border-bottom:\s*1px solid var\(--border-subtle\);/u
    )
    expect(stylesheet).toMatch(
      /\.settings-page \.settings-panel__body\s*\{[^}]*padding:\s*var\(--space-6\) var\(--page-gutter\) var\(--page-gutter\);[^}]*grid-template-columns:\s*220px minmax\(0,\s*1fr\);/u
    )
    expect(stylesheet).toMatch(
      /@media \(max-width: 1020px\)\s*\{[\s\S]*?\.settings-page \.settings-panel__body\s*\{[^}]*grid-template-columns:\s*196px minmax\(0,\s*1fr\);/u
    )
    expect(stylesheet).toMatch(
      /\.settings-page \.settings-tabs\s*\{[^}]*scrollbar-gutter:\s*auto;/u
    )
    expect(stylesheet).toMatch(
      /\.settings-page \.settings-panel__content\s*\{[^}]*width:\s*min\(100%,\s*var\(--content-standard\)\);/u
    )
    expect(stylesheet).toMatch(
      /\.settings-page \.settings-tabs button strong\s*\{[^}]*font-size:\s*var\(--font-body\);/u
    )
    expect(stylesheet).toMatch(
      /\.settings-page \.settings-tabs button small\s*\{[^}]*font-size:\s*var\(--font-caption\);/u
    )
  })

  it('keeps Runtime customization hierarchy and dangerous actions clear', () => {
    expect(stylesheet).toMatch(
      /\.runtime-customization-section__header strong\s*\{[^}]*font-size:\s*var\(--font-section-title\);/u
    )
    expect(stylesheet).toMatch(
      /\.runtime-customization-editor\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;/u
    )
    expect(stylesheet).toMatch(
      /\.runtime-native-inventory__status\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*42px;/u
    )
    expect(stylesheet).not.toContain(
      '.runtime-native-inventory__header'
    )
    expect(stylesheet).toMatch(
      /\.runtime-customization-section__dirty\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/u
    )
    expect(stylesheet).toMatch(
      /\.danger-ghost\s*\{[^}]*color:\s*var\(--danger\);[^}]*font-size:\s*var\(--font-caption\);/u
    )
    expect(stylesheet).toMatch(
      /\.danger-ghost:disabled\s*\{[^}]*color:\s*var\(--text-muted\);[^}]*cursor:\s*not-allowed;/u
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
    expect(dialog).not.toHaveAttribute('aria-modal')
    expect(dialog).toHaveAccessibleDescription('删除此对象？')
    expect(cancelButton).toHaveFocus()

    expect(
      fireEvent.keyDown(cancelButton, { key: 'Tab', shiftKey: true })
    ).toBe(true)
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

  it('keeps focus on the inline confirmation while actions are disabled', () => {
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
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(true)
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
