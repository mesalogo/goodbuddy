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

  it('renders inline and display LaTeX formulas with KaTeX', () => {
    const { container } = render(
      <MarkdownRenderer>{`质能方程为 $E = mc^2$。

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$`}</MarkdownRenderer>
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('.katex-display')).toBeInTheDocument()
    expect(
      container.querySelector(
        'annotation[encoding="application/x-tex"]'
      )
    ).toHaveTextContent('E = mc^2')
    expect(
      [...container.querySelectorAll(
        'annotation[encoding="application/x-tex"]'
      )].at(-1)
    ).toHaveTextContent('\\int_0^1 x^2\\,dx = \\frac{1}{3}')
  })

  it('supports common model-style LaTeX delimiters outside code', () => {
    const { container } = render(
      <MarkdownRenderer>{`行内公式 \\(a^2 + b^2 = c^2\\)。

\\[
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
\\]

\\[ \\sqrt{x^2} = |x| \\]

\`\\(not rendered\\)\`

\`\`\`tex
\\[
also not rendered
\\]
\`\`\``}</MarkdownRenderer>
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(3)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(2)
    expect(screen.getByText('\\(not rendered\\)')).toBeInTheDocument()
    expect(screen.getByText(/also not rendered/u)).toBeInTheDocument()
    expect(container.querySelectorAll('code .katex')).toHaveLength(0)
  })

  it('promotes formulas that occupy a whole line to centered display math', () => {
    const { container } = render(
      <MarkdownRenderer>{`段落内仍是 $E = mc^2$ 行内公式。

$S(A) = \\frac{\\operatorname{Area}(\\gamma_A)}{4G_N}$

\\(S \\leq \\frac{A}{4G_N}\\)`}</MarkdownRenderer>
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(3)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(2)
    expect(
      container.querySelector(
        'p:first-child .katex-display'
      )
    ).not.toBeInTheDocument()
    for (const display of container.querySelectorAll('.katex-display')) {
      expect(display.querySelector(':scope > .katex')).toBeInTheDocument()
    }
  })

  it('shows invalid formulas without crashing or rendering raw HTML', () => {
    const { container } = render(
      <MarkdownRenderer>{`$\\notARealCommand{value}$

$\\href{javascript:alert(1)}{unsafe}$`}</MarkdownRenderer>
    )

    expect(
      container.querySelector(
        'annotation[encoding="application/x-tex"]'
      )
    ).toHaveTextContent('\\notARealCommand{value}')
    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container).toHaveTextContent(
      '\\notARealCommand'
    )
    expect(container.querySelector('script')).not.toBeInTheDocument()
    expect(
      container.querySelector('a[href^="javascript:"]')
    ).not.toBeInTheDocument()
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
