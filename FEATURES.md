# GoodBuddy Feature Matrix and Roadmap

**English** | [简体中文](./FEATURES.zh-CN.md)

This document records the capabilities available in GoodBuddy and its roadmap.
Unchecked items are not included in the current release unless the item says
otherwise.

## Status

- [x] Available
- [ ] In development or planned, as described by the item

## Feature Matrix

### Desktop foundation, workspaces, and context

- [x] **Cross-platform desktop application**: Supports Windows, macOS, and
  Linux release targets on `x64` and `arm64`.
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
- [x] **File, screenshot, window, and clipboard context**: Added to model
  context only after explicit user selection.
- [x] **Rich responses**: Supports GitHub Flavored Markdown, LaTeX math, and
  constrained Mermaid diagrams. Large diagrams can be zoomed, panned, or
  viewed as source, and failed renders preserve the original diagram code.
- [x] **AI response and full-conversation copy**: Completed AI responses expose
  a bottom action that copies Markdown source without reasoning, tool logs, or
  citation metadata. Full-conversation copy uses the same validated
  Preload/Main clipboard path.
- [x] **Assistant workbar, multiple terminals, and resizable layouts**: The
  right workbar uses a persistent “+” capability catalog and application tabs.
  Users can open multiple independent terminals for the current local or
  managed SSH project with bounded output, resizing, termination, and explicit
  reconnection. Closing a terminal tab ends its Shell; restarting the app
  restores only an ended tab description and never restarts the Shell. The
  main sidebar and Magic Notes list support pointer and keyboard resizing;
  the notes list can be hidden, remembers its layout, and stacks at narrow
  widths.
- [ ] **Project Agent Space** (planned): Unifies roles, knowledge, Skills/MCP,
  models, approval policy, budgets, and timeouts in a Project, with reusable
  templates.
- [ ] **Additional assistant workbar and execution-space capabilities**
  (planned): Builds on the current workbar and multiple terminals with
  supervision, unified Runtime monitoring, managed processes, safe static HTML
  preview, target-pinnable workspace/browser/artifact instances, bottom
  docking, and separate windows. Task Center remains the singleton Task index;
  attachments and knowledge remain in the conversation composer, while future
  memory and historical execution context belong to the associated Task. See
  the [Feature PRD](./docs/features/assistant-workbar/prd.md).

### Agent Runtimes and model connections

- [x] **Direct model Runtime**: Supports question answering, knowledge
  synthesis, controlled tool execution, and image generation.
- [x] **Direct model programming agent**: Local direct text models can run the
  platform Shell in Execute mode and delegate one level of programming
  Subagent work while inheriting the parent request's mode, model, workspace,
  and capability scope. OpenCode, Continue, DeepSeek Harness, and managed SSH
  do not receive duplicate copies of these tools. The Windows local command
  path and a real-model edit, test, fix, and review loop have passed; native
  macOS and Linux command validation remains.
- [x] **OpenCode and Continue**: Use isolated child processes, an environment
  variable allowlist, unified configuration, cancellation, total execution
  limits, bounded streaming output, and activity records. Shared process
  cleanup preserves complete Windows process-tree termination and terminates
  POSIX process groups when a child uses an independent process group. Chat
  status checks use a one-shot Runtime probe that is immediately cleaned up
  rather than entering the model-and-project execution cache. Execution
  Runtimes remain reusable per project, so different projects can run in
  parallel. Interactive questions are answered only by foreground
  conversations; scheduled tasks, remote channels, delegated work, and other
  background runs fail immediately with guidance to rerun in the foreground
  instead of waiting indefinitely. On managed Linux ARM Hosts, project
  switching and cold startup reuse the Runtime path, registry, and manifest
  verified during setup instead of repeating an OpenCode version probe or
  binary check.
