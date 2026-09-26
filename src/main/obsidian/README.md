# Obsidian Service

Construct `ObsidianService` from `./obsidian` with:

```ts
const obsidian = new ObsidianService({
  appPath: app.getAppPath(),
  launchEnvironmentProvider: localToolEnvironmentService.launchEnvironmentProvider
})
```

Optional `homePath`, `platform`, and `environment` overrides support isolated tests.
The provider is read on every launch. Its prepared PATH selects the managed `node`
shim, including Electron-as-Node; the service never invokes npm or npx.

## API

- `listVaults(settings): Promise<ObsidianVault[]>` returns `{ id, name, path }`.
- `testConnection(settings): Promise<{ vaults: ObsidianVault[]; toolCount: number }>`
  opens each vault and lists its tools without writing. `toolCount` is the count
  of unique upstream tool names, not the count multiplied by the number of vaults.
- `listTools(settings): Promise<Tool[]>` returns the complete upstream schemas
  from the first vault. The gateway can wrap each tool with `vaultId`.
- `callTool(settings, { vaultId?, name, arguments }, signal?): Promise<CallToolResult>`
  forwards the request unchanged. Omitting `vaultId` requires exactly one vault.

Settings accept `{ vaultPath?: string }`. A nonempty explicit absolute folder
bypasses discovery and receives a SHA-256 path ID. Empty settings discover all
registered vaults, retaining their registry IDs, regardless of their `open` flag.
Discovery reads `obsidian/obsidian.json` beneath `%APPDATA%` on Windows,
`~/Library/Application Support` on macOS, or `$XDG_CONFIG_HOME` (default
`~/.config`) on Linux. Missing registries, empty registries, invalid folders, and
unknown IDs produce explicit errors. Ordinary folders are accepted, as upstream
does not require an `.obsidian` directory.

Each operation creates and closes its own stdio client. Cancellation reaches both
initialization and tool requests, and cleanup is awaited even when the SDK also
initiates cleanup. No read-only option or tool filtering is added.

## Packaging

`@bitbonsai/mcpvault` is pinned to `0.16.0` as a build dependency. The Electron Vite
main build copies its production dependency closure to
`out/main/obsidian-mcpvault/node_modules`, preserving package-relative assets and
all included license files. Electron Builder unpacks that directory; the service
maps `app.asar` to `app.asar.unpacked` before launching the upstream `dist/server.js`.
This preserves `trash`'s Windows and macOS binaries and Linux implementation.
Runtime installation and network access are unnecessary.

`obsidian-service.test.ts` copies the same production package to an isolated
temporary app directory, launches it via a managed Node shim, and exercises
registry discovery, every advertised schema, connection probes, note read/write,
patches, frontmatter changes, listing, local-trash deletion, and cancellation.
These tests never discover or modify the user's real vaults. Cross-platform
discovery is tested with fixtures; native runtime execution follows the host OS.
