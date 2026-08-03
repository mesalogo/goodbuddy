import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const components: Components = {
  a: ({ children, node, ...properties }) => {
    void node
    return (
      <a {...properties} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    )
  },
  table: ({ children, node, ...properties }) => {
    void node
    return (
      <div
        aria-label="表格，可横向滚动"
        className="markdown-table-scroll"
        role="region"
        tabIndex={0}
      >
        <table {...properties}>{children}</table>
      </div>
    )
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
