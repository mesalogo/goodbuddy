import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { changeUiLocale } from './i18n'
import {
  InlineMarkdown,
  MarkdownRenderer
} from './MarkdownRenderer'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn()
}))

vi.mock('mermaid', () => ({
  default: mermaidMock
}))

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    mermaidMock.render.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
        <rect id="safe-node" width="100" height="50" />
      </svg>`
    })
  })

  afterEach(() => {
    cleanup()
    delete document.documentElement.dataset.theme
    vi.clearAllMocks()
  })

  it('renders bounded inline emphasis without links or raw HTML', () => {
    const { container } = render(
      <p>
        <InlineMarkdown>
          {'**明确标题。** 查看[外部页面](https://example.com)。<script>bad()</script>'}
        </InlineMarkdown>
      </p>
    )

    expect(screen.getByText('明确标题。').tagName).toBe('STRONG')
    expect(container).toHaveTextContent('外部页面')
    expect(container.querySelector('a')).not.toBeInTheDocument()
    expect(container.querySelector('script')).not.toBeInTheDocument()
  })

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

  it('renders fenced HTML as an isolated static preview when enabled', () => {
    render(
      <MarkdownRenderer renderHtml>{`\`\`\`html
<!doctype html>
<html>
  <head>
    <style>body { color: navy; }</style>
    <script>window.bad = true</script>
  </head>
  <body>
    <h1>HTML dashboard</h1>
    <img src="https://tracker.example/pixel.png" onerror="bad()">
    <form action="https://example.com"><button>Send</button></form>
  </body>
</html>
\`\`\``}</MarkdownRenderer>
    )

    const preview = screen.getByTitle('Agent 回复 HTML 静态预览')
    const source = preview.getAttribute('srcdoc') ?? ''
    expect(preview).toHaveAttribute('sandbox', '')
    expect(preview).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(source).toContain('HTML dashboard')
    expect(source).toContain("default-src 'none'")
    expect(source).not.toContain('<script')
    expect(source).not.toContain('<form')
    expect(source).not.toContain('https://tracker.example')
    expect(
      screen.getByText('静态安全预览，脚本和网络已禁用')
    ).toBeInTheDocument()

    const sourceButton = screen.getByRole('button', {
      name: '查看源码'
    })
    expect(sourceButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(sourceButton)
    expect(screen.getByText(/window\.bad = true/u)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '隐藏源码' })
    ).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: '隐藏源码' }))
    expect(
      screen.queryByText(/window\.bad = true/u)
    ).not.toBeInTheDocument()
  })

  it('opens and closes the full-screen HTML preview', () => {
    render(
      <div className="app-shell">
        <MarkdownRenderer renderHtml>{`\`\`\`html
<section><h1>Full screen page</h1></section>
\`\`\``}</MarkdownRenderer>
      </div>
    )

    const viewerButton = screen.getByRole('button', {
      name: '全屏预览'
    })
    viewerButton.focus()
    fireEvent.click(viewerButton)

    const dialog = screen.getByRole('dialog', {
      name: 'HTML 全屏预览'
    })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const closeButton = screen.getByRole('button', {
      name: '关闭全屏预览'
    })
    expect(closeButton).toHaveFocus()
    expect(
      document.querySelector<HTMLElement>('.app-shell')?.inert
    ).toBe(true)

    const frame = screen.getByTitle('Agent 回复 HTML 全屏静态预览')
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(frame.getAttribute('srcdoc') ?? '').toContain(
      'Full screen page'
    )

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(viewerButton).toHaveFocus()
  })

  it('keeps author stylesheets and inline styles in the preview', () => {
    render(
      <MarkdownRenderer renderHtml>{`\`\`\`html
<!doctype html>
<html>
  <head>
    <style>
      body { background: #101014; color: #f5f5f7; }
      .hero { background-image: url(https://cdn.example/bg.png); }
      @import url("https://fonts.example/inter.css");
    </style>
  </head>
  <body>
    <section class="hero" style="padding: 24px; background: url(https://cdn.example/b.png)">
      Styled hero
    </section>
  </body>
</html>
\`\`\``}</MarkdownRenderer>
    )

    const source =
      screen
        .getByTitle('Agent 回复 HTML 静态预览')
        .getAttribute('srcdoc') ?? ''
    expect(source).toContain('background: #101014')
    expect(source).toContain('.hero {')
    expect(source).toContain('padding: 24px')
  })

  it('renders a complete HTML reply directly and keeps HTML as code when disabled', () => {
    const source = '<html><body><main>Complete page</main></body></html>'
    const { rerender } = render(
      <MarkdownRenderer renderHtml>{source}</MarkdownRenderer>
    )

    expect(
      screen.getByTitle('Agent 回复 HTML 静态预览')
    ).toHaveAttribute('sandbox', '')

    rerender(
      <MarkdownRenderer>{source}</MarkdownRenderer>
    )
    expect(
      screen.queryByTitle('Agent 回复 HTML 静态预览')
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(source, { exact: true })
    ).toBeInTheDocument()
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

  it('renders Mermaid fences with strict bounded configuration', async () => {
    const { container } = render(
      <MarkdownRenderer>{`\`\`\`mermaid
flowchart LR
  Start --> Finish
\`\`\``}</MarkdownRenderer>
    )

    expect(
      screen.getByText('正在绘制 Mermaid 图表…')
    ).toHaveAttribute('role', 'status')
    const diagram = await screen.findByRole('region', {
      name: 'Mermaid 图表，可横向滚动'
    })

    expect(diagram).toHaveAttribute('tabindex', '0')
    expect(container.querySelector('#safe-node')).toBeInTheDocument()
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringMatching(/^goodbuddy-mermaid-\d+-0$/u),
      'flowchart LR\n  Start --> Finish'
    )
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily:
          '"Inter Variable", "Segoe UI Variable", "SF Pro Text", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC Variable", "Noto Sans CJK SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
        htmlLabels: false,
        maxEdges: 300,
        maxTextSize: 20_000,
        securityLevel: 'strict',
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: 'default'
      })
    )
  })

  it('shows source and opens an accessible zoomable Mermaid viewer', async () => {
    render(
      <div className="app-shell">
        <MarkdownRenderer>{`\`\`\`mermaid
flowchart LR
  Start --> Finish
\`\`\``}</MarkdownRenderer>
      </div>
    )

    await screen.findByRole('region', {
      name: 'Mermaid 图表，可横向滚动'
    })
    const sourceButton = screen.getByRole('button', {
      name: '查看源码'
    })
    expect(sourceButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(sourceButton)
    expect(
      screen.getByRole('button', { name: '隐藏源码' })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Start --> Finish/u)).toBeInTheDocument()

    const viewerButton = screen.getByRole('button', {
      name: '打开大图'
    })
    viewerButton.focus()
    fireEvent.click(viewerButton)
    const dialog = screen.getByRole('dialog', {
      name: 'Mermaid 大图'
    })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(
      screen.getByRole('button', { name: '关闭 Mermaid 大图' })
    ).toHaveFocus()
    expect(
      document.querySelector<HTMLElement>('.app-shell')?.inert
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '放大图表' }))
    expect(screen.getByLabelText('当前缩放比例')).toHaveTextContent(
      '125%'
    )
    const canvas = screen.getByRole('region', {
      name: '可缩放、可拖动的 Mermaid 图表'
    })
    expect(canvas).toHaveAttribute('tabindex', '0')
    canvas.focus()
    expect(canvas).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(
      screen.getByRole('button', { name: '缩小图表' })
    ).toHaveFocus()
    fireEvent.wheel(canvas, { deltaY: -100 })
    fireEvent.wheel(canvas, { deltaY: -100 })
    fireEvent.wheel(canvas, { deltaY: -100 })
    await waitFor(() =>
      expect(screen.getByLabelText('当前缩放比例')).toHaveTextContent(
        '200%'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: '重置缩放' }))
    expect(screen.getByLabelText('当前缩放比例')).toHaveTextContent(
      '100%'
    )

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(viewerButton).toHaveFocus())
    expect(
      document.querySelector<HTMLElement>('.app-shell')?.inert
    ).toBe(false)
  })

  it('closes Mermaid controls when streamed source changes', async () => {
    const { rerender } = render(
      <MarkdownRenderer>{`\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``}</MarkdownRenderer>
    )
    await screen.findByRole('region', {
      name: 'Mermaid 图表，可横向滚动'
    })
    fireEvent.click(screen.getByRole('button', { name: '查看源码' }))
    fireEvent.click(screen.getByRole('button', { name: '打开大图' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    rerender(
      <MarkdownRenderer>{`\`\`\`mermaid
flowchart LR
  A --> B --> C
\`\`\``}</MarkdownRenderer>
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await screen.findByRole('region', {
      name: 'Mermaid 图表，可横向滚动'
    })
    expect(
      screen.getByRole('button', { name: '查看源码' })
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/A --> B --> C/u)).not.toBeInTheDocument()
  })

  it('pans the large Mermaid diagram with pointer dragging', async () => {
    render(
      <MarkdownRenderer>{`\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``}</MarkdownRenderer>
    )
    await screen.findByRole('region', {
      name: 'Mermaid 图表，可横向滚动'
    })
    fireEvent.click(screen.getByRole('button', { name: '打开大图' }))
    const canvas = screen.getByRole('region', {
      name: '可缩放、可拖动的 Mermaid 图表'
    })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(canvas, {
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: releasePointerCapture }
    })
    canvas.scrollLeft = 30
    canvas.scrollTop = 40

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 9
    })
    fireEvent.pointerMove(canvas, {
      clientX: 70,
      clientY: 60,
      pointerId: 9
    })

    expect(setPointerCapture).toHaveBeenCalledWith(9)
    expect(canvas).toHaveClass('mermaid-viewer__canvas--dragging')
    expect(canvas.scrollLeft).toBe(60)
    expect(canvas.scrollTop).toBe(80)

    fireEvent.pointerUp(canvas, { pointerId: 9 })
    expect(releasePointerCapture).toHaveBeenCalledWith(9)
    expect(canvas).not.toHaveClass(
      'mermaid-viewer__canvas--dragging'
    )
  })

  it('sanitizes Mermaid SVG without enabling diagram interactions', async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
        <style>@\\69mport url("https://unsafe.test/style.css");</style>
        <script>window.bad = true</script>
        <a href="javascript:alert(1)">
          <rect id="unsafe-node" onclick="alert(1)"
            style="fill: url(javascript:alert(1))" width="100" height="50" />
        </a>
        <rect id="safe-node" fill="url(#gradient)" width="20" height="20" />
      </svg>`
    })

    const { container } = render(
      <MarkdownRenderer>{`\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``}</MarkdownRenderer>
    )

    await screen.findByRole('region', {
      name: 'Mermaid 图表，可横向滚动'
    })
    expect(container.querySelector('script')).not.toBeInTheDocument()
    expect(container.querySelector('a')).not.toBeInTheDocument()
    expect(container.querySelector('style')).not.toBeInTheDocument()
    expect(container.querySelector('#unsafe-node')).not.toHaveAttribute(
      'onclick'
    )
    expect(container.querySelector('#unsafe-node')).not.toHaveAttribute(
      'style'
    )
    expect(container.querySelector('#safe-node')).toHaveAttribute(
      'fill',
      'url(#gradient)'
    )
  })

  it('rerenders Mermaid diagrams when the application theme changes', async () => {
    render(
      <MarkdownRenderer>{`\`\`\`mermaid
sequenceDiagram
  Alice->>Bob: Hello
\`\`\``}</MarkdownRenderer>
    )

    await waitFor(() =>
      expect(mermaidMock.render).toHaveBeenCalledTimes(1)
    )
    act(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await waitFor(() =>
      expect(mermaidMock.render).toHaveBeenCalledTimes(2)
    )
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        darkMode: true,
        theme: 'dark'
      })
    )
  })

  it('shows Mermaid source when rendering fails or input is oversized', async () => {
    mermaidMock.render.mockRejectedValueOnce(
      new Error('Invalid Mermaid syntax')
    )
    const { rerender } = render(
      <MarkdownRenderer>{`\`\`\`mermaid
not a diagram
\`\`\``}</MarkdownRenderer>
    )

    expect(
      await screen.findByRole('alert')
    ).toHaveTextContent('无法绘制 Mermaid 图表')
    expect(screen.getByText('not a diagram')).toBeInTheDocument()

    rerender(
      <MarkdownRenderer>{`\`\`\`mermaid
${'A'.repeat(20_001)}
\`\`\``}</MarkdownRenderer>
    )
    expect(
      await screen.findByRole('alert')
    ).toHaveTextContent('无法绘制 Mermaid 图表')
    expect(mermaidMock.render).toHaveBeenCalledTimes(1)
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
