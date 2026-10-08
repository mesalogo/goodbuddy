# Remote projects

Remote projects run Workspace, terminals, and supported Runtimes on an SSH host. A remote path is never treated as local. Files, processes, network access, and model calls are bounded by the SSH account and prepared environment. The GoodBuddy Agent is not included in the desktop installer.

## Prepare an SSH host

Add a Host in remote-project settings with its address, port, user, and authentication method. Before authentication, inspect and explicitly accept the Host Key algorithm and SHA-256 fingerprint. A changed fingerprint requires a separate replacement confirmation. GoodBuddy can use the system SSH Agent or supported certificates; root and SSH Agent Forwarding are not required.

Saving a Host does not mean the environment is ready. Use the Host card to prepare or update the signed Agent and Runtime, then wait for checks. A version-match badge is only a version fact. Failed, cancelled, or disconnected preparation keeps the Host and offers retry.

## Create a project and use its space

Choose a verified Host, enter or select a bounded remote workspace directory, and choose a supported Runtime such as OpenCode or Continue. The project stores the Host ID, remote path, and Runtime choice. Switching projects changes local selection only; the Agent is attached when Workspace or Runtime is first used.

Remote Workspace provides bounded directories, previews, Git, and import. A terminal uses the remote shell. Operations use the SSH account permissions. Local Skills, stdio MCP servers, and tool environments are not uploaded automatically; remote capabilities are those reported by the Agent.

## Failures and boundaries

Check network, port, Host Key, credentials, directory permissions, Agent version, Runtime version, and project permissions separately. If the Agent is unavailable, GoodBuddy does not fall back to an SSH stdio Runtime or secretly run the request locally.

An SSH relay disconnect does not necessarily stop an accepted request. Reconnect restores only output recorded and confirmed by the Agent. An uncertain model call is not replayed automatically because it could duplicate cost or side effects. Stop, Agent shutdown, and remote process failure are shown as cancellation, failure, or unknown outcome.
