import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { useTranslation } from 'react-i18next'

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

function markdownComponents(tableAriaLabel: string): Components {
  return {
    a: linkComponent,
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
}

const wholeMarkdownFence =
  /^```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n```$/iu

function unwrapMarkdownFence(content: string): string {
  const fencedMarkdown = wholeMarkdownFence.exec(content.trim())
  return fencedMarkdown?.[1] ?? content
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  children
}: MarkdownRendererProps): React.JSX.Element {
  const { t } = useTranslation('app')
  const components = useMemo(
    () => markdownComponents(t('markdown.scrollableTable')),
    [t]
  )

  return (
    <ReactMarkdown
      components={components}
      remarkPlugins={[remarkGfm]}
      skipHtml
    >
      {unwrapMarkdownFence(children)}
    </ReactMarkdown>
  )
})
