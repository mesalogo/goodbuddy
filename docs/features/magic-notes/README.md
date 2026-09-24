# Magic Notes

Magic Notes is the local notes, checklist and AI-comment workbench. Desktop
actions and authorized Agent/MCP tools use the same desktop store: SQLite for
metadata and indexes, and local files for entry bodies and binary assets.
The open workbench subscribes to successful writes so users can see external
changes without leaving the page or clicking a refresh button.

The workbench opens on a responsive note-card overview. Opening a note replaces
the overview with a continuous record stream, a narrow left index and independent
right AI comments. Both side panes can collapse. Index items show one real
first-page canvas thumbnail with page count, or a text summary; clicking scrolls
without replacing the editor or losing a draft. Opening a note shows a blank composer
above the history, with text/canvas selection and Save. Creating a record resets
that composer; editing a saved record requires its explicit Edit action. The separate To-dos view
keeps search, status filters and grouped tasks on one page, with direct completion
and a stable left list/right detail layout for instructions, source content and AI
comments. The divider can be dragged and remembers its width; each note group
can independently collapse its tasks while retaining its title and count.
Narrow containers use on-demand detail with an explicit return to the
mounted list. One content-sized button switches to the other view in the page
header immediately before New note; status filters sit beside search and wrap
when needed. Note detail removes the surrounding frame and stream padding while
keeping editor borders and the AI divider. Returning from a source note restores the task
context and protects unsaved editor changes. A successful save followed by no
further edits does not prompt again on return. Narrow note layouts use an index
drawer and bounded bottom AI pane.

## Documents

- [Technical design](./technical-design.md): file storage, schema 38 migration,
  backup boundaries, database notifications, process boundaries, canvas and AI
  contracts, refresh lifecycle and regression coverage.
- [Progress](./progress.md): implementation and validation evidence.
- [UI design system](../../../UI-DESIGN.md#137-魔法笔记): authoritative workbench
  interaction rules, including selection and draft preservation.
- [Canvas integration](../../../src/renderer/src/magic-canvas/README.md): React
  controller API, PeopleLib core limits, asset adaptation and rendering lifecycle.

An entry is a saved rich-text or paged-canvas record within a note. Its body lives
in `notes/<noteId>/entries/<entryId>.json` beside note-local binary assets;
`note.json` is a derived membership manifest. SQLite retains metadata, indexes,
revisions, todos and comments. API reads hydrate assets back into the existing
content format. A todo is a checklist item derived from rich text
or the canvas Quill flow. An unsaved draft belongs to the open editor; it is not
written to storage by a background refresh.

Backups must coordinate SQLite and the adjacent `notes/` tree while note writes
are paused or the app is closed. A database-only backup cannot restore these
bodies. There is no product one-click backup action; see the
[backup contract](./technical-design.md#backup-and-restore).

## Canvas Scope

The integrated PeopleLib editor uses Fabric for paged annotations and Quill for
body text flowing across pages. It supports paper templates, pen/highlighter,
object erasing and selection/transforms, floating text, images, PDF backgrounds
with native text extraction, and raster PDF export. Saves are manual. Undo/redo
belongs to the current annotation page or Quill body mode; it is not a global
document history. There is no infinite canvas or PNG download button.
Editors and saved viewers support view zoom and responsive Fit width without
changing saved content or export dimensions; see the
[canvas zoom reference](../../../src/renderer/src/magic-canvas/README.md#view-zoom).

Drafts, saved entries and todos sourced from canvases support AI comments using
the default model's image-input capability. The Canvas pages to send setting
selects the first 1-8 pages in current canvas order, defaulting to 1. It counts
pages in one canvas, not entries, and leaves full-canvas saving and export intact.
Image-capable models receive complete captures and extracted text for that prefix.
Text-only models receive the same page range as an explicitly labelled
text fallback; a purely visual canvas entry or draft reports that an image-capable
default model is required. Canvas comments are requested manually in `immediate`
mode, or after a manual save in `after-save-auto` mode. Analysis failure does not
undo a successful save. Detailed retention rules are in the
[AI contract](./technical-design.md#canvas-analysis-and-comments).

Canvas implementation is complete and final validation is in progress. The
[progress record](./progress.md) distinguishes confirmed production-path evidence
from the pending final repository checks.
