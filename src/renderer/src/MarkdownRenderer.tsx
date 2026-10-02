import {
  Children,
  Fragment,
  isValidElement,
  lazy,
  memo,
  Suspense,
  useEffect,
  useMemo,
  useRef
} from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { useTranslation } from 'react-i18next'
import {
  blockMarkdownPipeline,
  getMarkdown,
  hastToReact,
  storeMarkdown
} from './markdown-render-cache'
import { StaticHtmlPreview } from './StaticHtmlPreview'

const MermaidDiagram = lazy(() =>
  import('./MermaidDiagram').then((module) => ({
    default: module.MermaidDiagram
  }))
)

const linkComponent: Components['a'] = ({
  children,
  node,
  ...properties
}) => {
  void node
  return (
    <a {...properties} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  )
}

function markdownComponents(
  tableAriaLabel: string,
  mermaidLoadingLabel: string,
  renderHtml: boolean
): Components {
  return {
    a: linkComponent,
    pre: ({ children, node, ...properties }) => {
      void node
      const child = Children.count(children) === 1
        ? Children.only(children)
        : undefined
      if (
        isValidElement<{
          children?: React.ReactNode
          className?: string
        }>(child) &&
        /(?:^|\s)language-mermaid(?:\s|$)/iu.test(
          child.props.className ?? ''
        )
      ) {
        const source = String(child.props.children ?? '').replace(
          /\n$/u,
          ''
        )
        return (
          <Suspense
            fallback={
              <figure aria-busy="true" className="mermaid-diagram">
                <figcaption role="status">
                  {mermaidLoadingLabel}
                </figcaption>
              </figure>
            }
          >
            <MermaidDiagram source={source} />
          </Suspense>
        )
      }
      if (
        renderHtml &&
        isValidElement<{
          children?: React.ReactNode
          className?: string
        }>(child) &&
        /(?:^|\s)language-html?(?:\s|$)/iu.test(
          child.props.className ?? ''
        )
      ) {
        const source = String(child.props.children ?? '').replace(
          /\n$/u,
          ''
        )
        return <StaticHtmlPreview source={source} />
      }
      return <pre {...properties}>{children}</pre>
    },
    table: ({ children, node, ...properties }) => {
      void node
      return (
        <div
          aria-label={tableAriaLabel}
          className="markdown-table-scroll"
          role="region"
          tabIndex={0}
        >
          <table {...properties}>{children}</table>
        </div>
      )
    }
  }
}

type MarkdownRendererProps = {
  children: string
  renderHtml?: boolean
}

const inlineMarkdownComponents: Components = {
  p: ({ children }) => <>{children}</>
}

export const InlineMarkdown = memo(function InlineMarkdown({
  children
}: MarkdownRendererProps): React.JSX.Element {
  return (
    <ReactMarkdown
      allowedElements={['p', 'strong']}
      components={inlineMarkdownComponents}
      skipHtml
      unwrapDisallowed
    >
      {children}
    </ReactMarkdown>
  )
})

const wholeMarkdownFence =
  /^```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n```$/iu

function replaceLatexDelimiters(line: string): string {
  if (!line.includes('\\(') && !line.includes('\\)')) {
    return line
  }
  let output = ''
  let index = 0
  let codeDelimiterLength = 0

  while (index < line.length) {
    if (line[index] === '`') {
      let runLength = 1
      while (line[index + runLength] === '`') {
        runLength += 1
      }
      if (
        codeDelimiterLength === 0 ||
        codeDelimiterLength === runLength
      ) {
        codeDelimiterLength =
          codeDelimiterLength === 0 ? runLength : 0
      }
      output += line.slice(index, index + runLength)
      index += runLength
      continue
    }
    if (
      codeDelimiterLength === 0 &&
      line[index] === '\\' &&
      line[index - 1] !== '\\' &&
      (line[index + 1] === '(' || line[index + 1] === ')')
    ) {
      output += '$'
      index += 2
      continue
    }
    output += line[index]
    index += 1
  }
  return output
}

