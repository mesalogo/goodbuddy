# Data and privacy

GoodBuddy is a local-first desktop app and does not require a GoodBuddy account. Whether data leaves the computer depends on the model connection, Runtime, knowledge type, remote project, and browser features you use.

## Data flow

Local conversations, notes, tasks, settings, and knowledge indexes are stored in the application-data directory. Direct models send requests to the selected service; OpenCode, Continue, and Harness call models according to their Runtime configuration. Installing GoodBuddy or opening an empty conversation does not upload history.

With a local knowledge base, sources and indexes stay local and the Runtime receives bounded evidence and citations selected for the request. With Dify, FastGPT, or RAGFlow, the query goes to the configured instance. GoodBuddy does not upload the full conversation or local attachments or write to the external base. Returned bounded chunks and citations are stored with the local conversation.

## Credentials and boundaries

API keys, SSH credentials, and authentication data are managed by Main and protected storage; the Renderer does not read them directly. Custom headers and bodies are ordinary settings, not a place for secrets. Tools, MCP, terminals, and plugins use current-user permissions and enabled capabilities. Ask / Execute is not a separate privacy boundary.

Remote projects send bounded model configuration to an authenticated Agent, where requests run with SSH account permissions. The Agent is not bundled with the desktop package. Reconnect restores confirmed Agent output; uncertain model calls are not replayed automatically.

## Preview and clearing data

Conversation HTML preview handles completed assistant HTML only. Scripts, network requests, forms, nested pages, and window operations are disabled; turning preview off still shows source. Clear local data is an explicit confirmed action and does not delete provider records, remote hosts, remote bases, exported files, or files saved in a workspace.
