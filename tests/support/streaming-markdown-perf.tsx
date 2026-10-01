import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as current from '../../src/renderer/src/MarkdownRenderer'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import { equivalenceCorpus, longAnswerCorpus, originalNormalize, performanceCorpus } from './streaming-markdown-corpus'
import '../../src/renderer/src/fonts'
import '../../src/renderer/src/styles.css'

type Instrumented = typeof current & { benchmarkNormalize: (content: string) => string }
const normalize = (current as Instrumented).benchmarkNormalize
const host = document.getElementById('root')!
host.className = 'markdown-content'
host.style.cssText = 'width: 800px; padding: 16px'
const root = createRoot(host)
function snapshot(container = host): string {
  const clone = container.cloneNode(true) as HTMLElement
  const ids = new Map<string, string>()
  // Separate component instances receive different React useId values.
  // Canonicalize only those IDs/references; retain all content and iframe srcdoc.
  for (const element of clone.querySelectorAll('*')) {
    for (const name of ['id', 'aria-controls', 'aria-labelledby', 'aria-describedby']) {
      const value = element.getAttribute(name)
      if (value && /^_r_[a-z0-9]+_$/u.test(value)) {
        if (!ids.has(value)) ids.set(value, `react-id-${ids.size}`)
        element.setAttribute(name, ids.get(value)!)
      }
    }
  }
  return clone.innerHTML
}
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
}

