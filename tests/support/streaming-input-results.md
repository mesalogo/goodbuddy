# Native input during streaming

Run with `npx vitest run tests/streaming-input.electron.test.ts`.
The final validated run took 53.37 seconds on Windows, Electron 43.2.0,
Chromium 150.0.7871.129. Repository typecheck and lint passed.

## Method

- Vite production build of the real `ChatTimeline` and `MarkdownRenderer`,
  production React, bundled fonts/styles, and a controlled React textarea.
  The message array remains stable across draft-only changes.
- Real `AgentEventBuffer`, bundled into Electron main. The first chunk is
  explicitly flushed immediately for every interval, including warmup.
- Identical 22,716-byte growing Markdown answer: prose, headings, lists,
  fenced TypeScript, tables, quotation, inline math, and display math.
- 625 equal-throughput chunks scheduled independently in main over 5 seconds
  (8 ms target spacing, approximately 4.54 KB/s).
- 67 native key sequences per run, independently scheduled in main every
  71 ms. Input events must be trusted, preserve every draft prefix, and end
  with the exact draft and focus intact. No provider/model calls.
- One full warmup at 32 ms. Measured order: `16, 50, 32, 80`, then
  `80, 32, 50, 16`. Two runs and 134 input samples per interval.
- Send-to-input uses the timestamp immediately before native key dispatch
  and the renderer input handler timestamp. Twelve idle clock probes precede
  each run; the minimum-RTT midpoint estimates process clock offset.
  Final measured clock uncertainty was at most 0.062 ms.
- Input-to-frame ends at execution of the next requestAnimationFrame callback,
  not its supplied frame timestamp. This is a pre-paint responsiveness proxy,
  not physical screen presentation latency.
- Counts include committed answer updates and Chromium long tasks (over 50 ms).
  Final committed Markdown and DOM text must exactly match the source and an
  independently rendered static reference, respectively.
- Renderer timers never drive arrivals or typing. Output includes main timer
  lateness, producer duration, first flush/commit, and final commit times.
  Assertions cover correctness, not machine-dependent performance thresholds.

## Final Results

All latency cells are **median / p95 / maximum**, in milliseconds. Pooled
percentiles are computed from samples, not averages of per-run percentiles.

| Interval | Send to input | Input to next frame | Send to next frame | Answer updates, runs 1 / 2 | Long tasks |
| --- | --- | --- | --- | --- | --- |
| 16 ms | 0.80 / 12.54 / 18.92 | 0.80 / 13.30 / 27.90 | 3.23 / 15.57 / 28.64 | 164 / 164 | 0 / 0 |
| 32 ms | 0.71 / 11.33 / 24.83 | 0.60 / 16.20 / 25.40 | 2.17 / 17.34 / 26.20 | 110 / 109 | 0 / 0 |
| 50 ms | 0.72 / 4.35 / 23.69 | 0.50 / 17.80 / 22.30 | 1.28 / 18.85 / 24.29 | 82 / 82 | 0 / 0 |
| 80 ms | 0.71 / 10.17 / 20.81 | 0.40 / 7.70 / 14.20 | 1.16 / 13.63 / 21.51 | 55 / 55 | 0 / 0 |

Per-run p95 values make the variability visible:

| Interval | Send to input, runs 1 / 2 | Input to frame, runs 1 / 2 | Send to frame, runs 1 / 2 |
| --- | --- | --- | --- |
| 16 ms | 6.51 / 13.44 | 13.30 / 6.80 | 14.81 / 16.68 |
| 32 ms | 11.32 / 11.33 | 16.60 / 11.40 | 17.82 / 16.04 |
| 50 ms | 1.11 / 4.35 | 17.80 / 15.40 | 18.51 / 20.18 |
| 80 ms | 10.44 / 4.93 | 10.60 / 7.40 | 13.63 / 12.90 |

All nine runs, including warmup, preserved exact final Markdown, rendered DOM
text, draft, each typed prefix, and textarea focus. Every emitted buffer flush
was received. Measured first flushes occurred within 0.08 ms of producer start;
first commits within 1.58 ms. Producer durations were 5,002.79-5,013.54 ms.

## Interpretation

**50 ms is the smallest candidate with a material send-to-input p95 improvement**
in this measurement: 65% below 16 ms, with half as many answer updates. It is
not an overall latency win: send-to-next-frame p95 is 21% higher than at 16 ms.

80 ms has the best pooled send-to-next-frame p95 (13.63 ms versus 15.57 ms at
16 ms), and the best input-to-frame tail. That approximately 1.94 ms end-to-end
p95 saving costs two thirds of the answer updates. Two short runs do not
establish a robust benefit sufficient to recommend raising the production
default to 80 ms. This benchmark does not justify claiming 32 ms materially
improves tail input latency, either. Preserve the production default unless
the chosen target is specifically send-to-input latency; for that target,
50 ms is the smallest measured candidate to investigate in the complete App.

## After segmented Markdown rendering

`MarkdownRenderer` now splits Markdown at safe top-level block boundaries and
memoizes each segment, so a streaming update re-parses only the growing tail.
Same benchmark, same machine, same order (`16, 50, 32, 80, 80, 32, 50, 16`),
two runs and 134 input samples per interval; exact text, draft, every typed
prefix and focus were preserved in all nine runs, with zero long tasks.

| Interval | Send to input p95, before / after | Send to next frame p95, before / after | Answer updates |
| --- | --- | --- | --- |
| 16 ms | 12.54 / 1.23 | 15.57 / 7.94 | 163 / 164 |
| 32 ms | 11.33 / 1.27 | 17.34 / 8.23 | 109 / 110 |
| 50 ms | 4.35 / 1.29 | 18.85 / 7.21 | 82 / 82 |
| 80 ms | 10.17 / 1.39 | 13.63 / 7.57 | 55 / 55 |

With segmentation the interval no longer materially changes input latency,
so the production 16 ms default is retained: streaming cadence is unchanged.

`tests/streaming-markdown.electron.test.ts` adds a streaming-delta case: 120
characters appended per update to an approximately 80 KB answer, on persistent
roots. Whole-document rendering took median 59.2 ms (p95 65.4 ms); segmented
rendering took median 2.4 ms (p95 4.2 ms), with DOM equality checked against
whole-document rendering throughout.

## Limits

This mounts production ChatTimeline, not App. It excludes App event reduction,
conversation history, the production composer, and App auto-scroll. The answer
pane stays at its initial scroll position. DOM work occurs for the entire
answer, but this does not measure continuously painting its moving bottom edge.
The static reference checks DOM text equivalence, not pixel equivalence.

Windows timers coalesced: chunk scheduling p95 lateness was approximately
12.7-13.5 ms, and native-input scheduling p95 lateness 12.4-14.1 ms. Therefore
configured 16 ms did not produce 62.5 updates/second: it produced approximately
32.8. Lateness is reported separately and excluded from send-to-input latency,
which starts at actual dispatch. The producer never waits for the renderer.

This is one machine without CPU throttling and one moderate-throughput workload.
There were no long tasks at any interval. A slower machine, larger history,
App auto-scroll, or faster generation may change the tradeoff substantially.
