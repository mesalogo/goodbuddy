# Magic Notes

Magic Notes is the local notes, checklist and AI-comment workbench. Desktop
actions and authorized Agent/MCP tools write to the same desktop SQLite store.
The open workbench subscribes to successful writes so users can see external
changes without leaving the page or clicking a refresh button.

The workbench opens on a responsive note-card overview. Opening a note replaces
the overview with its detail and optional AI comments. The separate To-dos tab
keeps search, status filters and grouped tasks on one page, with direct completion
and a stable left list/right detail layout for instructions, source content and AI
comments. Narrow containers use on-demand detail with an explicit return to the
mounted list. Content-sized tabs sit in the page header immediately before New
note; status filters sit beside search and wrap when needed. Returning from a source note restores the task
context and protects unsaved editor changes.

## Documents

- [Technical design](./technical-design.md): database notifications, process
  boundaries, refresh lifecycle and regression coverage.
- [Progress](./progress.md): implementation and validation evidence.
- [UI design system](../../../UI-DESIGN.md#137-魔法笔记): authoritative workbench
  interaction rules, including selection and draft preservation.

An entry is a saved rich-text record within a note. A todo is a checklist item
derived from an entry. An unsaved draft belongs to the open editor; it is not
written to storage by a background refresh.