export function normalizeLatexDelimiters(content: string): string {
  // Without math markers or CRLF, every line would be returned unchanged.
  if (!/[$\\\r]/u.test(content)) {
    return content
  }
  let fence:
    | {
        character: '`' | '~'
        length: number
      }
    | undefined

  return content
    .split(/\r?\n/u)
    .map((line) => {
      if (fence) {
        const closingFence = new RegExp(
          `^ {0,3}${fence.character}{${fence.length},}\\s*$`,
          'u'
        )
        if (closingFence.test(line)) {
          fence = undefined
        }
        return line
      }
      const openingFence = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
      if (openingFence) {
        const marker = openingFence[1]!
        fence = {
          character: marker[0] as '`' | '~',
          length: marker.length
        }
        return line
      }
      const standaloneDollar =
        /^ {0,3}\$(?!\$)(.+?)(?<!\\)\$\s*$/u.exec(line)
      if (standaloneDollar) {
        return `$$\n${standaloneDollar[1]}\n$$`
      }
      const standaloneParentheses =
        /^ {0,3}\\\(\s*(.*?)\s*\\\)\s*$/u.exec(line)
      if (standaloneParentheses) {
        return `$$\n${standaloneParentheses[1]}\n$$`
      }
      const singleLineDisplay =
        /^ {0,3}\\\[\s*(.*?)\s*\\\]\s*$/u.exec(line)
      if (singleLineDisplay) {
        return `$$\n${singleLineDisplay[1]}\n$$`
      }
      if (/^ {0,3}\\\[\s*$/u.test(line)) {
        return '$$'
      }
      if (/^ {0,3}\\\]\s*$/u.test(line)) {
        return '$$'
      }
      return replaceLatexDelimiters(line)
    })
    .join('\n')
}

function unwrapMarkdownFence(content: string): string {
  const fencedMarkdown = wholeMarkdownFence.exec(content.trim())
  return fencedMarkdown?.[1] ?? content
}

function standaloneHtmlSource(content: string): string | undefined {
  const trimmed = content.trim()
  if (
    /^(?:<!doctype\s+html(?:\s[^>]*)?>\s*)?<html(?:\s|>)/iu.test(
      trimmed
    ) ||
    /^<[a-z][a-z0-9:-]*(?:\s[^<>]*?)?>[\s\S]*<\/[a-z][a-z0-9:-]*>\s*$/iu.test(
      trimmed
    )
  ) {
    return trimmed
  }
  return undefined
}

