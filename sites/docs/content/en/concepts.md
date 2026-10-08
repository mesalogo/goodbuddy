# Core concepts

GoodBuddy connects conversations, model requests, and file work through a small set of related objects. Knowing these objects makes Runtime selection, knowledge scope, and execution history easier to understand.

## Projects and conversations

A Project is a working scope with a project directory, project Runtime choice, conversations, and tasks. A Conversation is a continuing chat record containing messages, tool activity, and citations. A conversation may have no Task or several Tasks; linking a Task does not change the conversation type.

## Model connections and Runtimes

A model connection is a reusable service configuration with a URL, protocol, model name, and credentials. A Runtime is the way a request runs: Direct models are called by GoodBuddy, while OpenCode and Continue use their native agent clients and DeepSeek Harness uses GoodBuddy's compatible managed path. See [Choose a Runtime](./runtimes.html).

A Runtime uses the selected capabilities and current account permissions. A project can define the default choice, and a conversation can inherit it or select its own. If a connection is deleted or incompatible, the picker explains the fallback or failure instead of silently choosing another credentialed model.

## Capabilities and execution spaces

A capability is something a request may use, such as knowledge retrieval, workspace files, a terminal, a browser, or an MCP service. Availability depends on the Runtime, project settings, conversation scope, and execution space. An execution space is where files, terminals, managed processes, and the Runtime actually run: a local project directory or a remote SSH project directory.

## Task, Job, and Run

A Task is work that the user explicitly creates or confirms, and it has exactly one associated Conversation. A Job is an internal step or scheduled occurrence within a Task. A Run is one execution attempt and record for a Job or subjob. Ordinary chat requests, tool calls, and Runs do not become Tasks automatically. The UI primarily exposes Tasks; Job and Run details appear through activity and execution records when available.

## No Ask / Execute mode

GoodBuddy has no Ask / Execute work mode and does not require a mode switch before using an enabled capability. A normal request uses the selected Runtime, enabled capabilities, and current account permissions. If a Runtime lacks a capability, GoodBuddy reports that limitation. Summaries, note analysis, and supervision reviews remain dedicated text requests without tools.
