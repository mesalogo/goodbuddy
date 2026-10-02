import type { Nodes, Root } from 'hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { urlAttributes } from 'html-url-attributes'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { VFile } from 'vfile'

/**
 * Markdown to hast pipeline with a module-level LRU cache.
 *
 * The expensive part of rendering Markdown (micromark, remark, rehype, KaTeX)
 * produces a hast tree that depends only on the source text and the pipeline
 * configuration. The cache stores that finished tree; every mount still runs
 * the cheap hast to React step with its own `components`, so per-instance
 * callbacks, state, locale-dependent labels and the HTML preview mode are
 * never captured by a cache entry.
 *
 * The output matches `react-markdown` 10 (`Markdown`): same processor, same
 * post-processing (raw HTML handling, URL sanitizing) and the same
 * `toJsxRuntime` options. Cached trees are immutable after `parse`;
 * `toJsxRuntime` only reads them.
 */

export type MarkdownPipeline = Readonly<{
  /**
   * Identifies every option that changes the hast output (plugins, plugin
   * options, raw HTML handling). Part of each cache key, so pipelines with
   * different output never share entries.
   */
  id: string
  run: (file: VFile) => Root
  skipHtml: boolean
}>

const blockProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: true })
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeKatex, {
    output: 'htmlAndMathml',
    strict: 'warn',
    trust: false
  })
  .freeze()

/** GFM + math (single dollar) + KaTeX, raw HTML skipped. */
export const blockMarkdownPipeline: MarkdownPipeline = {
  id: 'gfm|math(singleDollar)|katex(htmlAndMathml,warn,untrusted)|skipHtml',
  run: (file) => blockProcessor.runSync(blockProcessor.parse(file), file),
  skipHtml: true
}

/**
 * Same post-processing as react-markdown's `post` before `toJsxRuntime`.
 * Returns the number of visited nodes, used as the memory cost of a tree.
 */
function postProcess(tree: Root, pipeline: MarkdownPipeline): number {
  let nodes = 0
  visit(tree as Nodes, (node, index, parent) => {
    nodes++
    if (node.type === 'raw' && parent && typeof index === 'number') {
      if (pipeline.skipHtml) {
        parent.children.splice(index, 1)
      } else {
        parent.children[index] = { type: 'text', value: node.value }
      }
      return index
    }
    if (node.type === 'element') {
      for (const key in urlAttributes) {
        if (
          Object.hasOwn(urlAttributes, key) &&
          Object.hasOwn(node.properties, key)
        ) {
          const test = urlAttributes[key]
          if (test === null || test?.includes(node.tagName)) {
            node.properties[key] = defaultUrlTransform(
              String(node.properties[key] || '')
            )
          }
        }
      }
    }
    return undefined
  })
  return nodes
}

export type ParsedMarkdown = Readonly<{
  /** hast node count, the memory cost of the tree. */
  nodes: number
  tree: Root
}>

/** Uncached Markdown to hast with react-markdown semantics. */
export function parseMarkdown(
  source: string,
  pipeline: MarkdownPipeline
): ParsedMarkdown {
  const file = new VFile()
  file.value = source
  const tree = pipeline.run(file)
  const nodes = postProcess(tree, pipeline)
  stats.parses++
  return { nodes, tree }
}

/** Cheap per-mount step; same toJsxRuntime options as react-markdown. */
export function hastToReact(
  tree: Root,
  components: Components | undefined
): React.JSX.Element {
  return toJsxRuntime(tree, {
    Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true
  })
}

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

export type MarkdownCacheLimits = {
  /** Total source characters across all entries. */
  maxChars: number
  maxEntries: number
  /**
   * Total hast nodes across all entries. KaTeX output is far larger than its
   * source, so characters alone do not bound memory.
   */
  maxNodes: number
}

const defaultLimits: Readonly<MarkdownCacheLimits> = {
  maxChars: 2_000_000,
  maxEntries: 2_000,
  maxNodes: 600_000
}

let limits: MarkdownCacheLimits = { ...defaultLimits }
// Map iteration order is insertion order: the first key is least recently
// used.
const entries = new Map<string, ParsedMarkdown & { chars: number }>()
let totalChars = 0
let totalNodes = 0
const stats = { evictions: 0, hits: 0, misses: 0, parses: 0, stores: 0 }

function cacheKey(source: string, pipeline: MarkdownPipeline): string {
  return `${pipeline.id}\u0000${source}`
}

function overLimit(): boolean {
  return (
    entries.size > limits.maxEntries ||
    totalChars > limits.maxChars ||
    totalNodes > limits.maxNodes
  )
}

function evict(): void {
  while (entries.size > 0 && overLimit()) {
    const [oldest, entry] = entries.entries().next().value!
    entries.delete(oldest)
    totalChars -= entry.chars
    totalNodes -= entry.nodes
    stats.evictions++
  }
}

/** Returns a cached tree, marking it most recently used. */
export function lookupMarkdown(
  source: string,
  pipeline: MarkdownPipeline
): ParsedMarkdown | undefined {
  const key = cacheKey(source, pipeline)
  const entry = entries.get(key)
  if (!entry) {
    stats.misses++
    return undefined
  }
  entries.delete(key)
  entries.set(key, entry)
  stats.hits++
  return entry
}

/**
 * Stores the result of `parseMarkdown(source, pipeline)`. A source that
 * would take more than a quarter of any budget is skipped, so one huge
 * message cannot flush everything else.
 */
export function storeMarkdown(
  source: string,
  pipeline: MarkdownPipeline,
  parsed: ParsedMarkdown
): void {
  if (
    source.length > limits.maxChars / 4 ||
    parsed.nodes > limits.maxNodes / 4
  ) {
    return
  }
  const key = cacheKey(source, pipeline)
  const existing = entries.get(key)
  if (existing) {
    entries.delete(key)
    totalChars -= existing.chars
    totalNodes -= existing.nodes
  }
  entries.set(key, { chars: source.length, ...parsed })
  totalChars += source.length
  totalNodes += parsed.nodes
  stats.stores++
  evict()
}

/** Cache lookup falling back to a parse. Never stores. */
export function getMarkdown(
  source: string,
  pipeline: MarkdownPipeline
): ParsedMarkdown {
  return lookupMarkdown(source, pipeline) ?? parseMarkdown(source, pipeline)
}

/** Test and diagnostics hooks. */
export const markdownRenderCache = {
  clear(): void {
    entries.clear()
    totalChars = 0
    totalNodes = 0
    for (const key of Object.keys(stats) as (keyof typeof stats)[]) {
      stats[key] = 0
    }
  },
  configure(next: Partial<MarkdownCacheLimits>): void {
    limits = { ...limits, ...next }
    evict()
  },
  has(source: string, pipeline = blockMarkdownPipeline): boolean {
    return entries.has(cacheKey(source, pipeline))
  },
  keys(): string[] {
    return [...entries.keys()]
  },
  resetLimits(): void {
    limits = { ...defaultLimits }
    evict()
  },
  stats(): Readonly<
    typeof stats & { entries: number; totalChars: number; totalNodes: number }
  > {
    return { ...stats, entries: entries.size, totalChars, totalNodes }
  }
}
