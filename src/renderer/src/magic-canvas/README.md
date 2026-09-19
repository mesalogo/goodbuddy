# React Canvas Integration

The shared `MagicNoteCanvasContent` in `src/shared/magic-notes-contracts.ts` is
the persisted contract. `model.ts` adapts it to the retained PeopleLib paged
canvas core. The core stays in ES modules; the React boundary and model adapter
are TypeScript, with an explicit `canvas-note.d.mts` controller declaration.

## Public API

`MagicCanvasEditor.tsx` exports `MagicCanvasEditor` and its types:

```ts
type MagicCanvasEditorProps = {
  initialContent?: MagicNoteCanvasContent
  onChange(content: MagicNoteCanvasContent): void
  onReady?(content: MagicNoteCanvasContent): void
  onError(message: string): void
  disabled?: boolean
}

type MagicCanvasEditorHandle = {
  flush(): Promise<MagicNoteCanvasContent>
  focus(): void
  capturePages(): Promise<{ pageId: string; dataUrl: string }[]>
}
```

`initialContent` is read once. Use a note ID or edit-session key to remount when
opening another note or replacing the entire document. Ordinary parent renders,
callback changes, and `disabled` changes do not recreate the editor. Await
`flush()` before saving, switching notes, or starting analysis. It includes the
current Fabric objects, pending text, queued imports, and flow pagination.

Initialization keeps the core disabled until its first flush completes. `onReady`
reports that normalized document once per mounted instance, before edits are
enabled. Use it as the dirty comparison baseline for the loaded revision; later
`onChange` callbacks and flushes do not advance the baseline. Imperative flush
waits for initialization, and aborted instances cannot report readiness or changes.

`capturePages()` returns page-sized PNG data URLs containing the paper/PDF
background, flow text, and Fabric annotations. It waits for pending edits and
serializes capture with editor operations. The caller owns error handling for
imperative methods; toolbar failures use `onError`. Pass that callback to the
application notification mechanism.

Record navigation uses `MagicCanvasThumbnail` with a short-lived core renderer.
The core controller accepts `capturePages({ firstPageOnly: true, thumbnailWidth: 240 })`
to composite only page zero, including the background, body and annotations.
Visible thumbnails are queued and cached by content identity; they do not leave
full editors mounted in the record list. The React editor's AI capture method
continues to capture every page.

The same module exports `createEmptyCanvasContent()` and
`canvasHasContent(content?)`.

`MagicCanvasContent.tsx` exports the read-only viewer:

```ts
type MagicCanvasContentProps = {
  content: MagicNoteCanvasContent
  onError?: (message: string) => void
  onEdit?: () => void
}
```

The viewer supports previous/next page and the same zoom controls as the editor. When `onEdit` is supplied, it displays
an edit action for the workspace to open the editor. Passing a new content
reference refreshes the viewer. It does not own a modal or persistence.

## Editing And Assets

- Blank, ruled, grid and dot templates; add/delete pages; PDF pages retain size.
- Pen, highlighter, whole-object eraser, Fabric selection/move/scale/rotation,
  floating editable text, and JPEG/PNG/GIF/WebP images.
- Quill body text flows across pages. Adding a page in flow mode inserts a page
  break. Deleting a page removes its break and reflows body text. Deleting a
  nonempty annotation/PDF page requires a second click within five seconds.
- Undo/redo is per annotation page or Quill body mode, matching PeopleLib.
  Page insertion/deletion and PDF import are not document-wide undo steps.
- File inputs import images and PDFs. PDFs replace a pristine single blank page
  or are inserted after the current page. A busy import cannot be queued twice.
- Image objects persist `assetId`; PDF backgrounds persist `assetId` and
  one-based `pageNumber`. Asset data URLs are stored only in the document's
  `assets` array. No PeopleLib draft tokens, file paths, or resource IPC are used.
- Native PDF text is extracted into each PDF background's `text` field. Scanned
  PDF pages remain renderable without fabricated text or automatic OCR calls.
- PDF export downloads a Blob using jsPDF. Each output page is a raster
  composite, preserving visual annotations and flow text. The exported PDF does
  not retain the imported PDF's searchable text layer.
- Flow export writes actual numbered/bullet/checked/unchecked marker spans,
  including nested decimal/letter/Roman numbering and list indentation. It does
  not rely on Quill's editor-only pseudo-elements.

### Editor Limits

The current core limits are narrower than the shared schema. Shared acceptance
alone does not guarantee that a document fits the editor; the core applies the
following limits on input and serialization.

