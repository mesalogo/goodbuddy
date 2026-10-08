# Supervision

Supervision reviews completed work, highlights changes and issues, and records supported results in the story graph. It does not send messages, approve tools, expand file scope, or change execution permissions. The Supervisor app is off by default.

## Enablement and scope

Enable Supervisor in the app center, then choose the default text model or an existing text connection in Settings. The first review requires an explicit project, conversation, and time range. Automatic supervision can target Global or selected projects; changing the active project does not change a saved scope.

## Review and story graph

Work review reads conversations, Tasks, notes, and sources within the selected scope and produces sourced summaries, changes, and unresolved items. With no valid new change it records no change and does not call the model. Review is incremental by default; use Reorganize for a historical interval.

The story graph presents events, entities, relationships, and changes over time. Select an object to inspect its sources. Conversations, notes, and knowledge bases remain the owners of source text. You can continue a discussion after checking evidence or preview a write to a local knowledge base. External knowledge remains read-only.

## Follow, pin, and intervene

The Supervision panel can follow the active conversation or pin to a conversation or Task. A pinned target stays selected across page changes and reports an error if it becomes unavailable. Suggestions create editable drafts or explicit next actions; they enter a conversation only after you choose to send them.

Supervisor does not execute suggestions and cannot send messages, approve tools, change capability switches, or expand workspace access. Its model calls are internal text requests without tools.

## Heartbeat and failures

Smart Heartbeat is the scheduled wake-up mechanism. It checks incremental changes within its scope and generates suggestions or updates memory according to the plan. The app and each plan have separate enabled states; disabling the app prevents new heartbeat runs, while an already started run may finish.

Pause, cancel, and failure keep the last successful result and saved batches. The run shows covered and omitted scope and can be retried when valid. A failed suggestion stage does not undo a published graph or review. Supervisor being off by default does not affect ordinary chat or Tasks.
