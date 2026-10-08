# Troubleshooting

First confirm the current project, conversation, Runtime, model, and local or remote execution space. Check request status and activity before repeating a send or rebuilding all data.

## The model connection test fails

Check protocol, URL, model ID, API key, proxy, certificate, and provider limits. Clear custom headers and body temporarily and test again. If the basic test succeeds but generation fails, confirm the Runtime and model capability; a connection test is not a generation guarantee.

## The reply does not use tools or files

Check Runtime support, execution space, workspace directory, enabled capability or MCP service, and account permissions. Open Workspace or Runtime in the workbar. For remote projects check SSH, Agent readiness, remote path, and Agent version. GoodBuddy has no Ask / Execute mode.

## Knowledge retrieval returns nothing

Check the conversation scope, parsing and full-text status, vector compatibility, and OCR for image-only PDFs. Use Test retrieval to see actual channels and degradation. Test with source words first, then rebuild a failed document or index. External bases also require valid authentication, remote ID, timeout, and provider status.

## A note, Task, or remote project failed

For notes and canvases, confirm that Save was explicitly used; AI comment failure does not undo saved content. For Tasks, check enabled state, pause state, associated conversation, app availability, and the latest error. Heartbeat is off by default. For remote work, check network, Host Key, credentials, permissions, and Agent preparation. Uncertain remote calls are not replayed automatically.

## HTML preview is empty or shows source

Check that the reply is complete, recognizable HTML or an `html`/`htm` block, and HTML rendering is enabled. Streaming replies, user messages, and reasoning remain source text. Scripts, network, forms, and window operations are intentionally disabled in the preview.
