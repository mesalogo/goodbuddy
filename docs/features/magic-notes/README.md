# Magic Notes

Magic Notes is the local notes, checklist and AI-comment workbench. Desktop
actions and authorized Agent/MCP tools write to the same desktop SQLite store.
The open workbench subscribes to successful writes so users can see external
changes without leaving the page or clicking a refresh button.

## Documents

- [Technical design](./technical-design.md): database notifications, process
  boundaries, refresh lifecycle and regression coverage.
- [Progress](./progress.md): implementation and validation evidence.
- [UI design system](../../../UI-DESIGN.md#137-魔法笔记): authoritative workbench
  interaction rules, including selection and draft preservation.

An entry is a saved rich-text record within a note. A todo is a checklist item
derived from an entry. An unsaved draft belongs to the open editor; it is not
written to storage by a background refresh.
