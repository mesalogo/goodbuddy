import {
  Children,
  isValidElement,
  lazy,
  memo,
  Suspense,
  useMemo
} from 'react'
import rehypeKatex from 'rehype-katex'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Components } from 'react-markdown'
import { useTranslation } from 'react-i18next'
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

function normalizeLatexDelimiters(content: string): string {
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

export const MarkdownRenderer = memo(function MarkdownRenderer({
  children,
  renderHtml = false
}: MarkdownRendererProps): React.JSX.Element {
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

  return (
    <ReactMarkdown
      components={components}
      rehypePlugins={[
        [
          rehypeKatex,
          {
            output: 'htmlAndMathml',
            strict: 'warn',
            trust: false
          }
        ]
      ]}
      remarkPlugins={[
        remarkGfm,
        [remarkMath, { singleDollarTextMath: true }]
      ]}
      skipHtml
    >
      {normalizedContent}
    </ReactMarkdown>
  )
})
