# GoodBuddy Feature Matrix and Roadmap

**English** | [简体中文](./FEATURES.zh-CN.md)

This document records the capabilities available in GoodBuddy and its roadmap.
Unchecked items are not included in the current release unless the item says
otherwise.

## Status

- [x] Completed
- [ ] To implement

Status describes implementation, not publication or test coverage. Validation
records are listed separately and do not introduce another feature status.

## Feature Matrix

### Desktop foundation, workspaces, and context

- [x] **Cross-platform desktop application**: Supports Windows, macOS, and
  Linux release targets on `x64` and `arm64`.
- [x] **Chinese hardware and operating-system coverage**: Standard Linux
  packages target compatible x64 and arm64 environments, including UOS, Kylin,
  Hygon, Zhaoxin, Kunpeng, and Phytium systems. This is not vendor certification.
  LoongArch has a separate experimental loong64 preview outside standard
  releases and automatic updates; it is built only on explicit request. See the
  [preview boundaries](./docs/development/loongarch-preview-build.md).
- [x] **Configurable global shortcut**: Enable, disable, or record an Electron
  accelerator under Platform Features / General. The default remains
  `CommandOrControl+Shift+Space`; if registration conflicts or saving fails,
  GoodBuddy keeps the previously registered shortcuts and shows an actionable
  status.
- [x] **Projects, independent conversations, and conversation branches**:
  Isolates context by project and manages conversations, attachments, and Git
  workspace changes. A stable local conversation can be copied into an
  independent branch; the branch retains a source badge but does not copy
  Tasks, queues, or artifact ownership. The project selector distinguishes
  local, managed SSH, and remote messaging-channel projects. Managed SSH
  projects are grouped by Host, with the real Agent connection state on the
  Host heading and only the remote path on each project row.
- [x] **Cross-project conversation activity**: A shared activity entry lists
  running conversations and conversations needing attention across projects,
  including older conversations with live work. Anchored project-to-conversation
  menus provide keyboard navigation and exact conversation opening without a
  full activity dialog. The summary hides when idle, long conversation submenus
  scroll independently, and project selection continues to show activity counts.
  Successful background conversations retain a completion notice during the
  current client session until their chat is visible and loaded, not across restarts.
- [x] **Pinned conversations and complete saved history**: Pin common
  conversations and retain their position after restart. Lists and search no
  longer stop at 100 conversations, and consecutive sends no longer truncate
  saved history beyond 500 messages. Model context limits still apply;
  previously lost messages cannot be restored.
- [x] **On-demand contextual help**: Supplementary page and settings
  explanations use shared title- or field-adjacent help controls with mouse
  and keyboard access. Important operation consequences and errors remain visible.
- [x] **Compact conversation controls**: Composer options share a compact
  settings panel while Runtime, mode, sending, and queue controls remain
  available. Conversation search has an inline clear action that restores the
  scoped list and returns focus to the input.