- [x] **Managed SSH OpenCode loop (technical preview)**: Controlled by the
  separate Remote Projects (Technical Preview) tab under Settings / Platform
  Features and disabled by default. Disabling it does not affect local
  projects, ordinary desktop capabilities, or desktop releases. When enabled,
  users can manage SSH Hosts with pinned Host Keys, browse bounded remote
  directories, and create Ask or Execute projects. Ask keeps the Workspace
  read-only at the Runtime boundary through bubblewrap; Execute has all
  permissions of the selected SSH account. The Agent owns accepted Prompts,
  provider/tool rounds, Runtime processes, a stable model ledger, and a bounded
  semantic transcript over a private Unix socket and ACP v4. Work continues on
  the Host after Desktop exit, network loss, or local-process termination.
  Reconnection attaches only to the original controller, binding, and
  operation, then atomically merges provenance into the original conversation
  without resending the Prompt. Model profiles and API keys enter Agent memory
  only for the accepted operation and are not written to the Renderer, SSH
  arguments, remote environment, or disk. Remote components are not embedded
  in the desktop package; switching projects updates only local selection and
  does not connect or download. Settings reads a small signed catalog and
  reports the local version, latest compatible online version, and update
  state for Linux x64/arm64. Downloads occur only after a user action, and
  packages can also be imported or exported offline. Each compound `.gbagent`
  package contains the Agent, fixed Node, and the compatible OpenCode Runtime
  maintained by the desktop source. Online sources follow the GitHub/Beijing
  OSS choice in About and Updates. The cumulative signed catalog binds minimum
  Desktop version, Agent protocol, architecture, size, SHA-256, and fixed URL.
  The public-key registry accepts equivalent JSON whitespace and line endings
  while still strictly validating schema, Ed25519 keys, environment, and
  revocation; catalog, package, manifest, payload signatures, and streaming
  SHA-256 remain unchanged. A missing architecture package disables managed
  SSH only for that architecture. Projects store only Host, remote path,
  Runtime selection, and mode. Current Host identity is read when a
  Workspace/Runtime is first used, then reused by other projects in the same
  process. Managed SSH conversations expose only supported OpenCode choices.
  Multiple projects and conversations can run concurrently on one Host;
  recovery separately reports network, Agent, Runtime, committed-event cursor,
  completion, or failure/retry and blocks only the affected project. A real
  Linux x64 Host has covered short and long detach, forced local harness exit,
  concurrency, SSH relay loss, cancellation, definite and uncertain provider
  failure, Agent `SIGKILL`/restart, and recovery from a reopened Desktop SQLite
  database. Successful tool START/END events appear exactly once, with no
  Prompt, provider, or tool replay observed. The current source lock and
  Agent source lock is `0.11.14`, while the current Desktop release candidate
  is `0.12.0`; formal publication status follows the separate Agent and Desktop
  release channels.
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
- [ ] **Real-Host acceptance for SSH Host environment provisioning**: The
  source can use the current format-v1 package. GitHub, Beijing mirror, Linux
  x64/arm64, cancellation, and offline GoodBuddy transfer validation remains.
  This status does not mean the path is published or has completed real-Host
  testing.
- [x] **DeepSeek Harness (preview)**: Uses the fixed GoodBuddy Host and an
  OpenAI-compatible model connection. It prefers an administrator-provided
  connection, otherwise follows the compatible default model or first
  compatible connection without requiring a duplicate selection. Ask permits
  only real Host-registered `read` and `skill` tools plus Main-managed Web
  Search/Fetch proxies, and rejects plugin impersonation of those names.
  Execute allows all enabled built-in and plugin tools with the current user's
  permissions. Image input follows the selected model connection's declared
  capability: text models reject images before Host or model invocation, while
  image-capable models receive bounded inline JPEG/PNG content through a
  temporary Attachment Store.
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
  paths available to the current local or SSH account.
- [x] **Experts and Subagents**: Supports explicit experts, team analysis, and
  up to three read-only experts running in parallel. Chat shows each
  expandable full expert response first and the main Agent's synthesis below,
  and persists both with the conversation.
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
- [ ] **Executable Subagents** (planned): Explicit Execute delegation with
  bounded nesting, parallelism, tokens, time, and tool permissions, aggregated
  by Task in the workbar's fixed Runtime section with cancellation and audit
  ownership.

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
  installation validation on Windows x64.
- [ ] **Local tool-execution environment release acceptance**: All six
  platform/architecture OSS mirror objects have passed public byte, size, and
  SHA-256 verification. Managed Python remains an on-demand download and does
  not add license files to the Desktop package. Each standard package job uses
  a native target-architecture Runner and performs a real managed-Python
  install, SSL, pip, and venv probe before packaging; the `0.12.0` candidate
  must pass that matrix. Real Skill/MCP execution, custom interpreter
  execution, and coordination with affected running processes remain
  acceptance work. Six-platform release acceptance must not be claimed before
  the applicable checks pass.
- [x] **On-demand built-in MCP**: Knowledge, Magic Notes, and GoodBuddy
  configuration MCP can be enabled independently and assigned to direct
  models, GoodBuddy-managed OpenCode, and Continue. Settings explicitly marks
  DeepSeek Harness unsupported. Built-in MCP uses short-lived local authority
  for the current request, and user configuration cannot loosen Ask/Execute
  read/write boundaries.
- [x] **MCP Tools**: Explicitly enabled custom MCP can be assigned to direct
  models, GoodBuddy-managed OpenCode, Continue Agent Execute, and DeepSeek
  Harness, and loads only in Execute. Agent child processes receive only
  per-request local-loopback authority; MCP addresses, commands, and
  credentials remain in Main. Dynamic tools are still rediscovered and pass
  through existing activity and permission boundaries.
- [x] **MCP Prompts and Resource metadata**: MCP testing discovers bounded
  Prompt, parameter, and Resource metadata only when the Server declares the
  corresponding capability and does not read Resource content. Supported
  Prompts can be inserted into the chat draft for further editing. OpenCode can
  report an experimental Resource catalog; the current Continue version
  explicitly does not support Resources.
- [x] **Local knowledge bases**: Supports file, directory, and web imports,
  SQLite FTS5 retrieval, and source tracing.
