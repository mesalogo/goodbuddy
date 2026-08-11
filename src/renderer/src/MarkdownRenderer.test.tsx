import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { changeUiLocale } from './i18n'
import { MarkdownRenderer } from './MarkdownRenderer'

describe('MarkdownRenderer', () => {
  afterEach(cleanup)

  it('renders CommonMark and GitHub Flavored Markdown', () => {
    render(
      <MarkdownRenderer>{`# 标题

- [x] 已完成

| 名称 | 数量 |
| --- | ---: |
| Token | 42 |

\`\`\`ts
const ready = true
\`\`\``}</MarkdownRenderer>
    )

    expect(
      screen.getByRole('heading', { name: '标题', level: 1 })
    ).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: '表格，可横向滚动' })
    ).toContainElement(screen.getByRole('table'))
    expect(screen.getByText('const ready = true')).toBeInTheDocument()
  })

  it('opens safe links externally and does not render raw HTML', () => {
    const { container } = render(
      <MarkdownRenderer>{`[Factory](https://factory.ai)

[不安全链接](javascript:alert(1))

<script>window.bad = true</script>`}</MarkdownRenderer>
    )

    expect(screen.getByRole('link', { name: 'Factory' })).toHaveAttribute(
      'rel',
      'noopener noreferrer'
    )
    expect(screen.getByRole('link', { name: 'Factory' })).toHaveAttribute(
      'target',
      '_blank'
    )
    expect(
      screen.getByText('不安全链接').closest('a')?.getAttribute('href') ??
        ''
    ).not.toMatch(/^javascript:/u)
    expect(container.querySelector('script')).not.toBeInTheDocument()
  })

  it('renders a whole Markdown fence as formatted content', () => {
    const { container } = render(
      <MarkdownRenderer>{`\`\`\`markdown
# 方案标题

- 第一步
- 第二步
\`\`\``}</MarkdownRenderer>
    )

    expect(
      screen.getByRole('heading', { name: '方案标题', level: 1 })
    ).toBeInTheDocument()
    expect(screen.getByText('第一步')).toBeInTheDocument()
    expect(container.querySelector('pre')).not.toBeInTheDocument()
  })

  it('updates table accessibility copy when the locale changes', async () => {
    render(
      <MarkdownRenderer>{`| Name |
| --- |
| GoodBuddy |`}</MarkdownRenderer>
    )

    await changeUiLocale('en-US')
    expect(
      screen.getByRole('region', {
        name: 'Table, horizontally scrollable'
      })
    ).toBeInTheDocument()
    await changeUiLocale('zh-CN')
  })
})