async function run() {
  const originalPath = '/src/renderer/src/MarkdownRenderer.tsx?streaming-original'
  const original = await import(/* @vite-ignore */ originalPath) as Instrumented
  const render = (Component: typeof current.MarkdownRenderer, content: string, renderHtml = false) => {
    flushSync(() => root.render(<UiLocaleProvider initialPreference="en-US">
      <Component renderHtml={renderHtml}>{content}</Component>
    </UiLocaleProvider>))
  }
  // Warm fonts, styles, React, Markdown, and KaTeX before recording samples.
  render(current.MarkdownRenderer, performanceCorpus[1]!.content)
  await document.fonts.ready
  const results = []
  for (const corpus of performanceCorpus) {
    const prefixes = Array.from({ length: 24 }, (_, i) => corpus.content.slice(0, Math.ceil(corpus.content.length * (i + 1) / 24)))
    const renderTimes: number[] = []
    const normalizeTimes: number[] = []
    let checksum = 0
    for (let round = 0; round < 4; round++) {
      render(current.MarkdownRenderer, '')
      for (const prefix of prefixes) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const start = performance.now()
        render(current.MarkdownRenderer, prefix)
        // Include the synchronous DOM commit and Chromium style/layout, not frame waiting.
        void host.offsetHeight
        if (round > 0) renderTimes.push(performance.now() - start)
      }
    }
    // Batch sub-millisecond calls to exceed Chromium timer resolution.
    for (let round = 0; round < 4; round++) {
      for (const prefix of prefixes) {
        const start = performance.now()
        for (let i = 0; i < 100; i++) checksum += normalize(prefix).length
        if (round > 0) normalizeTimes.push((performance.now() - start) / 100)
      }
    }
    results.push({ corpus: corpus.name, characters: corpus.content.length, samples: renderTimes.length,
      renderMs: stats(renderTimes), normalizeMs: stats(normalizeTimes), checksum })
  }
  const originalHost = document.createElement('div')
  originalHost.className = host.className
  originalHost.style.cssText = host.style.cssText
  document.body.append(originalHost)
  const originalRoot = createRoot(originalHost)
  const longSamples = { original: [] as number[], current: [] as number[] }
  const prefixLengths = Array.from({ length: 6 }, (_, i) => Math.ceil(longAnswerCorpus.length * (i + 1) / 6))
  let longDomChecks = 0
  try {
    // One warm-up sweep, three measured sweeps: 48 renders total, on persistent roots.
    for (let round = 0; round < 4; round++) {
      render(current.MarkdownRenderer, '')
      flushSync(() => originalRoot.render(<UiLocaleProvider initialPreference="en-US">
        <original.UnsegmentedMarkdownRenderer>{''}</original.UnsegmentedMarkdownRenderer>
      </UiLocaleProvider>))
      for (const [index, length] of prefixLengths.entries()) {
        const prefix = longAnswerCorpus.slice(0, length)
        if (normalize(prefix) !== originalNormalize(prefix)) throw new Error(`Long normalizer mismatch: ${length}`)
        const order = (round + index) % 2 === 0
          ? ['original', 'current'] as const : ['current', 'original'] as const
        for (const variant of order) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          const start = performance.now()
          if (variant === 'original') {
            flushSync(() => originalRoot.render(<UiLocaleProvider initialPreference="en-US">
              <original.UnsegmentedMarkdownRenderer>{prefix}</original.UnsegmentedMarkdownRenderer>
            </UiLocaleProvider>))
            void originalHost.offsetHeight
          } else {
            render(current.MarkdownRenderer, prefix)
            void host.offsetHeight
          }
          if (round > 0) longSamples[variant].push(performance.now() - start)
        }
        // Compare outside timing, including the complete 100 KiB answer on every sweep.
        if (snapshot() !== snapshot(originalHost)) throw new Error(`Long DOM mismatch: ${length}`)
        longDomChecks++
      }
    }
    if (!host.querySelector('h2') || !host.querySelector('pre code') || !host.querySelector('table')) {
      throw new Error('Long-answer prose/code/table formatting missing')
    }
  } finally {
    flushSync(() => originalRoot.unmount())
    originalHost.remove()
  }
  // Streaming shape: small deltas appended to an already long answer, on
  // persistent roots, as ChatTimeline receives them. Alternate variant order.
  const deltaSamples = { original: [] as number[], current: [] as number[] }
  const deltaHost = document.createElement('div')
  deltaHost.className = host.className
  deltaHost.style.cssText = host.style.cssText
  document.body.append(deltaHost)
  const deltaRoot = createRoot(deltaHost)
  const deltaStart = Math.floor(longAnswerCorpus.length * 0.8)
  const deltaSize = 120
  try {
    const renderDelta = (variant: 'original' | 'current', prefix: string) => {
      if (variant === 'original') {
        flushSync(() => deltaRoot.render(<UiLocaleProvider initialPreference="en-US">
          <original.UnsegmentedMarkdownRenderer>{prefix}</original.UnsegmentedMarkdownRenderer>
        </UiLocaleProvider>))
        void deltaHost.offsetHeight
      } else {
        render(current.MarkdownRenderer, prefix)
        void host.offsetHeight
      }
    }
    renderDelta('original', longAnswerCorpus.slice(0, deltaStart))
    renderDelta('current', longAnswerCorpus.slice(0, deltaStart))
    for (let step = 1; step <= 60; step++) {
      const prefix = longAnswerCorpus.slice(0, deltaStart + step * deltaSize)
      const order = step % 2 === 0 ? ['original', 'current'] as const : ['current', 'original'] as const
      for (const variant of order) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const start = performance.now()
        renderDelta(variant, prefix)
        if (step > 5) deltaSamples[variant].push(performance.now() - start)
      }
      if (step % 10 === 0 && snapshot() !== snapshot(deltaHost)) throw new Error(`Delta DOM mismatch: ${step}`)
    }
  } finally {
    flushSync(() => deltaRoot.unmount())
    deltaHost.remove()
  }
  const streamingDelta = { startCharacters: deltaStart, deltaCharacters: deltaSize,
    samplesPerVariant: deltaSamples.current.length,
    wholeDocumentMs: stats(deltaSamples.original), segmentedMs: stats(deltaSamples.current) }
  const longAnswer = { characters: longAnswerCorpus.length, bytes: new TextEncoder().encode(longAnswerCorpus).length,
    prefixLengths, warmupSweeps: 1, measuredSweeps: 3, samplesPerVariant: longSamples.current.length,
    originalRenderMs: stats(longSamples.original), currentRenderMs: stats(longSamples.current),
    rawRenderMs: longSamples, domChecks: longDomChecks, finalDomEquivalent: true }
  let prefixesChecked = 0
  let domChecks = 0
  for (const content of equivalenceCorpus) {
    for (let end = 0; end <= content.length; end++) {
      const prefix = content.slice(0, end)
      if (normalize(prefix) !== originalNormalize(prefix)) throw new Error(`Normalizer mismatch: ${JSON.stringify(prefix)}`)
      prefixesChecked++
      for (const renderHtml of [false, true]) {
        render(original.UnsegmentedMarkdownRenderer, prefix, renderHtml)
        const expected = snapshot()
        render(current.MarkdownRenderer, prefix, renderHtml)
        if (snapshot() !== expected) throw new Error(`DOM mismatch (${renderHtml}): ${JSON.stringify(prefix)}`)
        domChecks++
      }
    }
  }
  render(current.MarkdownRenderer, '# Live\n\n**formatted** and \\(x\\)')
  if (!host.querySelector('h1') || !host.querySelector('strong') || !host.querySelector('.katex')) {
    throw new Error('Real Markdown formatting missing')
  }
  return { results, longAnswer, streamingDelta, prefixesChecked, domChecks }
}

Object.assign(window, { streamingMarkdown: run })
