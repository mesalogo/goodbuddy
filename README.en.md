# GoodBuddy

English | [简体中文](./README.md)

A secure, cross-platform, local-first desktop AI assistant and Agent workspace.

![GoodBuddy workspace](./docs/screenshots/workspace-overview.png)

## Highlights

- **Controlled execution**: `Ask` stays read-only; `Execute` runs only enabled tools within defined boundaries and records their activity.
- **Local-first data**: Conversations, tasks, artifacts, memory, knowledge bases, and graphs are stored in local SQLite. API keys are encrypted by the operating system.
- **Multiple runtimes**: Connect directly to models or use OpenCode, Continue, and the preview DeepSeek Harness, with cancellation, timeouts, output limits, and process cleanup.
- **Open integrations**: Supports OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, OpenAI Images, Embeddings, cross-runtime Skills and custom MCP, plus a default-off DeepSeek Harness npm plugin marketplace that users enable explicitly.
- **Knowledge workspace**: Import files, folders, and web pages, then search them with full-text, phrase, vector, and graph retrieval.
- **Work management**: Organize projects, conversations, tasks, activity, artifacts, memory, Magic Notes, and Smart Heartbeat.
- **Remote channels**: Connect WeChat ClawBot, WeCom, and DingTalk with separate remote sessions for each sender.
- **Managed SSH projects (technical preview)**: Remote support is off by default and does not affect ordinary desktop use. After enabling it, manually download the independently signed package for the Linux Host architecture under Settings > Platform Features > Remote Projects, or import/export an offline `.gbagent`. Each package contains the Agent, pinned Node, and the GoodBuddy-adapted remote OpenCode Runtime; online downloads follow the GitHub or mirror source selected under About & Updates.
- **Desktop context**: Add selected files, screenshots, application windows, clipboard content, and voice.
- **Offline speech**: Use local SenseVoice, Paraformer, and Whisper models.
- **Rich responses**: Render Markdown, LaTeX, and controlled Mermaid diagrams.

![GoodBuddy knowledge workspace](./docs/screenshots/knowledge-workspace.png)

![GoodBuddy knowledge graph](./docs/screenshots/knowledge-graph.png)

![GoodBuddy Magic Notes](./docs/screenshots/GoodBuddy_MFSGeK0NoT.gif)

![GoodBuddy Smart Heartbeat](./docs/screenshots/smart-heartbeat.png)

See [FEATURES.md](./FEATURES.md) for the detailed feature matrix and roadmap, and
the [documentation index](./docs/README.md) for product, architecture, design,
and quality documents.

## Install

Download a build from [GitHub Releases](https://github.com/mesalogo/goodbuddy/releases):

| Platform | Architectures | Formats |
| --- | --- | --- |
| Windows | `x64`, `arm64` | NSIS, portable ZIP |
| macOS | `x64`, `arm64` | DMG, ZIP |
| Linux | `x64`, `arm64` | AppImage, DEB, RPM |

Desktop installers do not contain remote Agent payloads. No Agent package is
needed for local projects; managed SSH users install one explicitly in
Settings.

Code signing and macOS notarization are not configured yet, so your operating system may display a security warning.

## Run from source

Requires Node.js 24 and npm:

```bash
git clone https://github.com/mesalogo/goodbuddy.git
cd goodbuddy
npm ci
npm run dev
```

See [BUILD.md](./BUILD.md) for build and packaging instructions.

## Privacy and security

- Model requests are sent only to services selected by the user.
- Local data stays in the operating system's application data directory by default.
- The Renderer has no access to raw Electron APIs or model credentials.
- The DeepSeek Harness plugin marketplace is off by default. After it is enabled and a third-party plugin is installed, its install scripts, initialization, and Execute tools run with the current user's permissions. Turning off the marketplace only hides its catalog and management interface; it does not disable or uninstall existing plugins. Installation requires explicit confirmation, and Ask limits only model tool calls.
- Remote delegation is disabled until the user configures an endpoint and token.
- Private-network compatibility permits in-app HTTP and non-standard HTTPS certificates. WeChat credential and media endpoints remain strictly validated.

## Contributing

Issues and pull requests are welcome. Read [AGENTS.md](./AGENTS.md) first, then run:

```bash
npm test
npm run typecheck
npm run lint
```

## License

Original GoodBuddy code is released under the [0BSD License](./LICENSE). You may use, modify, distribute, and commercialize it freely. Third-party components and resources retain their respective licenses.