- [x] **On-demand conversation history**: Lists load lightweight summaries
  rather than every conversation's process metadata. Opened and active
  conversations retain full details; search, copy, export, continued requests,
  and remote pending questions remain available. Unchanged image reconciliation
  does not resend saved messages, and idle acknowledged details follow the
  existing view-cache lifetime. See the
  [history loading and retention rules](./docs/features/assistant-workbar/execution-history-storage.md#会话列表读取与前端保留).
- [x] **File, screenshot, window, and clipboard context**: Added to model
  context only after explicit user selection. Paste one or more supported local
  files into the chat composer with `Ctrl+V` to add attachments, using the same
  parsing progress and limits as the attachment button. Text and screenshot
  paste remain available. See [attachment rules](./docs/features/document-processing/prd.md#321-聊天附件入口).
- [x] **Text recognition in image-based PPTX files**: With local OCR configured
  and an OCR-enabled parsing workflow, embedded PNG, JPEG, and WebP images are
  recognized alongside native text, retaining slide locations. OCR releases
  model memory after 60 seconds without active or queued work and reloads on
  demand; fast text/index modes still skip OCR. See the
  [parsing behavior and real-file evidence](./docs/features/document-processing/chat-attachments-technical-design.md).
- [x] **HTTP OCR and persistent attachment previews**: Configure HTTP
  PaddleOCR-VL under Settings > Document Parsing, shared by chat documents and
  knowledge imports. Saves originals and extracted images and provides
  text/image/detail previews, explicit image-to-text actions, and selecting
  document images into a named conversation draft before sending. Ordinary chat
  images use image input by default, subject to the effective model and Runtime.
  This adds no Application Center entry; Local Inference Monitor manages local
  services only. Real validation covers Windows, direct visual input, and managed
  OpenCode on the shared Linux Host. Deployment-specific advanced OCR models and
  other Runtime combinations need separate verification. See
  [scope and evidence](./docs/features/document-processing/README.md).
- [x] **Per-file workspace diffs**: Changed files expose separate staged and
  unstaged diffs, including deleted, renamed, and untracked files. Refresh
  reloads the selected diff, browsed directory, and expanded directories; more than 50 changes
  remain accessible through incremental loading.
- [x] **Workspace file and Git management**: Create, rename, move, and delete
  files or directories, inspect properties, search and switch local or remote
  branches, create branches, explicitly Fetch, and browse commit history and
  per-file commit diffs. File and Git controls are grouped by view, branch
  search uses the shared compact form style, and subdirectories retain text
  breadcrumbs without an isolated root icon. Commit history stays docked at
  the bottom, initially expands to half the Git content area, and supports
  resizing with independently scrolling panes and one shared refresh action.
  Project switches automatically detect Git without reusing another project's
  status. Moves stay inside the workspace,
  deletion requires confirmation, and branch conflicts never trigger automatic
  stash or discard. Managed SSH operations require Agent `0.11.23`.
- [x] **Rich responses**: Supports GitHub Flavored Markdown, LaTeX math,
  constrained Mermaid diagrams, and static in-conversation HTML previews.
  Mermaid's large-diagram viewer keeps all edges reachable when zoomed and
  exports the complete diagram as PNG, independently of zoom and pan.
  Complete HTML and HTML code blocks can be previewed in place after an Agent
  reply finishes, with icon actions to reveal the source or open a full-screen
  preview. The feature is on by default and can be disabled under Platform
  Features / General; previews cannot run scripts, access the network, submit
  forms, or open windows.
- [x] **AI response and full-conversation copy**: Completed AI responses expose
  a bottom action that copies Markdown source without reasoning, tool logs, or
  citation metadata. Full-conversation copy uses the same validated
  Preload/Main clipboard path.
- [x] **Assistant workbar, multiple terminals, and resizable layouts**: The
  toggle sits beside the theme switch. The right workbar uses a persistent “+”
  capability catalog and application tabs.
  Task Center and Workspace are permanent singleton tabs; browser tabs are
  independent instances. Task Center can show the current project or all projects,
  and retains the selected scope with the layout. Tasks without a project appear
  under all projects with an “Unbound project” label.
  Users can open multiple independent terminals for the current local or
  managed SSH project with bounded output, resizing, termination, and explicit
  reconnection. Closing a terminal tab ends its Shell; restarting the app
  restores only an ended tab description and never restarts the Shell. The
  main sidebar and Magic Notes editor's AI pane support pointer and keyboard
  resizing. The AI pane remembers its visibility and width, and stacks below
  the editor at narrow widths.
- [ ] **Project Agent Space** (planned): Unifies roles, knowledge, Skills/MCP,
  models, approval policy, budgets, and timeouts in a Project, with reusable
  templates.
- [x] **Application center and navigation**:
  Clicking the bottom App Center opens a lightweight upward anchored popup with enabled apps,
  regardless of pinning or opening history, and no modal backdrop. Clicking an app row closes
  the popup; Local Inference Monitor opens a separate modal preserving the workspace, while other apps
  open their main content pages. Manage Apps opens searchable cards with settings details;
  layout and interaction rules are defined in the [UI design](./docs/features/application-tool-navigation/ui-design.md).
  All four application cards support arrow and drag reordering regardless of enablement or pinning.
  Cards, the launcher, and the filtered sidebar share one persisted order. Knowledge
  is always enabled and pinned, with Open and reorder controls. Supervisor, Notes,
  and Local Inference Monitor have enablement and pinning settings. Supervisor uses
  the existing Heartbeat identity and defaults to off when no preference is saved;
  explicit saved choices are preserved. Disabling it retains plans and history,
  blocks new reviews, and hides sidebar feedback; in-flight work may finish.
  Enabling the app does not create automatic plans. Older application orders retain
  their relative order when missing defaults are added.
  Durable settings saves, including configuration-tool writes, synchronize through change events;
  reopening the center locks edits until refresh completes, and newer snapshots supersede stale reads.
  The `local-inference` modal shows a single service list without task history or external
  connections. Embedding shows its independent process CPU and working-set memory;
  ASR/OCR explain shared-process attribution limits. ASR readiness is unknown rather
  than inferred from active requests. Supported service controls retain impact confirmation;
  failed operations refresh the list and require a new confirmation. TTS remains unavailable.
  Cancelling inference remains active in service-stop impact until worker
  acknowledgement or exit. Implementation is connected to production App;
  acceptance records distinguish full-App checks, component fixtures, real
  local-engine checks, and remaining platform/package coverage. Historical
  failures are not the current full-suite result. See the
  [validation progress](./docs/features/application-tool-navigation/progress.md).
- [ ] **Privately deployable application marketplace** (planned): Extends
  application management with an organization-owned catalog and application
  distribution. Current management covers built-in apps only, not marketplace
  browsing or installation. See
  [FR-15](./docs/features/application-tool-navigation/prd.md#fr-15-私有化市场与-yaml-交换后续).
- [ ] **Additional assistant workbar and execution-space capabilities**
  (planned): Builds on the current workbar and multiple terminals with
  broader execution supervision, unified Runtime monitoring, managed processes,
  target-pinnable workspace/browser/artifact instances, bottom
  docking, and separate windows. Task Center remains the singleton Task index;
  attachments and knowledge remain in the conversation composer, while memory,
  when implemented, and historical execution context belong to the associated Task. See
  the [Feature PRD](./docs/features/assistant-workbar/prd.md).
- [ ] **ShareServer Office co-editing** (design): Uses an optional ShareServer
  integration with ONLYOFFICE Docs to open multiple filename-labelled document
  tabs in the assistant workbar. The planned scope covers DOCX, XLSX, and PPTX
  manual editing, save and undo, source-file conflict protection, and later AI
  selection edits. The selected ShareServer and editor process document content;
  Desktop neither bundles nor starts Document Server and does not claim offline
  editing when no service is configured. See the
  [design](./docs/features/office-document-editing/README.md).

### Agent Runtimes and model connections

- [x] **Compact subagent history without lost details**: Local and managed SSH
  subagent events store changes instead of repeated full progress snapshots.
  The first upgrade automatically converts existing history and reclaims disk
  space, with visible progress and quit/retry support. Chats, execution details,
  results, and remote event deduplication are preserved; older clients cannot
  reopen the upgraded database. The schema-35 repair released in 0.13.2 also handles
  repeated tool blocks written after upgrading to 0.13.1, without deleting events.
  Terminal tasks release their write caches; duplicate remote replay does not
  rebuild a released cache. Structure-only upgrades do not reconvert history or
  reclaim ordinary free pages; the startup page distinguishes structure updates,
  legacy conversion, and actual space reclamation. See
  [storage and upgrade behavior](./docs/features/assistant-workbar/execution-history-storage.md).

- [x] **Direct model Runtime**: Supports question answering, knowledge
  synthesis, controlled tool execution, image generation, and reference-image
  editing through providers supporting the OpenAI-compatible image-editing
  endpoint. Editing sends attached images as multipart data and still requires
  validated inline image output rather than fetching provider-returned URLs.
  Follow-up image requests reuse the latest successful image and conversation
  text, including after reopening a saved conversation; explicit attachments
  take priority. Missing editing support does not block text-based generation:
  the affected reply shows a quiet footer explaining that reference images were
  not used. See [image generation](./docs/features/image-generation/README.md).
- [x] **Image tools in the current conversation**:
  Enable conversation access for an image model to let tool-capable chat models
  generate images and edit uploads or earlier artifacts in Execute, without a
  separate conversation or manually switching to an image model. Direct text
  models, local OpenCode, Continue, DeepSeek Harness, and managed remote OpenCode
  use the shared service; Runtime assignment is derived from model settings.
  Requests may incur provider charges and editing requires provider support.
  See the [implementation and validation records](./docs/features/conversation-media-generation/progress.md).
- [x] **Cross-project Runtime process reuse**: Compatible local OpenCode and
  DeepSeek Harness configurations share heavyweight processes; managed OpenCode
  sessions share a process on the same Host. Project adapters and session
  workspaces, models, tools, questions, and cancellation stay independently
  routed. Remote pending questions and task status recover after reconnect or
  Desktop restart without resending accepted prompts. Requires Desktop `0.13.5`
  and Agent `0.13.0` together for the new remote behavior. See the
  [design and measured validation](./docs/features/assistant-workbar/runtime-process-reuse-technical-design.md).
- [x] **Direct model programming agent**: Local direct text models can run the
  platform Shell in Execute mode and delegate one level of programming
  Subagent work while inheriting the parent request's mode, model, workspace,
  and capability scope. OpenCode, Continue, DeepSeek Harness, and managed SSH
  do not receive duplicate copies of these tools. The Windows local command
  path and a real-model edit, test, fix, and review loop have passed; native
  macOS and Linux command validation remains. Execute commands can select
  absolute, relative, or symbolic-link directories outside the workspace;
  the workspace stays the default and relative-path base. Ask remains read-only.
- [x] **OpenCode and Continue**: Use isolated child processes, an environment
  variable allowlist, unified configuration, cancellation, startup and control-request
  deadlines, bounded streaming output, and activity records. Shared process
  cleanup preserves complete Windows process-tree termination and terminates
  POSIX process groups when a child uses an independent process group. Chat
  status checks use a one-shot Runtime probe that is immediately cleaned up
  rather than entering the model-and-project execution cache. For managed
  local OpenCode, this passive check validates the selected path and model
  credential without starting a throwaway server; the explicit settings test,
  native inventory still performs full startup and health checks, then shares
  that execution Runtime with the first real request instead of cold-starting
  another server. Execution Runtime adapters remain reusable per project, while local
  OpenCode configuration dependencies and content-addressed Skill snapshots are
  shared globally across projects. Session data, tool output, and request-scoped
  MCP state remain isolated. GoodBuddy-managed local OpenCode keeps
  requests in the same conversation ordered, while different conversations in
  the same project and different projects can run in parallel. Request-scoped
  dynamic MCP tools remain isolated through default wildcard disablement and
  explicit current-request enablement. Managed local and remote OpenCode skip
  unused automatic Git snapshots to avoid synchronous diff stalls; file tools,
  subagents, and workspace Git diffs remain available. Continue continuously
  drains unused utility-host stdout so console output cannot fill its pipe.
  These changes apply to newly started Runtimes, not external OpenCode Servers.
  OpenCode and Continue runs do not stop
  at a fixed tool-call or activity count, and every observed tool and Subagent
  activity remains in the local conversation instead of being discarded while
  the native task continues.
  Interactive questions are answered only by foreground conversations; scheduled tasks, remote channels,
  delegated work, and other background runs fail immediately with guidance to
  rerun in the foreground
  instead of waiting indefinitely. Local OpenCode startup uses the selected
  absolute path directly without checking the file or running `--version`
  first; invalid paths fail at actual launch. On managed Linux ARM Hosts,
  Runtime activation reuses the registry and manifest verified during setup
  instead of rehashing or rechecking the complete OpenCode binary.
- [x] **Managed SSH OpenCode and Continue**: Controlled by the
  separate Remote Projects tab under Settings / Platform
  Features and disabled by default. Disabling it does not affect local
  projects, ordinary desktop capabilities, or desktop releases. When enabled,
  users can manage SSH Hosts with pinned Host Keys, browse bounded remote
  directories, and create Ask or Execute projects. Both modes start the
  signed Runtime directly without bubblewrap. Ask applies OpenCode's Ask
  permission configuration and permits only native read approvals at the
  Agent tool-dispatch boundary, while Execute explicitly allows native permissions
  and retains all permissions of the selected SSH account. The Agent owns accepted Prompts,
  provider/tool rounds, Runtime processes, a stable model ledger, and a bounded
  semantic transcript over a private Unix socket and ACP v5. Work continues on
  the Host after Desktop exit, network loss, or local-process termination.
  The current Agent may remain resident; a superseded Agent drains active work
  before exiting. Idle Runtime processes are reclaimed after tasks finish,
  while shared processes retain other active tasks, including pending questions.
  Subsequent turns recreate the Runtime and restore conversation history.
  Reconnection attaches only to the original controller, binding, and
  operation, then atomically merges provenance into the original conversation
  without resending the Prompt. Model profiles and API keys enter Agent memory
  only for the accepted operation and are not written to the Renderer, SSH
  arguments, remote environment, or disk. Remote components are not embedded
  in the desktop package; switching projects updates only local selection and
  does not connect or download. Settings reads a small signed catalog and
  reports the local version, latest compatible online version, and update
  state for Linux x64, Linux arm64, and macOS arm64. Intel Macs are not supported.
  Downloads occur only after a user action, and
  packages can also be imported or exported offline. Each compound `.gbagent`
  package contains the Agent, fixed Node, and compatible OpenCode and Continue Runtimes
  maintained by the desktop source. Online sources follow the GitHub/Beijing
  OSS choice in About and Updates. The cumulative signed catalog binds minimum
  Desktop version, Agent protocol, platform, architecture, size, SHA-256, and fixed URL.
  All three targets share one catalog. Users must upgrade Desktop before the
  first mixed-platform catalog is published because older Linux-only readers
  reject catalogs containing Darwin entries.
  The public-key registry accepts equivalent JSON whitespace and line endings
  while still strictly validating schema, Ed25519 keys, environment, and
  revocation; catalog, package, manifest, payload signatures, and streaming
  SHA-256 remain unchanged. A missing architecture package disables managed
  SSH only for that architecture. Projects store only Host, remote path,
  Runtime selection, and mode. Current Host identity is read when a
  Workspace/Runtime is first used, then reused by other projects in the same
  process. Managed SSH conversations expose supported OpenCode and Continue choices;
  Continue requires the updated compound package and matching Desktop.
  Multiple projects and conversations can run concurrently on one Host;
  Agent-owned prompts are not stopped at a fixed model-call count or
  prompt-wide output-token total, and Runtime output uses transport
  backpressure instead of cancellation when GoodBuddy buffers fill;
  recovery separately reports network, Agent, Runtime, committed-event cursor,
  completion, or failure/retry and blocks only the affected project. A real
  Linux x64 Host has covered short and long detach, forced local harness exit,
  concurrency, SSH relay loss, cancellation, definite and uncertain provider
  failure, Agent `SIGKILL`/restart, and recovery from a reopened Desktop SQLite
  database. Successful tool START/END events appear exactly once, with no
  Prompt, provider, or tool replay observed. The current Agent source lock is
  `0.13.4`, while the current Desktop release candidate is `0.13.16`; formal
  publication status follows the separate Agent and Desktop
  release channels. Previous macOS validation covered native package installation,
  detached lifecycle, Attach, real Ask/Execute, and cancellation of tools in
  separate process groups on a real Host; this does not imply publication.
  Agent `0.11.23` adds remote workspace management and optional model limits;
  its bundled Runtime no longer imposes a fixed ten-minute Prompt deadline.
  Unlimited request duration retains a separate connection timeout. Agent
  `0.11.23` requires Desktop `0.12.11` or later.
  Agent `0.11.24` requires Desktop `0.13.0` and fixes native question routing
  and sending another message after cancelling a pending question.
- [x] **Manual SSH Host environment provisioning source path**: After Host Key,
  authentication, and system probes succeed, GoodBuddy saves the Host and
  read-only probes the shared Agent/Runtime. Saving a Host or opening a project
  never installs automatically. A Host card has one primary action based on
  version facts, Install Remote Environment, Update Remote Environment, or
  Reinstall, plus a secondary SegmentedControl for Auto, Host Download, or
  GoodBuddy Transfer. The selection defaults to Auto and is not persisted; a
  Version Matched badge does not mean the environment is healthy. Auto probes
  only before operation preparation and chooses one acquisition route.
  Explicit choices remain in effect, and prepare, commit, or adoption failures
  do not silently fall back across acquisition routes. Both routes deliver the
  same signed compound `.gbagent` into fixed staging and share control-plane
  prepare, commit, Agent activation/health, Runtime activation, finalize, and
  explicit cleanup. The GoodBuddy route can download and validate a missing
  candidate during the same operation, cache it with a lease, and stream one
  archive plus its verified bootstrap Node over bounded SFTP without loading
  the roughly 294 MiB package into a Main-process `Buffer`; the Host performs
  one complete payload verification while extracting. An unfinished operation
  stores only the operation ID needed to clean staging. A later update makes a
  best-effort cleanup and starts prepare again, without persisting a remote
  metadata copy or allowing cleanup failure to block a new update or roll back
  a healthy environment. Existing projects resolve current Host identity on
  demand and run a fixed `attach-or-bootstrap`; registered health,
  capabilities, and prompt startup do not scan the full payload. See the
  [design](./docs/features/remote-host/environment-provisioning-technical-design.md).
- **SSH Host environment provisioning validation records**: The
  current source passed isolated Linux x64 package installation, Ask/Execute,
  native subagent external writes, reconnection, and stop/bootstrap.
  The complete Host-card acquisition matrix across GitHub, Beijing mirror,
  Linux x64/arm64, cancellation, and offline GoodBuddy transfer remains.
  Candidate CI/native packaging and system sleep/wake are not yet verified;
  this partial development evidence does not imply publication.
- [x] **DeepSeek Harness (preview)**: Uses the fixed GoodBuddy Host and an
  OpenAI-compatible model connection. It prefers an administrator-provided
  connection, otherwise follows the compatible default model or first
  compatible connection without requiring a duplicate selection. Settings
  displays the actual administrator or fallback model source. Ask permits
  only real Host-registered `read` and `skill` tools plus Main-managed Web
  Search/Fetch proxies, and rejects plugin impersonation of those names.
  Execute allows all enabled built-in and plugin tools with the current user's
  permissions. Image input follows the selected model connection's declared
  capability: text models reject images before Host or model invocation, while
  image-capable models receive bounded inline JPEG/PNG content through a
  temporary Attachment Store. On Windows, Host startup and ACP sessions share
  one canonical workspace path, so equivalent path spellings reuse the same
  working Runtime instead of failing session creation.
- [x] **DSH npm plugin marketplace**: Disabled by default and searches public
  npm `dsh-plugin` packages only after explicit user enablement. It uses the
  bundled npm to install exact versions with ordinary lifecycle scripts and
  supports enable/disable, JSON configuration, removal, automatic disablement
  after startup failure, and offline management of installed plugins.
  Disabling the marketplace hides only the catalog and management interface;
  it does not change the enabled state of installed plugins, and third-party
  code is not subject to Ask initialization isolation.
- [x] **Ask and Execute work modes**: Ask remains read-only. Execute is the
  user's authorization for all tools, processes, network access, and writable
  paths available to the current local or SSH account, including paths outside
  the workspace and native subagent work.
- [x] **Efficient direct-model workspace tools**: Direct models use bundled
  ripgrep with native arguments for file discovery and content search, read large
    UTF-8 files by line, and apply multi-file patches in Execute. Ask searches stay
    read-only within the workspace; Execute searches use current-account permissions.
    No system ripgrep install is required. Search preserves native output and exit
    codes, with complete large results available through `output_read`; actionable
    argument errors let the model correct its request and continue.
- [x] **Long context and paged tool output**: Message history, long replies,
  and parsed document text no longer use the previous fixed truncation limits.
  Direct models can continue reading stored search, command, and Subagent output in
  pages; the selected model's context window and bounded transports still apply.
- [x] **Native Runtime interaction routing**: OpenCode and Continue questions
  support choices, yes/no, free-text answers, and skipping through the existing
  question card. Local and managed SSH OpenCode also route questions from
  owned child sessions. Managed SSH requires Desktop `0.13.0`, Agent `0.11.24`,
  and a newly started managed Runtime;
  this does not extend question support to arbitrary ACP services.
  Successful answers and skips retain the original questions and answers
  at their original position across rounds and local conversation reloads; answers discarded by older
  versions cannot be recovered.
  Concurrent questions wait in order, duplicate events preserve drafts, and
  failed submissions remain retryable. Cancelling a pending managed SSH
  question allows another message in the same conversation.
  Execute permission confirmations are handled automatically rather than
  waiting for another approval. See the [interaction boundaries](./docs/features/assistant-workbar/runtime-interactions.md).
- [x] **Native execution checklists**: OpenCode and Continue update a
  read-only checklist above the conversation, with progress saved in history.
  Explicit clears and remote replay retain request ownership; cancellation
  does not mark unfinished items complete. Remote delivery requires the matching
  Agent package. See the
  [checklist contract](./docs/features/assistant-workbar/runtime-checklist-technical-design.md).
- [x] **Experts and Subagents**: Supports explicit experts, team analysis, and
  up to three experts running in parallel. Experts inherit the parent
  Ask/Execute mode and can use enabled local direct-model tools; Ask remains
  read-only. They are not remote OpenCode child sessions. Chat shows each
  expandable full expert response first and the main Agent's synthesis below,
  and persists both with the conversation.
- [x] **OpenCode child progress and final results**: Child cards show ordered
  text, reasoning, and tool progress separately from the final result. Remote
  live progress requires Agent `0.11.20`; older packages still expose final
  results without reconstructing missing progress.
- [x] **OpenCode event-stream cleanup**: Chat requests and native context
  compaction close their own subscriptions before ending event iteration,
  including completion, failure, cancellation, and early consumer exit,
  without cancelling parallel conversations.
- [x] **Accurate message-footer status**: Distinguishes request preparation,
  retry waiting, retry dispatch, tool activity, pending answers, and terminal
  states. Local OpenCode reports native retry attempts and scheduled times;
  direct models report their own backoff phase. Footer dots are static, and
  unsupported Runtime retry details are not invented. Conversation-list
  indicators and send/stop behavior remain unchanged.
- [x] **Simplified Runtime selection**: Conversation and project menus no
  longer enumerate every Runtime/model combination. Configure Runtime models
  in system settings; saved fixed project selections remain usable and
  explicitly display their fixed model.
- [x] **Role-bound model connections**: Each role can inherit the default model
  or select an independent text-model connection. Invalid connections safely
  fall back to the default; the synthesis role always inherits the default.
- [x] **Multiple model protocols**: Supports Anthropic Messages, OpenAI
  Responses, OpenAI Chat Completions, OpenAI Images, and unauthenticated local
  models. New users receive a local Ollama-compatible default and no
  preconfigured third-party cloud provider. During upgrades, GoodBuddy
  replaces a historical default only when it has never received credentials
  and still exactly matches the old built-in value; explicitly saved
  connections and encrypted credentials remain unchanged. Existing
  deployments that supply credentials only through compatible environment
  variables retain their historical connection parameters, while generic
  model environment variables still take precedence. Save and Test Model sends
  a bounded real text or image-generation request and validates the generated
  result instead of testing HTTP reachability alone, so it may incur a small
  provider usage charge.
- [x] **Custom model request fields**: Each LLM connection accepts bounded
  JSON objects for additional request headers and top-level body fields.
  Direct requests and Continue support both; local OpenCode and DeepSeek
  Harness use only their natively supported headers, while the managed SSH
  OpenCode model gateway supports both. Runtime, protocol, and authentication
  fields take precedence, and these ordinary connection settings must not be
  used to store API keys or other secrets. See
  [model request customization](./docs/features/model-connections/README.md).
- [x] **Context usage and automatic compaction**: Direct models update usage
  from each successful provider call. Images and tool rounds use the same
  accounting, with estimation only when the provider omits usage. The UI
  distinguishes This Model Call from Post-Compaction Conversation Estimate,
  and the compaction line is recalculated from current settings and the
  selected model window rather than storing old configuration per
  conversation. Before/after compaction markers use one estimation method,
  while activity history retains provider usage for each call. Conversations
  and multi-round tool Agents can compact repeatedly after a completed call
  crosses the threshold, reserving budget first for fixed prompts, tool
  definitions, and summaries. One response separately preserves compaction
  markers for Agent tool context and conversation history, and summaries remain
  reusable after app restart or when older messages leave the local history
  window.
- [x] **Persistent credential protection**: Main encrypts API keys with secure
  system storage and never exposes them to the Renderer. A managed SSH accepted
  Prompt places the current profile and key in Agent memory only, never in SSH
  arguments, the remote environment, or disk; other paths keep credentials
  inside Main. Credentials remain attached to their model connection when the
  service URL changes or authentication is temporarily disabled, and are
  removed only when the user explicitly clears them or deletes the connection.
- [x] **Bounded failure diagnostics**: Desktop stores a fixed allowlist of
  startup, Runtime, and remote-connection failure stages in the user-data
  directory, rotating at four 256 KiB files. Each GoodBuddy Agent rotates
  daemon, connection, recovery, and Runtime lifecycle diagnostics at three
  64 KiB files in its private installation state and exposes them through the
  fixed `diagnostics --installation-id` command. Both sides store only
  allowlisted stages, stable error codes/types, and fixed short messages, never
  Prompts, credentials, file contents, paths, environments, SSH arguments, or
  raw provider responses. Diagnostic-write failure does not alter normal
  operation.
- [x] **OpenCode Runtime customization**: GoodBuddy-managed OpenCode can
  discover native Agents, Tools, Commands, LSPs, Formatters, MCP, Skills,
  Prompts, and Resources. Tools show read, file-edit, command, network, Agent
  orchestration, and other types, source, and Ask/Execute availability while
  hiding OpenCode's internal `invalid` tool and temporary GoodBuddy MCP tools.
  Users can save a default Agent, override it per request, run Commands through
  the native SDK, view context usage, and invoke native Compact with a total
  timeout. Questions from concurrent external Server conversations are mapped
  by public request ID so answers cannot cross conversations. External
  OpenCode Servers report connection state only and do not claim native
  catalog access. Arbitrary plugin installation, Session Share, automatic
  Worktree, and OpenCode native-session persistence remain unavailable.
- [x] **Continue Runtime customization**: Exposes native Rules, prompt
  templates, and MCP from static configuration plus editable GoodBuddy Rules
  and Prompt presets. Chat can select a preset per request and insert an
  editable Prompt. The current Continue Host has no trustworthy static native
  Tool discovery API and runs with an isolated `CONTINUE_GLOBAL_DIR`, so the UI
  explicitly marks static Tool discovery unsupported and does not present
  workspace or user Skills that the Host will not load as native capabilities.
  GoodBuddy-assigned Skills still execute through per-request staging. The
  temporary Continue Host does not reuse native session compaction; manual
  compaction uses the GoodBuddy summary model and verifies persisted summary
  coverage. Agent questions become unified question cards. Resources, Hooks,
  background Jobs, and Continue native-session management remain deferred.
- [x] **Native Runtime catalog semantics**: Native capabilities are displayed
  across 11 tabs: Agents, Tools, Commands, Skills, MCP, Rules, Prompts,
  Resources, LSP, Formatters, and Context. Catalog state is independent from
  Runtime connectivity and distinguishes complete, partial, unavailable,
  connection-only, and unsupported. DeepSeek Harness enumerates bounded
  built-in/plugin Tools and Skills through the Host Registry, reports real
  Ask/Execute boundaries, and excludes per-request GoodBuddy Skills and
  Web/MCP proxies.
- [ ] **Runtime supervision section** (planned): A fixed section in the
  application-level assistant workbar for Task-level delegation, background
  execution, Workflows/Hooks, long-running work, and native-session
  supervision across OpenCode, Continue, and DeepSeek Harness. Users select
  only Conversation or Task; Job/Run remains internal rather than becoming a
  tree or independent object.
- [ ] **Advanced Subagent supervision** (planned): Task-level aggregation in
  the workbar's fixed Runtime section, configurable nesting, parallelism,
  budgets, and lifecycle controls. Basic expert-mode inheritance and
  single-level direct-model programming delegation are already available.

### Skills, MCP, and knowledge

- [x] **On-demand Skills**: Assignable to direct models, OpenCode, Continue,
  and DeepSeek Harness with bounded resources and controlled Runtime boundaries.
- [x] **Local tool-execution environment source path**: Under Capabilities and
  Tools / Tool Environment, users can select GoodBuddy-managed Node.js,
  on-demand managed Python, or a genuinely validated custom interpreter for
  local Skills and stdio MCP. The page provides an independent Native/OSS
  source choice, diagnostics, installation progress, cancellation, and
  removal. New local Runtimes and stdio MCP processes receive immutable PATH
  snapshots without changing ordinary terminals, the system environment, or
  remote Hosts. Managed Node and native-source Python have passed real
  installation validation on Windows x64. Managed Python archive validation
  follows the target filesystem: Linux preserves valid case-distinct paths,
  while every target still rejects exact duplicates and unsafe entries.
- **Local tool-execution environment validation records**: All six
  platform/architecture OSS mirror objects have passed public byte, size, and
  SHA-256 verification. Managed Python remains an on-demand download and does
  not add license files to the Desktop package. Each standard package job uses
  a native target-architecture Runner and performs a real managed-Python
  install, SSL, pip, and venv probe before packaging. The immutable `v0.12.0`
  attempt passed Windows and macOS but exposed Linux TAR case handling before
  publication. The immutable `v0.12.1` attempt was cancelled before native
  packaging while synchronizing the Agent release. Published `v0.12.2`
  subsequently passed all six native package jobs and their managed-Python
  install probes. Real Skill/MCP execution, custom interpreter execution, and
  coordination with affected running processes remain
  acceptance work. Six-platform release acceptance must not be claimed before
  the applicable checks pass.
- [x] **On-demand built-in MCP**: Knowledge, Magic Notes, GoodBuddy
  configuration, and built-in browser MCP can be enabled independently and assigned to direct
  models, GoodBuddy-managed OpenCode, and Continue. Settings explicitly marks
  DeepSeek Harness unsupported. Built-in MCP uses short-lived local authority
  for the current request, and user configuration cannot loosen Ask/Execute
  read/write boundaries.
- [x] **MCP Tools**: Explicitly enabled custom MCP can be assigned to direct
  models, GoodBuddy-managed OpenCode, Continue Agent Execute, and DeepSeek
  Harness, and loads only in Execute. Agent child processes receive only
  per-request local-loopback authority; MCP addresses, commands, and
  credentials remain in Main. Dynamic tools pass through discovery and the
  existing activity and permission boundaries; healthy direct-model
  and Harness calls reuse the discovered request catalog instead of
  rediscovering it before every call.
- [x] **MCP Prompts and Resource metadata**: MCP testing discovers bounded
  Prompt, parameter, and Resource metadata only when the Server declares the
  corresponding capability and does not read Resource content. Supported
  Prompts can be inserted into the chat draft for further editing. OpenCode can
  report an experimental Resource catalog; the current Continue version
  explicitly does not support Resources.
- [x] **Local knowledge bases**: Supports file, directory, and web imports,
  SQLite FTS5 retrieval, and source tracing. Knowledge selection persists per
  conversation and starts empty for new conversations. Advanced creation and
  retrieval parameters are collapsed by default. Documents distinguish ready,
  processing, and failed states, with source opening, retry, and confirmation
  before source removal.
- [x] **External knowledge-base connections**: Manage Dify, FastGPT,
  and RAGFlow instances from the Knowledge page, then discover remote
  knowledge bases or enter their IDs and verify bindings with provider-specific
  retrieval settings and citations. Conversations support on-demand and
  required pre-answer retrieval. External systems provide retrieval only:
  GoodBuddy does not use
  their App, Chat, Workflow, or Agent APIs, and does not bulk-sync, locally
  index, or modify remote content. Bounded cited snippets are retained locally
  with their conversations. See the
  [external knowledge-base PRD](./docs/features/knowledge-base/external-knowledge-prd.md).
- **External knowledge-base validation records**: All three providers have passed
  real service, local HTTP MCP, and production-IPC short-answer checks; Dify
  additionally passed the complete App composer-to-answer-and-citation path.
  FastGPT/RAGFlow desktop-specific parameters, complex multi-library answers,
  and remote pre-answer retrieval remain unverified. See the
  [validation evidence and remaining work](./docs/features/knowledge-base/progress.md).
- [x] **Knowledge graph**: Supports rule-based, model-based, and hybrid
  extraction plus entity, relationship, alias, and evidence maintenance.
  Model extraction adds no fixed 8192-token output cap: OpenAI follows provider
  limits, and Anthropic uses the model connection's output setting.
- [x] **Embedding configuration and retrieval**: Configures compatible
  Embeddings endpoints and uses them for semantic retrieval.
- [x] **Embedding diagnostics and indexing jobs**: Provides real embedding
  diagnostics, per-document rebuild progress, cancellation, failure state, and
  result recovery after restart. Each successful document becomes immediately
  searchable.
- [x] **Hybrid retrieval workbench**: Diagnoses full-text, Chinese phrase,
  vector, and graph channels with configurable Top K, thresholds, weights,
  local or learned reranking, and context budgets.
- [x] **Chunking, maintenance, and evaluation**: Supports fixed, structured,
  and parent-child chunking, chunk maintenance, cancellable rebuilds, and
  bilingual retrieval evaluation.
- [x] **Controlled knowledge ontology**: Each knowledge base can define
  entities, relationships, aliases, and endpoint constraints while retaining
  evidence offsets, confidence, and extraction source, with explicit guidance
  to rebuild the graph.
- [x] **Required retrieval and cited context**: Conversations can retrieve on
  demand or before every response, show zero-result, degraded, failed, and
  cancelled states, and expose cited context or safely open its source.
- [x] **Magic Notes**: A local-first notes and todo workbench with scope
  management, editing, filtering, and controlled AI comments. Notes open from a
  responsive card overview. Detail displays a continuous stream with independently
  collapsible left index and right AI pane. The index defaults to 168px and supports
  pointer and keyboard resizing from 140px to 320px, with saved width preferences;
  narrow layouts retain the fixed-width drawer without a resize handle.
  Real first-page thumbnails scroll to
  records without replacing editors. Successful saves establish the editor's
   normalized baseline; only unsaved changes require confirmation on leaving. Opening
   a note shows a blank text/canvas composer above the history, and creation resets it
   for the next record. Explicit editing updates a saved record. The separate To-dos view offers search, status filters,
  grouped tasks and direct completion, with instructions, source entries and AI
  comments in a right detail pane beside a stable task list. Narrow views offer
  on-demand detail with an explicit return to the list. Wide views support a
  draggable list/detail divider with a saved width; source-note groups collapse
  independently without clearing the selected task's details. A content-sized switch sits
  beside New note in the header; status filters follow search. Source-note
  navigation returns to the same task context, without
  showing the previous item's source after a selection change. Failed reads
  use application notifications with inline retry, and missing sources have an explicit fallback. The left
  navigation can show the incomplete-todo count, and create, save, and comment
  results use application-wide notifications. Agent/MCP note writes automatically
  refresh the open workbench while preserving selection and unsaved drafts.
- [x] **Paged canvas notes**: The integrated PeopleLib Fabric + Quill editor
  combines flowing body text with pen/highlighter, object selection/transforms,
  floating text, images and paper templates. Editors and read-only viewers support
  25%-300% view zoom, 100% reset and responsive Fit width, without changing saved
  content or export dimensions. Import PDFs as page backgrounds
  with native text extraction, then export a raster PDF of text and annotations;
  exported PDFs do not retain a searchable text layer. Manual saves store entry
  bodies and binary assets in local note files; SQLite retains metadata, indexes,
  revisions, todos and comments. Backups must coordinate SQLite and the notes
  directory; there is no one-click backup action. Undo/redo
  is per annotation page or Quill mode, not global document history; there is no
  infinite canvas or PNG download button. Drafts, saved entries and canvas-source
  todos use the default model's image-input capability for page images plus text,
  or an explicitly labelled text-only fallback. Canvas pages to send selects the
  first 1-8 pages in current order (default 1) for both text and images; saving and
  exporting still support 50 pages. Purely visual entries/drafts
  require an image-capable model. Immediate-comment mode offers manual canvas
  analysis; after-save automatic analysis failures do not block or undo saving.
  Text-only comments survive unchanged extracted text; visual comments are
  invalidated by layout changes and reanalyzed in after-save-auto mode. MCP
  rejects plain-text replacement of canvas entries. Implementation is complete;
  final validation status is tracked in the [feature progress record](./docs/features/magic-notes/progress.md).
  The first upgrade migrates stored bodies into files and raises the database
  schema to 39 together with attachment changes. Older clients cannot reopen
  that database; rollback requires a pre-upgrade backup.
- [ ] **MCP Server Control Plane** (planned): Unified MCP lifecycle, health
  checks, reconnection, schema cache, isolation, approval, and audit.
- [ ] **Traceable note excerpts and AI editing** (planned): Collects sourced
  excerpts from conversations, knowledge, and the web and provides
  confirmation-based summarization, rewriting, and organization.

### Work management, long-term collaboration, and workflows

- [x] **Tasks, activity, and artifacts**: Centrally manages task state, audit
  activity, and independent artifact files. Ordinary chat responses remain
  only in the conversation and are no longer copied into Artifacts; existing
  duplicate chat Markdown is hidden from the artifact list but not physically
  deleted. Run history is stored in Main SQLite without the previous 500-item,
  4,000-character, or 2 MB Renderer limits; the page renders it in batches,
  without a persistent legacy-cache truncation warning; previously lost
  history is not restored. Token usage is grouped by Runtime and
  model and normalizes the different OpenAI-compatible and Anthropic Messages
  cache-reporting semantics when showing cache hit rate. Project and conversation
  usage groups show collapsed totals by default and expand to Runtime/model child
  rows; model grouping remains flat. Activity is grouped
  by conversation and collapsed by default so long histories do not fill the
  page.
- [x] **Compact conversation tool records**: Expand individual tool records
  to read or copy results, errors, and input parameters. Conversation and
  child-task progress use concise rows without repeated Runtime summaries.
  OpenCode, Continue, DeepSeek Harness, and direct models show available file
  paths, commands, or search summaries and retain them through completion and
  conversation reloads.
- [x] **Task and custom-task experience**: Each product-level Task belongs to
  one Conversation, while one Conversation can contain multiple Tasks. The
  left conversation list exposes Task children through a leading expand
  button; children share status dots, the parent does not repeat task badges,
  and the UI stops at Task rather than exposing Job/Run levels. A new custom
  Task can use the current or a new Conversation, defaults to Execute, and
  preserves Runtime, tool, and approval boundaries. Repeated triggers reuse the
  same Task; text returns to the Conversation, while independent files and
  images remain artifacts. Ordinary messages and due Scheduled Tasks share a
  persistent Conversation queue that runs one item at a time. Users can keep
  sending while a response is active; queued items continue in order and can
  be removed or inserted immediately by interrupting the current item. Task
  Center remains the complete index rather than creating a separate Automation
  Center. Current schedules support one-time, daily, and weekly triggers;
  advanced time zones, Cron, event triggers, and retry governance remain
  incremental PRD work. Scheduled messages use the conversation's current
  history, Runtime, work mode, and saved knowledge retrieval settings; task
  details show the actual mode used, and an active occurrence blocks duplicate
  Run Now actions. See the
  [Task Center PRD](./docs/features/task-and-job/task-center-prd.md) and
  [Scheduled Task PRD](./docs/features/task-and-job/scheduled-task-prd.md).
  Status counts and filters identify running tasks and those needing attention;
  task approvals remain actionable in their task cards.
- [x] **Memory and Smart Heartbeat**: Provides periodic review, suggested
  memories, insights, follow-up tasks, and auditable run history.
- [x] **Automatic supervision settings and scope**: Supervisor / Automatic supervision is
  the sole authoritative plan configuration, automatic report, and suggestion entry. Daily or weekly plans can be
  created and edited for Global or one or more selected Projects. Legacy
  single-project settings migrate without loss, and project-level memory and
  action output must explicitly target a Project in scope. Task Center and
  Settings no longer duplicate the form. Partition-aware review, candidate
  generation, and recall triggers remain to be designed. See the
  [Smart Heartbeat PRD](./docs/features/smart-heartbeat/prd.md).
- [x] **Supervisor reviews, story graphs, and activity**: Review a selected scope
  and period, read dated supervision results and history in Work review, inspect saved result graphs and sources, confirm or revise entities,
  and preview local knowledge entity writes. Sidebar feedback follows or pins a
  Conversation or Task and opens its matching result. It shows target names with
  compact pin/refresh buttons and preserves long-title readability and keyboard
  focus in narrow sidebars. Activity combines heartbeat
  and downstream review stages, including failures and links to older results.
  Automatic stages process only new, changed, or unprocessed source portions;
  no-change checks skip model calls. Manual review pages through the selected history
  and saves batches with their facts and sources. Runs can pause and resume from
  saved progress, without fixed-duration automatic pauses; settings expose
  concurrency, per-request timeouts, batch sizes, and response capacity.
  Activity emphasizes connected stages and saved-batch coverage, with secondary
  statistics in expandable details. Work review uses a vertical full-width
  flow with a separate run status and correctly placed empty state.
  Calls remain read-only without tools and may incur model charges. See the
  [implementation and evidence](./docs/features/conversation-supervision/progress.md).
- [ ] **Further supervision capabilities** (planned): Full event-by-event replay,
  Experiment targets, chronological manual-edit audits, event
  triggers, and broader execution observation remain incomplete. Current automatic
  review respects input budgets and the rolling window; deleting reports does not
  reset processing progress or rebuild graphs. See the
  [Conversation Supervision PRD](./docs/features/conversation-supervision/prd.md).
- [ ] **Batch runs and comparison lab** (planned): Compares model, Prompt,
  role, and workflow configurations in batches and summarizes quality,
  duration, tokens, cost, failure rate, and artifact differences.
- [ ] **Temporal memory and fact-conflict detection** (planned): Adds validity
  periods, current/expired/conflicting fact detection, fact checking, and
  evidence tracing to memory and the knowledge graph.
- [ ] **Visual controlled workflows** (planned): Versioned DAGs, conditional
  branches, approvals, cancellation, and recovery, with execution still
  passing through Main Runtime boundaries.
- [ ] **Unified Run Graph and replay** (planned): Connects Tasks, Subagents,
  models, knowledge, tool approvals, usage, and artifacts for failure
  diagnosis, retry, and redacted export.

### Browser, communication, voice, and application maintenance

- [x] **Shared built-in browser for runtimes**: Uses GoodBuddy's isolated
  Chromium and never controls a browser installed by the user. A separate
  master switch decides whether assigned runtimes receive the capability in
  Execute, with no per-use prompt after enablement. Turning Agent access off
  does not disable manual browser workbar actions. The Browser workbar and
  Agent share the same Conversation-owned session and serialized operation
  path, with Back, Refresh/Stop Loading, address entry, Go, Interaction, and
  Close actions. Stop Loading does not close the session, and user navigation
  changes the page the Agent sees next.
  Multiple tabs in one conversation share login state while keeping separate
  pages and navigation. Each model request retains its starting tab binding;
  unused request reservations do not create browser resources. Released tabs
  can be reopened, explicit screenshots remain available, and ordinary
  operations no longer trigger unused automatic screenshot capture.
  Tabs can be closed while an AI request uses them without cancelling the
  whole request. A later explicit navigation creates a separate replacement
  tab; blank pages cannot reload, and switching or closing panels clears stale
  action errors.
- [x] **Client-computer control tools**: Managed separately from the built-in
  browser with scope, cancellation, timeout, output, and activity boundaries.
- [x] **Remote messaging-channel projects**: WeChat ClawBot, WeCom, and
  DingTalk each have a system-managed project, independent remote
  conversations, working directory, processing backend, default Ask/Execute
  mode, and task/activity ownership. Each channel controls complete-response
  length and segmentation according to platform capabilities rather than
  relying on a shared service truncation.
- [x] **WeChat ClawBot QR login and media**: A separate Sidecar handles local
  QR scanning, verification codes, encrypted credentials, and text messaging.
  Personal WeChat chats support images and files, with at most four
  attachments and 12 MB total after decryption per message.
- [x] **Safe WeChat responses**: Can return images generated by the current
  task, or generate a Markdown attachment from the current final text after an
  explicit user request. It never automatically reads or sends existing
  workspace files.
- [x] **WeCom and DingTalk connections**: Main-only encrypted settings,
  read-only environment-variable overrides, connection tests, dynamic
  enable/disable, sender scope, and status diagnostics.
- [x] **Managed local-model download source**: Platform Features / General
  selects ModelScope (default) or Hugging Face globally for future speech-input
  and OCR model downloads. A source without a complete verified file is
  explicitly unavailable and never silently falls back or combines files.
- [x] **Optional local speech-model management**: Model weights are not bundled.
  Provides verified downloads, progress and cancellation, source links, ZIP or
  local-directory import, switching, and removal.
- [x] **Local recording and offline transcription**: Captures microphone audio
  and transcribes with the selected local model, with stop, cancel, state
  feedback, and resource cleanup.
- [x] **Version checks and mirror source**: About and Updates selects GitHub
  (default) or the mirror. Manual checks, startup checks, and the download page
  use the same choice and read only fixed trusted release indexes; GoodBuddy
  does not automatically download or install updates.
- [x] **Window recovery controls**: Rendering errors show a localized Reload
  action and renderer crashes offer a native recovery confirmation. Reload may
  lose unsaved input. See [window recovery](./docs/development/window-recovery.md).
- [x] **In-app feedback**: About and Updates can submit problems, suggestions,
  or experience feedback with an optional email and one screenshot.
  Diagnostics are not uploaded by default; users can explicitly attach a
  bounded recent Desktop diagnostic summary. Failed submission preserves the
  draft, diagnostic choice, and request ID. Conversations, Prompts,
  credentials, file contents, paths, raw provider responses, and remote Agent
  logs are never attached.
- [x] **Private-network compatibility**: Permits in-app HTTP plus invalid,
  self-signed, or expired HTTPS certificates. Fixed platform services such as
  feedback and WeChat credential or media endpoints retain strict certificate
  validation.

### Open source, builds, and releases

- The current Desktop candidate is `0.13.16`; Agent `0.13.4` is published, with
  OpenCode pinned to `1.18.29` and Continue to `1.5.47`. Publication status follows the independent
  Desktop and Agent release channels.
- Desktop `0.13.15` carries forward the unpublished `0.13.14` changes to paged Supervisor reviews and resume behavior,
  native ripgrep searches, to-do layouts, and explicit remote follow-up after an
  uncertain result. Database schema 47 requires a complete pre-upgrade backup
  for rollback to older clients.
- Desktop `0.13.16` separates structure upgrades from legacy history reclamation,
  removes fixed-duration review pauses, and clarifies Supervisor layouts.
  It adds no schema change over `0.13.15` and requires no Agent update.
- Agent `0.13.3` reclaims idle Runtimes and retires displaced Agents after existing
  work drains. Its packages require Desktop `0.13.12`;
  update Desktop first, then the Host environment. Node remains `24.19.0`.
- Agent `0.13.4` waits for model delivery acknowledgements before completion,
  preserves completed results when idle Runtime cleanup fails, and removes verified
  inactive Agent payloads and owned orphan processes after environment updates.
  History and active or uncertain installations are retained. Its independent
  packages require Desktop `0.13.14` or later. Since `0.13.14` did not publish,
  upgrade to Desktop `0.13.15` first, then update the Host.
- Release preparation requires the full test suite, notes verification,
  typecheck, and lint. Candidate main-branch CI, its production build, native
  packaging, and publication verification remain separate acceptance steps.
  No local production build, packaging, or LoongArch preview is requested.
  Current validation status is recorded in the
  [release preparation record](./docs/development/release-preparation-0.13.16.md).
- Desktop `0.13.12` and Agent `0.13.3` have completed their native release jobs;
  this does not replace development-time real-Host scenario coverage.
- Validation records remain separate from implementation status. Current-source
  storage validation covers real local and Linux x64 Host tool workloads,
  concurrent projects/conversations, cancellation, and lossless database migration.
  Runtime process reuse has real Windows full-App and Linux x64 Host evidence;
  PPTX OCR and idle-memory release have real Windows file evidence. Image tools
  have real provider generation/editing and Host transport evidence. Full
  UI-driven natural-language invocation and local/remote switching are not
  covered by those records. The candidate still requires main CI and
  native release packaging. See the [Runtime evidence](./docs/features/assistant-workbar/progress.md)
  and [image-tool evidence](./docs/features/conversation-media-generation/progress.md).
- Before release preparation, `9836a4c` passed 4,858 local tests with 67 skipped,
  full typecheck and lint; real-provider canvas analysis remains unverified.
  Its three native Agent CI builds passed. Desktop CI run `35485936807`
  passed 4,875 tests but failed eight Electron tests before UI assertions because
  the Linux sandbox helper was not configured. The candidate configures the
  helper and runs tests under Xvfb without disabling sandboxing. Candidate-local
  validation, main-branch CI and native tag packaging are tracked separately;
  no local production build or package is part of release preparation.
- [x] **0BSD open-source license**: Original code can be freely used, copied,
  modified, distributed, and commercialized. Third-party components and
  resources retain their own licenses.
- [x] **Reproducible dependency installation and source builds**: Uses locked
  dependencies, Node.js 24, and unified test, type-check, lint, and production
  build commands.
- [x] **Six-target native release matrix**: Native runners build Windows,
  macOS, and Linux `x64` and `arm64` targets with release manifests and SHA-256
  hashes. Windows provides NSIS and portable ZIP, macOS DMG only, and Linux
  AppImage, DEB, and RPM, for 12 installers and 20 published assets.
- [x] **Desktop Runtime package verification**: Offline OpenCode dependencies
  are copied without electron-builder's root node_modules exclusion; DSH
  session projection is bundled into the unpacked Host. Final package checks
  compare the offline dependency tree and reject external DeepSeek imports.
  Windows x64 CI additionally imports the packaged OpenCode plugin and checks
  the real DSH UtilityProcess handshake before publishing.
- [x] **DMG-only update manifests**: Current Desktop and website readers accept
  DMG-only and historical DMG/ZIP manifests. Older macOS GitHub readers and all
  older mirror readers require a manual upgrade from the download page.

### Open interfaces, team collaboration, and remote execution

- [x] **Remote Continue delivery**: Current source supports a
  managed CN 1.5.47 package, Agent HTTP-to-ACP adaptation, model routing, project
  selection, and native checklists. Linux x64 development packages passed real
  model, cancellation and reconnection checks. Default packages include OC/CN;
  Windows desktop-to-Linux checks cover installation, checklist updates, long lists,
  cancellation and restart recovery. Execute session MCP delivery passed real
  text-model Host checks with a substituted image service, not real image generation.
  Published Agent `0.13.4` requires Desktop `0.13.14` or later; publication and native
  platform acceptance remain separate from Linux development evidence. See the
  [validation record](./docs/features/remote-host/runtime-checklist-validation.md).

- [x] **Remote task delegation**: Enabled only after the user explicitly
  configures an endpoint and token, uses HTTP(S) according to the global
  private-network compatibility setting, and writes results to a persistent
  outbox.
- [ ] **Headless Runtime API** (planned): A local-first Task, event, state, and
  artifact API with scoped, expiring, rate-limited, and revocable tokens.
- [ ] **GoodBuddy Team Hub** (planned): An optional service for organizations,
  RBAC, project sharing, remote Agents, policy distribution, and tenant audit.
- **SSH Host and remote execution-space validation records**: Host CRUD,
  Host Key, encrypted credentials, Project UI, Workspace, OpenCode ACP v5,
  Agent-owned Prompt/gateway/transcript, read-only Ask, full-account Execute,
  cancellation, exact detached-Agent reconnection, and release-only
  dual-architecture resource verification are wired. Current Linux x64 source
  has passed a real-model and tool matrix covering detach, process exit, relay
  loss, concurrency, cancellation, provider failures, Agent restart, and
  Desktop SQLite recovery. A current-source, test-signed Agent `0.11.17`
  package on Linux x64 additionally passed two concurrent Ask reads, an
  Execute write/read, and six real managed-gateway model requests with the
  configured custom headers and body fields. No provider request was replayed,
  and scanning the isolated Agent state found no API key or custom request
  value. The public signing-key registry is provisioned. Direct control-plane
  source does not wait for a new installer-bearing package, but the current
  formally signed Linux x64/arm64 artifact matrix still requires public
  verification, along with GitHub/Beijing mirror, dual-architecture, and
  offline GoodBuddy transfer release acceptance. Until these gates pass, this
  path must not be described as published or as having passed formal release
  acceptance.
- [ ] **Multi-cloud remote sandbox Agents** (planned): Manages dedicated Linux
  sandboxes through cloud-provider APIs and SSH Agents. Credentials remain in
  Main, and high-risk control-plane operations receive separate confirmation.

## Roadmap Principles

Planned workflows, Subagents, MCP, remote APIs, and sandbox capabilities must
not bypass existing Main Runtime, Ask/Execute, permission, cancellation,
timeout, or audit boundaries.
