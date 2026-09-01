<div align="center">
  <img src="./sites/assets/goodbuddy-light.png" width="96" alt="GoodBuddy" />

# GoodBuddy

**Desktop access to model chat, coding agents, knowledge, and scheduled work**

**English** | [简体中文](./README.zh-CN.md)

[Website](https://mesalogo.github.io/goodbuddy/en.html) ·
[Download](https://github.com/mesalogo/goodbuddy/releases) ·
[Feature Matrix](./FEATURES.md) ·
[Build Guide](./BUILD.md)

[![Release](https://img.shields.io/github/v/release/mesalogo/goodbuddy?label=release)](https://github.com/mesalogo/goodbuddy/releases)
[![License: 0BSD](https://img.shields.io/badge/license-0BSD-blue.svg)](./LICENSE)
[![Windows](https://img.shields.io/badge/Windows-x64%20%7C%20arm64-0078D4)](https://github.com/mesalogo/goodbuddy/releases)
[![macOS](https://img.shields.io/badge/macOS-x64%20%7C%20arm64-000000)](https://github.com/mesalogo/goodbuddy/releases)
[![Linux](https://img.shields.io/badge/Linux-x64%20%7C%20arm64-FCC624)](https://github.com/mesalogo/goodbuddy/releases)
</div>

![GoodBuddy workspace](./docs/screenshots/workspace-overview.png)

GoodBuddy is a desktop application for model chat, coding agents, knowledge
retrieval, notes, and scheduled tasks. No GoodBuddy account is required.
Workspace data is stored locally by default. Model endpoints can run on the
same device, on a private network, or at a provider selected by the user.

## Capabilities

| Area | Available in GoodBuddy |
| --- | --- |
| Agent Runtimes | Direct model connections, OpenCode, Continue, and the preview DeepSeek Harness |
| Data and execution | Local SQLite storage, read-only `Ask`, full-account `Execute`, and recorded tool activity |
| Knowledge | File, folder, and web imports with full-text, Chinese phrase, vector, and knowledge graph retrieval |
| Desktop releases | Windows, macOS, and Linux builds for `x64` and `arm64` |
| Integrations | Local or hosted model endpoints, custom MCP servers, WeChat ClawBot, WeCom, and DingTalk |

## Product tour

### Knowledge bases and graphs

![GoodBuddy knowledge workspace](./docs/screenshots/knowledge-workspace.png)

![GoodBuddy knowledge graph](./docs/screenshots/knowledge-graph.png)

### Magic Notes and Smart Heartbeat

![GoodBuddy Magic Notes](./docs/screenshots/GoodBuddy_MFSGeK0NoT.gif)

![GoodBuddy Smart Heartbeat](./docs/screenshots/smart-heartbeat.png)

## Agent Runtimes

| Runtime | Functions | Configuration |
| --- | --- | --- |
| Direct models | Chat, retrieval, image generation, and built-in tools | GoodBuddy model connections |
| OpenCode | Coding agents, native commands, tools, and skills | GoodBuddy-managed or native OpenCode configuration |
| Continue | Rules, prompt presets, and coding tasks | GoodBuddy-managed or native Continue configuration |
| DeepSeek Harness (preview) | A fixed host with optional plugin capabilities | GoodBuddy-managed OpenAI-compatible connection |

Each run reports cancellation, timeouts, token usage, tool calls, and history.
Runtime-specific capabilities and configuration remain separate.

## Download

Download a build from
[GitHub Releases](https://github.com/mesalogo/goodbuddy/releases):

| Platform | Architectures | Formats |
| --- | --- | --- |
| Windows | `x64`, `arm64` | NSIS, portable ZIP |
| macOS | `x64`, `arm64` | DMG, ZIP |
| Linux | `x64`, `arm64` | AppImage, DEB, RPM |

Desktop installers do not contain remote Agent payloads. Local projects do not
need an Agent package; managed SSH users download or import one explicitly in
Settings.

Code signing and macOS notarization are not configured yet, so the operating
system may display a security warning.

## Run from source

Requires Node.js 24 and npm:

```bash
git clone https://github.com/mesalogo/goodbuddy.git
cd goodbuddy
npm ci
npm run dev
```

See [BUILD.md](./BUILD.md) for build and packaging instructions.

## Documentation

- [Feature matrix and roadmap](./FEATURES.md)
- [Product feature documentation](./docs/features/)
- [UI design system](./UI-DESIGN.md)
- [Build and packaging](./BUILD.md)
- [Release runbook](./docs/development/release-runbook.md)

## Privacy and execution boundaries

- Model requests are sent only to services selected by the user.
- Local data stays in the operating system's application data directory by
  default. API keys are encrypted by secure system storage.
- The Renderer has no access to raw Electron APIs or model credentials.
- The DeepSeek Harness plugin marketplace is off by default. Third-party
  install scripts, initialization code, and Execute tools run with the current
  user's permissions.
- Remote delegation is enabled only after the user configures an endpoint and
  token.
- Private-network compatibility permits in-app HTTP and non-standard HTTPS
  certificates. WeChat credential and media endpoints remain strictly
  validated.

## Contributing

Issues and pull requests are welcome. Read [AGENTS.md](./AGENTS.md) first, then
run:

```bash
npm test
npm run typecheck
npm run lint
```

## License

Original GoodBuddy code is released under the [0BSD License](./LICENSE). You may
use, modify, distribute, and commercialize it freely. Third-party components
and resources retain their respective licenses.