// Link reference and footnote definitions resolve across the whole document,
// even from inside lists or block quotes, so their presence disables splitting.
// Lines inside an unindented code fence are literal and are not checked.
const documentScopedMarkdown = /\]:|\[\^/u
// Raw HTML blocks may legally span blank lines in ways a line scanner cannot
// track.
const unsafeSegmentLine = /^ {0,3}</u
// CommonMark: a backtick fence's info string cannot contain backticks.
const segmentFenceOpening = /^ {0,3}(?:(`{3,})(?!.*`)|(~{3,}))/u
// micromark-extension-math: a run of two or more `$` opens a math block only
// when the rest of the line (the optional meta) has no `$`. Otherwise, as in
// `$$x^2$$`, the line is an ordinary paragraph containing inline math.
const segmentMathFenceOpening = /^ {0,3}(\${2,})(.*)$/u
// A block after a blank line belongs to the previous top-level block when it
// is indented (list item or indented code continuation), a list marker (the
// list may continue and its looseness may change), or a block quote marker.
const continuationLine = /^(?:\s|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|>)/u

/**
 * Splits Markdown at top-level boundaries where parsing each segment
 * independently produces exactly the same blocks as parsing the whole text:
 * a blank line, outside fenced code and math, followed by a line that starts
 * a new top-level block. Returns a single segment whenever any construct
 * could make that unsafe.
 */
export function splitMarkdownSegments(content: string): string[] {
  if (content.includes('\r')) {
    return [content]
  }
  const segments: string[] = []
  let fence: { closing: RegExp; literal: boolean } | undefined
  let math: { closing: RegExp } | undefined
  let segmentStart = 0
  let segmentHasBlock = false
  let previousBlank = false
  let lineStart = 0

  while (lineStart <= content.length) {
    const newline = content.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? content.length : newline
    const line = content.slice(lineStart, lineEnd)

    // An unindented fence line always opens a top-level code block, so its
    // content is literal until the matching close. Indented fences may sit in
    // a container that ends earlier, so their lines are still checked.
    if (!fence?.literal && documentScopedMarkdown.test(line)) {
      return [content]
    }

    if (fence) {
      if (fence.closing.test(line)) {
        fence = undefined
      }
      previousBlank = false
    } else if (math) {
      if (math.closing.test(line)) {
        math = undefined
      }
      previousBlank = false
    } else if (line.trim() === '') {
      previousBlank = true
    } else {
      if (unsafeSegmentLine.test(line)) {
        return [content]
      }
      // Leading blank lines render nothing; a segment of them would add an
      // extra separator, so split only after the segment has a block.
      if (
        previousBlank &&
        segmentHasBlock &&
        !continuationLine.test(line)
      ) {
        segments.push(content.slice(segmentStart, lineStart))
        segmentStart = lineStart
      }
      segmentHasBlock = true
      const opening = segmentFenceOpening.exec(line)
      const mathOpening = segmentMathFenceOpening.exec(line)
      if (opening) {
        const marker = (opening[1] ?? opening[2])!
        fence = {
          closing: new RegExp(
            `^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`,
            'u'
          ),
          literal: line.startsWith(marker)
        }
      } else if (/^ {0,3}`{3,}/u.test(line)) {
        // Backtick run with a backtick in its info string: inline code that
        // the line scanner cannot model, so keep the document whole.
        return [content]
      } else if (mathOpening && !mathOpening[2]!.includes('$')) {
        math = {
          closing: new RegExp(
            `^ {0,3}\\\${${mathOpening[1]!.length},}[ \\t]*$`,
            'u'
          )
        }
      }
      previousBlank = false
    }

    if (newline === -1) {
      break
    }
    lineStart = newline + 1
  }

  segments.push(content.slice(segmentStart))
  return segments
}

/**
 * Renders one segment from a hast tree shared through the module-level cache
 * (markdown-render-cache.ts). Only the hast to React step runs per mount, with
 * this instance's `components`, so callbacks and state are never shared.
 *
 * Cache-write rule (the renderer does not know whether a message is still
 * streaming):
 * - A segment followed by another segment (`complete`) is stored: the split
 *   rules guarantee its text and blocks no longer depend on what comes next.
 * - The final segment, which may still be growing, is stored only when it
 *   unmounts (the windowed timeline scrolls it away, or the view closes).
 *   That is exactly the text a remount asks for, and a stream adds at most
 *   one prefix per unmount instead of one entry per token.
 * Reads always consult the cache; keys are the exact segment text, so any
 * entry is correct for its key regardless of when it was stored.
 */
const MarkdownSegment = memo(function MarkdownSegment({
  complete,
  components,
  content
}: {
  complete: boolean
  components: Components
  content: string
}): React.JSX.Element {
  const parsed = useMemo(
    () => getMarkdown(content, blockMarkdownPipeline),
    [content]
  )
  const latest = useRef({ content, parsed })
  const mounted = useRef(false)

  useEffect(() => {
    latest.current = { content, parsed }
    if (complete) {
      storeMarkdown(content, blockMarkdownPipeline, parsed)
    }
  }, [complete, content, parsed])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // StrictMode re-runs effects right after this cleanup; storing only
      // when the segment stays unmounted keeps that from caching a prefix.
      queueMicrotask(() => {
        if (!mounted.current) {
          const last = latest.current
          storeMarkdown(last.content, blockMarkdownPipeline, last.parsed)
        }
      })
    }
  }, [])

  return useMemo(
    () => hastToReact(parsed.tree, components),
    [components, parsed]
  )
})

export const MarkdownRenderer = memo(function MarkdownRenderer(
  props: MarkdownRendererProps
): React.JSX.Element {
  return <MarkdownDocument {...props} segmented />
})

// Must stay in sync with blockMarkdownPipeline in markdown-render-cache.ts.
const referenceRehypePlugins: NonNullable<
  React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']
> = [
  [rehypeKatex, { output: 'htmlAndMathml', strict: 'warn', trust: false }]
]
const referenceRemarkPlugins: NonNullable<
  React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']
> = [remarkGfm, [remarkMath, { singleDollarTextMath: true }]]

/**
 * Whole-document reference rendering through plain react-markdown, without
 * the cache; used to verify segmentation and caching.
 */
export const UnsegmentedMarkdownRenderer = memo(
  function UnsegmentedMarkdownRenderer(
    props: MarkdownRendererProps
  ): React.JSX.Element {
    return <MarkdownDocument {...props} segmented={false} />
  }
)

function MarkdownDocument({
  children,
  renderHtml = false,
  segmented
}: MarkdownRendererProps & { segmented: boolean }): React.JSX.Element {
  const { t } = useTranslation('app')
  const normalizedContent = normalizeLatexDelimiters(
    unwrapMarkdownFence(children)
  )
  const components = useMemo(
    () =>
      markdownComponents(
        t('markdown.scrollableTable'),
        t('markdown.mermaidLoading'),
        renderHtml
      ),
    [renderHtml, t]
  )
  const standaloneHtml = standaloneHtmlSource(normalizedContent)

  if (standaloneHtml) {
    return renderHtml ? (
      <StaticHtmlPreview source={standaloneHtml} />
    ) : (
      <pre>
        <code className="language-html">{standaloneHtml}</code>
      </pre>
    )
  }

  // Completed segments keep identical strings, so streaming updates re-parse
  // only the growing tail. The "\n" matches the text node ReactMarkdown
  // places between top-level blocks, keeping the DOM identical.
  if (!segmented) {
    // Plain react-markdown, bypassing the cache: the reference also checks
    // that the cached pipeline matches react-markdown.
    return (
      <ReactMarkdown
        components={components}
        rehypePlugins={referenceRehypePlugins}
        remarkPlugins={referenceRemarkPlugins}
        skipHtml
      >
        {normalizedContent}
      </ReactMarkdown>
    )
  }
  const segments = splitMarkdownSegments(normalizedContent)
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 && '\n'}
          <MarkdownSegment
            complete={index < segments.length - 1}
            components={components}
            content={segment}
          />
        </Fragment>
      ))}
    </>
  )
}
