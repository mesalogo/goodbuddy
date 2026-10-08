# Assistant workbar

The assistant workbar is the application-level workspace on the right side of the main window. It is not attached to one chat message. Chat, knowledge, task, and supervision pages can open it to show tasks, workspace, Runtime, terminals, browser tabs, notes, and supervision status.

## Panels and the add menu

Task Center and Workspace are always-present base panels. Use the + menu to open Runtime, Supervision, Terminal, Processes, Browser, Resources, Documents, or Notes. Terminals and browsers can have multiple instances; Notes is single-instance. Background events update badges or notifications without taking over the current panel.

An open panel shows its capability, instance, and target. When a capability is unavailable, the panel explains why and provides a configuration path instead of silently hiding it. Terminals, logs, and large results may offer right, bottom, or separate-window docking.

## Follow and pin

Panels that can bind to a target have two scope choices: follow the active context, or pin to a conversation, Task, project, Runtime, terminal, workspace, or browser session. Follow mode changes with the project or conversation. Pinned mode stays on its target. If a pinned target disappears, the panel reports that it is unavailable and offers a repair path rather than switching silently.

The active context is only a default. Opening Workspace does not expand file access, and choosing a temporary directory does not silently change project settings. GoodBuddy still validates the project, execution space, and capability before an operation.

## Execution-space boundaries

Workspace shows the current project directory or a local or remote directory that you explicitly choose. A new terminal binds to the project execution space and directory; with no project it uses the local home directory. Browser manages only GoodBuddy-controlled browser tabs, not a browser already open on your system. Processes shows processes created or managed by GoodBuddy, not every system process.

Workspace supports file previews, Git status, and bounded directory operations. A remote workspace uses the Agent on the SSH host and does not pretend that a remote path is local. Terminal input, file operations, browser activity, and Runtime execution each keep their own scope; selecting one panel does not grant another panel more access.

## A practical combination

For project work, let Task Center follow the current project and pin Supervision to one conversation. Use Workspace to inspect files and create a terminal for commands. When reviewing activity, check the project, conversation, Runtime, and local or remote label at the top of the panel. Open a Task for its complete user-facing relation; Job and Run are not separate workbar panels.
