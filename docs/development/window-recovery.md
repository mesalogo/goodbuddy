# Desktop Window Recovery

This is recovery hardening for intermittent blank windows, not an established
diagnosis of their cause.

- `src/renderer/src/main.tsx` wraps the locale provider, App and storage-upgrade
  page in `AppErrorBoundary`. A React render/lifecycle failure replaces the tree
  with a blocking recovery page and an explicit Reload button. It uses the saved
  UI language (including system preference resolution), shared theme tokens and
  primary-button styling, without depending on the failed application providers.
- Reload refreshes the current document, retaining its URL and storage-upgrade
  query. It can lose unsaved input. There are no automatic React retries.
- `src/main/window.ts` listens for `render-process-gone`. Abnormal exits open one
  native dialog at a time, using the OS locale because renderer language storage
  is unavailable to Main. Reload occurs only on explicit confirmation. Cancel
  leaves the window unchanged; persistent failures require quitting and reopening
  GoodBuddy. Clean exits, shutdown and destroyed windows do not trigger recovery.
- Main-frame load failures are logged; aborted navigation and subframe failures
  are ignored. Initial load promises are caught, without automatic load retries
  or a new load-failure UI.
- Native crashes and main-frame load failures use the existing bounded desktop
  diagnostics store (`desktop.renderer.gone`, `desktop.renderer.load-failed`,
  stage `renderer`). Persistent records retain fixed summaries rather than raw
  errors. Crash reason/exit code and React errors/component stacks go to their
  respective process consoles. There is no new diagnostic IPC.

The boundary does not catch module evaluation/startup failures before React
mounts, event-handler exceptions, asynchronous rejections, a hung renderer, or
main-process failure. Reload does not establish that a repeated underlying error
has been fixed. Agent runtimes and remote execution are unchanged.

Targeted regressions are in `AppErrorBoundary.test.tsx`, `window.test.ts` and
`desktop-diagnostics.test.ts`. Electron API mocks verify decision paths but do
not establish native dialog appearance or full application recovery.

Validation on Windows, 2026-09-15:

- Targeted Vitest run: 20 tests passed across the three files above.
- `npm test`: 359 files passed, 9 skipped; 4,225 tests passed, 67 skipped.
- `npm run typecheck`, `npm run lint` and `git diff --check` passed.
- An isolated Electron fixture bundled the current boundary, shared styles and
  production window module. Both languages and themes at requested content sizes
  1280x800, 960x720, 720x640 and 640x420 passed visibility, focus and horizontal
  overflow checks. Windows scaling rounded actual widths down by one CSS pixel.
  The 16-image overview and Chinese/light and English/dark short-window originals
  were visually reviewed; no clipping or focus-style defect was found.
- A native Space key activated the recovery button and reloaded the document.
  Two actual renderer crashes verified confirmed reload with URL retention and
  cancellation without retry. Only native dialog responses were mocked; native
  dialog appearance, full App business-state recovery and other OSes were not
  verified. No model calls were made by this fixture.
- The first temporary Electron driver timed out during ESM startup. Removing its
  top-level readiness await fixed the driver; the subsequent run passed. This
  was a test-driver failure, not evidence of the reported application root cause.