| Item | Core limit and behavior |
| --- | --- |
| Flow text | 20,000 UTF-16 code units (`string.length`), excluding exactly one terminal newline. Internal newlines count; page-break embeds do not. |
| Flow operations | 5,000 input Delta operations, including newline and page-break operations. |
| Pages | 50, including automatic flow pages and PDF pages. Initial page normalization currently keeps the first 50. Flow beyond 50 pages reports an error. |
| Images | 20 MiB (`20 * 1024 * 1024` bytes) per JPEG/PNG/GIF/WebP file, inclusive. The same derived Data URL length bound applies when restoring image objects. |
| PDF file input | 32 MiB per input file; imported pages also count toward the 50-page limit. |
| Page dimensions | Positive dimensions at most 3,000 per side, rounded to integers; invalid dimensions fall back to 794 by 1123 defaults per axis. |
| List indent | Integer levels 1 through 8, or omitted for level zero. |

Input validation and serialization use the same flow text/operation checks.
Canvas assets do not use the rich-text image or aggregate attachment budgets.
The shared canvas schema and Main validation accept this image size; persistence
stores decoded assets in files and hydrates them on read without a smaller byte cap.
Exactly 20,000 body code units plus Quill's terminal newline round-trip intact.
Oversized user edits revert to the preceding Delta and call `onError`.
Oversized initial/API content throws a `RangeError`; `flush()` rejects rather
than returning a document with missing flow text. Callers must not save a
replacement empty document after that rejection.

Vite imports Fabric, jsPDF and Quill as modules. PDF.js, its worker URL and
binary asset map load asynchronously only when a PDF is imported or displayed;
opening ordinary notes or template-only canvases does not initialize PDF.js.
Each PDF uses an explicit module Worker, avoiding PDF.js's blob
worker fallback under `file://`. `pdf-assets.mjs` maps PDF.js requests to bundled
CMaps, fonts and WASM rather than a remote service, and decodes inlined binary
assets without a CSP-blocked data URL fetch. `NOTICE.md` records source attribution;
packaging includes the dependency licenses.

`magic-canvas.css` scopes styles to these components and uses application theme
tokens. Paper keeps its real ink colors for consistent export. Narrow viewports
wrap the toolbar and scroll horizontally within the paper viewport. Editors and
saved viewers grow naturally to the current page's displayed height plus their
toolbars and padding; vertical scrolling belongs to the surrounding note stream.
Pagination replaces the current page within the same entry, including its height.

### View Zoom

Editor and viewer toolbars provide minus/plus (25 percentage points), a current
percentage button that resets to 100%, and Fit width. The range is 25%-300%, with
100% as the initial value. Ctrl/Command + wheel continuously zooms over the paper;
ordinary wheel and Shift horizontal scrolling retain their existing behavior.
Fit width follows the actual viewport's width minus its computed padding, within
the same range. Resizing the window or a workspace column updates it automatically.
Page navigation preserves the selected fixed scale or fit policy. Remounting a
document starts at 100%; the view preference is not persisted.

`canvas-note-page` is the displayed-size layout box. Its absolutely positioned
logical-size surface applies one CSS scale to the PDF/template, Fabric and Quill
layers. Fabric's existing client-to-canvas coordinate conversion handles pointer
input; Quill column and selection measurements divide screen coordinates by the
display scale. Page dimensions, object coordinates, flow widths and export
canvases remain logical. Zoom never enters the model, history or `onChange`.
The width observer defers updates to the next animation frame and is disconnected,
with any pending frame cancelled, on destroy. Flow pagination does not reset an
unchanged background bitmap's dimensions, which would clear the rendered PDF.

The UI contract is in [UI-DESIGN.md](../../../../UI-DESIGN.md#137-魔法笔记).

## Lifecycle And Validation

The controller is returned synchronously so React cleanup can immediately abort
an initializing editor. PDF module loading remains inside the queued document
load awaited by `flush()`; after loading modules, an aborted editor cannot start
a Worker. Cleanup cancels Fabric restoration, PDF loading/render
tasks and flow animation frames, disconnects the Quill mutation observer, and
waits for queued work before disposing the canvas. Aborted instances cannot
notify the parent.

Focused tests cover template/asset/model round trips, PDF native text and shared
schema acceptance, resource retention for undo, StrictMode cleanup, asynchronous
flush, and callback/disabled updates without remounting.

The isolated Electron probe additionally exercised real pen/highlighter input,
eraser, selection transforms, floating text, image insertion, undo/redo, page
creation, 100 paragraphs flowing into three pages, PNG capture, read-only
pagination, two-page native-text PDF import, one change callback per import,
PDF download, dark/narrow layout, and six rapid PDF editor remounts. No model
requests were made. The same scenario passed against the Vite production build
loaded through `file://` with the application's unmodified CSP. Workspace saving,
SQLite persistence and AI integration are documented in the
[feature technical design](../../../../docs/features/magic-notes/technical-design.md);
current validation status is in the
[feature progress record](../../../../docs/features/magic-notes/progress.md).

The review regression probe also passed in real Electron against a production
`file://` build: a 20,000-character Chinese body survived flush, excess user input
was reverted, and an oversized API edit rejected flush. Captured PNG and the
exported PDF re-rendered through PDF.js both contained all ten marker regions
(decimal/letter/Roman, bullet, checked/unchecked, nested bullet and restarted
numbering), with identical ink-pixel counts in the corresponding regions.
