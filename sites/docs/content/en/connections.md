# Configure model connections

A model connection stores a service URL, protocol, model name, authentication method, and optional request customization. Projects and conversations can reuse it, while credentials remain managed by GoodBuddy's main process. A usable connection does not mean every Runtime supports every field.

## Create and test a connection

Open Settings > Model connections > LLM. Create a connection with a name, HTTP or HTTPS URL, protocol, model ID, and API key. Save it and run Test connection. A successful test proves that the basic connection works; image generation, tools, and native Runtime clients still need their own real request path.

Connections can be copied. Copy creates a new connection and leaves the original unchanged. A saved key is copied through the protected credential path and is never returned to the page or error text. Choose the connection in a project or conversation picker, or choose the Runtime default.

## Custom headers and body

The Advanced settings area has two JSON editors. Headers must be an object whose values are strings, and the body must be a serializable top-level JSON object. Syntax, type, size, and reserved-field errors block saving while keeping the original text for correction.

Runtime, protocol, and authentication fields take precedence. Custom values cannot replace model, message, tool, streaming, or authentication fields. Body values merge only at the top level. Keep API keys and other secrets in the dedicated credential field. Direct models and Continue support both customizations; local OpenCode and DeepSeek Harness support headers but not custom body; managed remote OpenCode supports both.

## Scope and diagnostics

Connections are Settings resources; projects and conversations store the selection relationship. Vector connections are for knowledge indexing and do not appear in Runtime model pickers. For diagnosis, test the basic connection first, then confirm the Runtime and model used by the real request. If custom values appear to cause failure, clear them temporarily. A connection test is not a generation guarantee.
