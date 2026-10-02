import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeUiLocale } from './i18n'
import {
  blockMarkdownPipeline,
  getMarkdown,
  hastToReact,
  lookupMarkdown,
  parseMarkdown,
  markdownRenderCache,
  storeMarkdown,
  type MarkdownPipeline
} from './markdown-render-cache'
import {
  MarkdownRenderer,
  normalizeLatexDelimiters,
  splitMarkdownSegments,
  UnsegmentedMarkdownRenderer
} from './MarkdownRenderer'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    })
  }
}))

/** Lets the deferred unmount store (queueMicrotask) run. */
async function flushUnmountStores(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function canonicalHtml(element: HTMLElement): string {
  const ids = new Map<string, string>()
  const clone = element.cloneNode(true) as HTMLElement
  for (const node of clone.querySelectorAll('*')) {
    for (const name of ['id', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'for']) {
      const value = node.getAttribute(name)
      if (value && /_r_[a-z0-9]+_/u.test(value)) {
        if (!ids.has(value)) ids.set(value, `id-${ids.size}`)
        node.setAttribute(name, ids.get(value)!)
      }
    }
  }
  return clone.innerHTML
}

function segmentsOf(content: string): string[] {
  return splitMarkdownSegments(normalizeLatexDelimiters(content))
}

const corpus: { content: string; name: string; renderHtml?: boolean }[] = [
  {
    content: '# Title\n\nInline $E = mc^2$ and \\(a+b\\).\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n\\[x^2\\]\n\nInvalid $\\frac{1}{$ math\n\nend',
    name: 'KaTeX'
  },
  {
    content: 'Code:\n\n```ts\nconst value = "\\(literal\\)"\n\nconsole.log(value)\n```\n\n~~~\nplain\n~~~\n\n    indented\n\nafter `inline`',
    name: 'code'
  },
  {
    content: '| Name | Count |\n| --- | ---: |\n| Token | 42 |\n\n- [x] done\n- [ ] todo\n\n~~strike~~ https://example.com',
    name: 'tables'
  },
  {
    content: 'See [ref] and a note[^1].\n\n[ref]: https://example.com\n\n[^1]: Footnote body with $x$.',
    name: 'footnotes'
  },
  {
    content: '[Safe](https://factory.ai)\n\n[Unsafe](javascript:alert(1))\n\n<script>bad()</script>\n\n![img](https://example.com/a.png)',
    name: 'links and raw HTML'
  },
  {
    content: 'Before\n\n```html\n<section><h1>Preview page</h1></section>\n```\n\nAfter',
    name: 'HTML fence, HTML mode on',
    renderHtml: true
  },
  {
    content: 'Before\n\n```html\n<section><h1>Preview page</h1></section>\n```\n\nAfter',
    name: 'HTML fence, HTML mode off',
    renderHtml: false
  },
  {
    content: '```markdown\n# Wrapped\n\n- a\n- b\n```',
    name: 'whole Markdown fence'
  },
  {
    content: Array.from({ length: 20 }, (_, i) => `## Part ${i}\n\nParagraph **${i}** with $x_${i}$.\n\n> quote ${i}`).join('\n\n'),
    name: 'many segments'
  }
]

describe('Markdown render cache', () => {
  beforeEach(() => {
    markdownRenderCache.clear()
    markdownRenderCache.resetLimits()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: { app: { onPreviewEscape: vi.fn(() => () => undefined) } }
    })
  })

  afterEach(() => {
    cleanup()
    markdownRenderCache.clear()
    markdownRenderCache.resetLimits()
  })

  it.each(corpus)('renders a cache hit identically to an uncached render: $name', async ({ content, renderHtml }) => {
    const reference = render(<div><UnsegmentedMarkdownRenderer renderHtml={renderHtml}>{content}</UnsegmentedMarkdownRenderer></div>)
    const expected = canonicalHtml(reference.container)
    reference.unmount()

    const first = render(<div><MarkdownRenderer renderHtml={renderHtml}>{content}</MarkdownRenderer></div>)
    expect(canonicalHtml(first.container)).toBe(expected)
    const parsesAfterFirst = markdownRenderCache.stats().parses
    first.unmount()
    await flushUnmountStores()

    expect(markdownRenderCache.stats().entries).toBeGreaterThan(0)

    const second = render(<div><MarkdownRenderer renderHtml={renderHtml}>{content}</MarkdownRenderer></div>)
    expect(canonicalHtml(second.container)).toBe(expected)
    // The remount did not run unified at all.
    expect(markdownRenderCache.stats().parses).toBe(parsesAfterFirst)
  })

  it('applies per-mount options to shared trees without leaking them between mounts', async () => {
    const content = 'Intro\n\n```html\n<section><h1>Shared</h1></section>\n```\n\n| a |\n| - |\n| 1 |'
    render(<MarkdownRenderer>{content}</MarkdownRenderer>).unmount()
    await flushUnmountStores()
    const parses = markdownRenderCache.stats().parses

    // HTML mode is applied by per-mount components, so the cached tree can
    // be reused while the output follows the prop.
    const htmlOn = render(<MarkdownRenderer renderHtml>{content}</MarkdownRenderer>)
    const htmlOff = render(<MarkdownRenderer>{content}</MarkdownRenderer>)
    expect(markdownRenderCache.stats().parses).toBe(parses)
    expect(htmlOn.container.querySelector('iframe[sandbox]')).not.toBeNull()
    expect(htmlOn.container.querySelector('code.language-html')).toBeNull()
    expect(htmlOff.container.querySelector('iframe')).toBeNull()
    expect(htmlOff.container.querySelector('code.language-html')).toHaveTextContent('<section>')

    // Locale-dependent labels are not frozen into cache entries.
    await act(async () => {
      await changeUiLocale('en-US')
    })
    const english = render(<MarkdownRenderer>{content}</MarkdownRenderer>)
    const label = english.container.querySelector('.markdown-table-scroll')!.getAttribute('aria-label')
    await act(async () => {
      await changeUiLocale('zh-CN')
    })
    const chinese = render(<MarkdownRenderer>{content}</MarkdownRenderer>)
    expect(chinese.container.querySelector('.markdown-table-scroll')!.getAttribute('aria-label')).not.toBe(label)
    expect(markdownRenderCache.stats().parses).toBe(parses)
  })

  it('keys entries by pipeline so different configurations never share trees', () => {
    const other: MarkdownPipeline = {
      ...blockMarkdownPipeline,
      id: 'other-config',
      skipHtml: false
    }
    const source = 'a <b>raw</b> c'
    storeMarkdown(source, blockMarkdownPipeline, getMarkdown(source, blockMarkdownPipeline))
    expect(lookupMarkdown(source, other)).toBeUndefined()
    const raw = getMarkdown(source, other)
    storeMarkdown(source, other, raw)
    expect(markdownRenderCache.keys()).toHaveLength(2)
    expect(lookupMarkdown(source, other)!.tree).toBe(raw.tree)
    expect(lookupMarkdown(source, blockMarkdownPipeline)!.tree).not.toBe(raw.tree)
    expect(JSON.stringify(raw.tree)).toContain('<b>')
    expect(JSON.stringify(lookupMarkdown(source, blockMarkdownPipeline)!.tree)).not.toContain('<b>')
  })

  it('does not cache streaming prefixes of the growing final segment', async () => {
    const content = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} with **bold** and $x_${i}$ math.`).join('\n\n')
    const view = render(<MarkdownRenderer>{''}</MarkdownRenderer>)
    let renders = 0
    for (let end = 1; end <= content.length; end += 3) {
      view.rerender(<MarkdownRenderer>{content.slice(0, end)}</MarkdownRenderer>)
      renders++
    }
    view.rerender(<MarkdownRenderer>{content}</MarkdownRenderer>)
    await flushUnmountStores()
    expect(renders).toBeGreaterThan(100)

    const segments = segmentsOf(content)
    expect(segments).toHaveLength(12)
    // Only complete segments are stored while the message is mounted.
    expect(markdownRenderCache.keys()).toHaveLength(segments.length - 1)
    for (const segment of segments.slice(0, -1)) {
      expect(markdownRenderCache.has(segment)).toBe(true)
    }
    expect(markdownRenderCache.has(segments.at(-1)!)).toBe(false)

    // Unmounting (scrolled out of the window) stores the final text once.
    view.unmount()
    await flushUnmountStores()
    expect(markdownRenderCache.keys()).toHaveLength(segments.length)
    expect(markdownRenderCache.has(segments.at(-1)!)).toBe(true)
  })

  it('does not store the final segment on StrictMode effect replays', async () => {
    const view = render(<StrictMode><MarkdownRenderer>{'first\n\nsecond'}</MarkdownRenderer></StrictMode>)
    view.rerender(<StrictMode><MarkdownRenderer>{'first\n\nsecond, longer'}</MarkdownRenderer></StrictMode>)
    await flushUnmountStores()
    expect(markdownRenderCache.has('first\n\n')).toBe(true)
    expect(markdownRenderCache.has('second')).toBe(false)
    expect(markdownRenderCache.has('second, longer')).toBe(false)
    view.unmount()
    await flushUnmountStores()
    expect(markdownRenderCache.has('second')).toBe(false)
    expect(markdownRenderCache.has('second, longer')).toBe(true)
  })

  it('respects entry, character and node bounds with LRU eviction', async () => {
    markdownRenderCache.configure({ maxChars: 1_000_000, maxEntries: 5, maxNodes: 1_000_000 })
    for (let i = 0; i < 12; i++) {
      render(<MarkdownRenderer>{`message ${i}`}</MarkdownRenderer>).unmount()
    }
    await flushUnmountStores()
    expect(markdownRenderCache.stats().entries).toBe(5)
    expect(markdownRenderCache.has('message 6')).toBe(false)
    expect(markdownRenderCache.has('message 7')).toBe(true)

    // A hit refreshes recency: message 7 survives the next insertion.
    render(<MarkdownRenderer>{'message 7'}</MarkdownRenderer>)
    cleanup()
    render(<MarkdownRenderer>{'message 12'}</MarkdownRenderer>).unmount()
    await flushUnmountStores()
    expect(markdownRenderCache.has('message 7')).toBe(true)
    expect(markdownRenderCache.has('message 8')).toBe(false)

    markdownRenderCache.clear()
    markdownRenderCache.configure({ maxChars: 400, maxEntries: 1000 })
    const text = (i: number) => `${String(i).padStart(3, '0')} ${'x'.repeat(96)}`
    for (let i = 0; i < 20; i++) {
      render(<MarkdownRenderer>{text(i)}</MarkdownRenderer>).unmount()
    }
    await flushUnmountStores()
    expect(markdownRenderCache.stats().totalChars).toBeLessThanOrEqual(400)
    expect(markdownRenderCache.stats().entries).toBe(4)
    expect(markdownRenderCache.has(text(19))).toBe(true)
    expect(markdownRenderCache.has(text(15))).toBe(false)

    // A source over a quarter of the budget is never stored.
    render(<MarkdownRenderer>{'y'.repeat(150)}</MarkdownRenderer>).unmount()
    await flushUnmountStores()
    expect(markdownRenderCache.has('y'.repeat(150))).toBe(false)
    expect(markdownRenderCache.stats().entries).toBe(4)

    markdownRenderCache.clear()
    markdownRenderCache.configure({ maxChars: 1_000_000, maxNodes: 200 })
    for (let i = 0; i < 10; i++) {
      render(<MarkdownRenderer>{`$x_${i}$`}</MarkdownRenderer>).unmount()
    }
    await flushUnmountStores()
    expect(markdownRenderCache.stats().totalNodes).toBeLessThanOrEqual(200)
    expect(markdownRenderCache.stats().evictions).toBeGreaterThan(0)
  })

  it('keeps interactive elements working after a cache hit', async () => {
    const content = '[Factory](https://factory.ai)\n\n```html\n<section><h1>Interactive</h1></section>\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n\nend'
    render(<MarkdownRenderer renderHtml>{content}</MarkdownRenderer>).unmount()
    await flushUnmountStores()
    const parses = markdownRenderCache.stats().parses

    const { container } = render(<div className="app-shell"><MarkdownRenderer renderHtml>{content}</MarkdownRenderer></div>)
    expect(markdownRenderCache.stats().parses).toBe(parses)

    const link = container.querySelector('a')!
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    // HTML preview: source toggle and full-screen dialog keep their state.
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.static-html-preview button, button')]
    const sourceToggle = buttons().find((button) => button.hasAttribute('aria-expanded'))!
    expect(sourceToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(sourceToggle)
    expect(sourceToggle).toHaveAttribute('aria-expanded', 'true')
    expect(container).toHaveTextContent('<section><h1>Interactive</h1></section>')
    fireEvent.click(sourceToggle)
    expect(sourceToggle).toHaveAttribute('aria-expanded', 'false')

    const before = document.querySelectorAll('[role="dialog"]').length
    const fullScreen = buttons().find((button) => !button.hasAttribute('aria-expanded'))!
    fireEvent.click(fullScreen)
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(before + 1)

    // Mermaid still mounts its own lazy component per instance.
    await vi.waitFor(() => {
      expect(container.querySelector('.mermaid-diagram')).not.toBeNull()
    })
  })

  it('makes remounting a large message cheaper (micro-benchmark)', async () => {
    const block = (i: number) => [
      `## Section ${i}`,
      `Text with **bold**, \`code\`, [link](https://example.com/${i}) and $a_${i}^2 + b^2$.`,
      `$$\n\\sum_{k=1}^{${i + 2}} k = \\frac{n(n+1)}{2}\n$$`,
      '```ts\n' + `const value${i} = ${i}\nexport default value${i}\n` + '```',
      '| A | B |\n| - | - |\n| 1 | 2 |',
      `- item ${i}\n- item ${i + 1}`
    ].join('\n\n')
    let content = ''
    for (let i = 0; content.length < 40_000; i++) {
      content += (i ? '\n\n' : '') + block(i)
    }

    const measure = (): { html: string; ms: number } => {
      const start = performance.now()
      const view = render(<MarkdownRenderer>{content}</MarkdownRenderer>)
      const ms = performance.now() - start
      const html = view.container.innerHTML
      view.unmount()
      return { html, ms }
    }
    const cold = measure()
    await flushUnmountStores()
    const warm = measure()
    expect(warm.html).toBe(cold.html)

    // The pipeline alone, without jsdom DOM creation and React commit.
    const segments = segmentsOf(content)
    let start = performance.now()
    for (const segment of segments) parseMarkdown(segment, blockMarkdownPipeline)
    const parseMs = performance.now() - start
    start = performance.now()
    for (const segment of segments) hastToReact(lookupMarkdown(segment, blockMarkdownPipeline)!.tree, undefined)
    const hitMs = performance.now() - start
    console.info(
      `[markdown-render-cache] ${content.length} chars, ${segments.length} segments: ` +
        `mount cold ${cold.ms.toFixed(1)} ms, mount cache hit ${warm.ms.toFixed(1)} ms; ` +
        `pipeline parse ${parseMs.toFixed(1)} ms, cache hit + hast->React ${hitMs.toFixed(1)} ms`
    )
    expect(warm.ms).toBeLessThan(cold.ms)
  }, 30000)
})