- [x] **Knowledge graph**: Supports rule-based, model-based, and hybrid
  extraction plus entity, relationship, alias, and evidence maintenance.
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
  management, editing, filtering, and controlled AI comments. The left
  navigation can show the incomplete-todo count, and create, save, and comment
  results use application-wide notifications.
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
  deleted. Token usage is grouped by Runtime and model and normalizes the
  different OpenAI-compatible and Anthropic Messages cache-reporting semantics
  when showing cache hit rate. Activity is grouped by conversation and
  collapsed by default so long histories do not fill the page.
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
  incremental PRD work. See the
  [Task Center PRD](./docs/features/task-and-job/task-center-prd.md) and
  [Scheduled Task PRD](./docs/features/task-and-job/scheduled-task-prd.md).
- [x] **Memory and Smart Heartbeat**: Provides periodic review, suggested
  memories, insights, follow-up tasks, and auditable run history.
- [x] **Improved Smart Heartbeat entry and scope**: Smart Heartbeat / Heartbeat
  Plans is the sole authoritative full-configuration entry. Plans can be
  created and edited for Global or one or more selected Projects. Legacy
  single-project settings migrate without loss, and project-level memory and
  action output must explicitly target a Project in scope. Task Center and
  Settings no longer duplicate the form. Future partitioned memory remains an
  independently designed long-term direction. See the
  [Smart Heartbeat PRD](./docs/features/smart-heartbeat/prd.md).
- [ ] **General supervision** (planned): Uses a fixed supervision section to
  observe user-selected conversations, Tasks, automations, or experiments and
  provide evidence-backed comments and requests for human intervention,
  without automatically speaking, approving tools, or switching to Execute.
  See the
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

- [x] **Built-in browser for direct models**: Uses GoodBuddy's isolated
  Chromium and never controls a browser installed by the user. A separate
  master switch decides whether Execute receives the capability, with no
  per-use prompt after enablement. The Browser workbar and Agent share the same
  Conversation-owned session and serialized operation path, with Back,
  Refresh/Stop Loading, address entry, Go, Interaction, and Close actions.
  Stop Loading does not close the session, and user navigation changes the
  page the Agent sees next.
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
- [x] **In-app feedback**: About and Updates can submit problems, suggestions,
  or experience feedback with an optional email and one screenshot.
  Diagnostics are not uploaded by default; users can explicitly attach a
  bounded recent Desktop diagnostic summary. Failed submission preserves the
  draft, diagnostic choice, and request ID. Conversations, Prompts,
  credentials, file contents, paths, raw provider responses, and remote Agent
  logs are never attached.
- [x] **Private-network compatibility mode**: Enabled by default and permits
  in-app HTTP plus invalid, self-signed, or expired HTTPS certificates.
  Disabling it restores strict address and certificate validation.

### Open source, builds, and releases

- [x] **0BSD open-source license**: Original code can be freely used, copied,
  modified, distributed, and commercialized. Third-party components and
  resources retain their own licenses.
- [x] **Reproducible dependency installation and source builds**: Uses locked
  dependencies, Node.js 24, and unified test, type-check, lint, and production
  build commands.
- [x] **Six-target native release matrix**: Native runners build Windows,
  macOS, and Linux `x64` and `arm64` targets with release manifests and SHA-256
  hashes. Linux also produces AppImage, DEB, and RPM.

### Open interfaces, team collaboration, and remote execution

- [x] **Remote task delegation**: Enabled only after the user explicitly
  configures an endpoint and token, uses HTTP(S) according to the global
  private-network compatibility setting, and writes results to a persistent
  outbox.
- [ ] **Headless Runtime API** (planned): A local-first Task, event, state, and
  artifact API with scoped, expiring, rate-limited, and revocable tokens.
- [ ] **GoodBuddy Team Hub** (planned): An optional service for organizations,
  RBAC, project sharing, remote Agents, policy distribution, and tenant audit.
- [ ] **SSH Host and remote execution-space release acceptance**: Host CRUD,
  Host Key, encrypted credentials, Project UI, Workspace, OpenCode ACP v4,
  Agent-owned Prompt/gateway/transcript, read-only Ask, full-account Execute,
  cancellation, exact detached-Agent reconnection, and release-only
  dual-architecture resource verification are wired. Current Linux x64 source
  has passed a real-model and tool matrix covering detach, process exit, relay
  loss, concurrency, cancellation, provider failures, Agent restart, and
  Desktop SQLite recovery. The final `0.11.14` test-signed package again
  verified two delivered model rounds, one tool, one terminal state,
  `latest=ACK`, and no owner/journal residue. The public signing-key registry is
  provisioned. Direct control-plane source does not wait for a new
  installer-bearing package, but the current formally signed Linux x64/arm64
  artifact matrix still requires public verification, along with
  GitHub/Beijing mirror, dual-architecture, and offline GoodBuddy transfer
  release acceptance. Until these gates pass, this path must not be described
  as published or as having passed formal release acceptance.
- [ ] **Multi-cloud remote sandbox Agents** (planned): Manages dedicated Linux
  sandboxes through cloud-provider APIs and SSH Agents. Credentials remain in
  Main, and high-risk control-plane operations receive separate confirmation.

## Roadmap Principles

Planned workflows, Subagents, MCP, remote APIs, and sandbox capabilities must
not bypass existing Main Runtime, Ask/Execute, permission, cancellation,
timeout, or audit boundaries.
