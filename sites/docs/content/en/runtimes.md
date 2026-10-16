# Choose a Runtime

A Runtime selects the execution path for a request. A connection answers which model service to call, while the Runtime organizes the request, tools, and execution space. Each request retains visible status, tool activity, cancellation, and failure information.

## The five choices

| Runtime | Best for | Model configuration |
| --- | --- | --- |
| Direct models | Chat, retrieval, image generation, and GoodBuddy capabilities | GoodBuddy model connections |
| OpenCode | Coding agents, files, commands, and Skills | GoodBuddy connection or OpenCode config |
| Continue | Rules, prompt presets, and coding work | GoodBuddy connection or Continue config |
| DeepSeek Harness | A fixed host and compatible plugin capabilities | GoodBuddy-managed compatible connection |
| Factory Droid (planned) | Factory Droid ACP, local or in-network models, and airgapped coding | BYOK custom model in Droid `settings.json` |

Use Direct models for ordinary questions and retrieval. Choose OpenCode or Continue for continuing project-file and command work. Choose DeepSeek Harness when its fixed host capabilities fit. Factory Droid is currently in design and is planned as a local ACP subprocess Runtime for BYOK and Airgap use. Tools and native questions differ by Runtime. See [Factory Droid Airgap Runtime design](https://github.com/mesalogo/goodbuddy/blob/main/docs/features/factory-droid-airgap/README.md).

## Selection and capabilities

A project selects a concrete Runtime. A conversation follows the project by default, while the composer can select its own choice. The picker shows defaults, individual connections, and Runtime-owned configuration with their source. Requests use the Runtime, enabled capabilities, knowledge scope, execution space, and current account permissions.

GoodBuddy has no Ask / Execute mode and no separate general tool-approval switch. Unsupported capabilities are reported clearly. Local Runtimes run locally; remote projects use the Agent and managed Runtime on the SSH host. The Agent is not bundled with the desktop app; see [Remote projects](./remote.html).

The workbar shows Runtime, connection, tool state, cancellation, errors, and saved results. Closing a panel does not cancel background work, and stopping a request affects that request only.
