# GoodBuddy 开发与构建

## 环境要求

- Node.js 24，或当前锁定依赖明确支持的 Node.js 版本
- npm
- Windows、Linux 或 macOS

安装锁定依赖：

```bash
npm ci
```

不要将 API Key、访问令牌、私有模型地址或本地数据库提交到仓库。

## 本地开发

启动开发环境：

```bash
npm run dev
```

预览已经生成的生产构建：

```bash
npm run build
npm start
```

## 质量验证

提交或打包前运行：

```bash
npm test
npm run typecheck
npm run lint
```

监听模式：

```bash
npm run test:watch
```

真实 Runtime 端到端测试默认关闭。配置兼容模型凭据后，显式启用：

```bash
GOODBUDDY_RUN_RUNTIME_E2E=1 npm test -- src/main/agent/runtime-e2e.manual.test.ts
```

该测试可能发起真实外部模型调用。测试不会输出 API Key，文件操作在临时工作区中执行。

## 生产构建

生成 Electron Main、Preload 和 Renderer 生产文件：

```bash
npm run build
```

中间构建输出位于 `out`。该目录为生成内容，应修改源文件后重新构建，不要直接编辑。

## 平台打包

### 当前平台默认包

```bash
npm run dist
```

### Windows

生成 Windows NSIS 安装包：

```bash
npm run dist:win
```

生成用于本机调试的 Windows 便携目录：

```bash
npm run portable
```

### macOS

生成 `x64` 和 `arm64` DMG：

```bash
npm run dist:mac
```

### Linux

同时生成 Linux `x64` 和 `arm64` 包：

```bash
npm run dist:linux
```

只生成指定架构：

```bash
npm run dist:linux:x64
npm run dist:linux:arm64
```

每个 Linux 架构生成：

- `deb`：适用于麒麟、统信 UOS 等 Debian 系桌面。
- AppImage：适用于免安装验证和便携运行。

打包产物位于 `dist`。

## Runtime 资源

发布包会携带经过版本与完整性校验的 OpenCode 和 Continue Runtime：

- OpenCode 平台二进制来自 `.runtime-resources/<arch>`。
- Continue Runtime 来自锁定版本的 `@continuedev/cli`。
- 打包钩子位于 `build/runtime-hooks.cjs`。

跨架构打包前，确认目标架构的 OpenCode 资源已经准备完成。不要用其他架构的二进制替代目标资源。

## 跨平台 CI 与 GitHub Release

`.github/workflows/packages.yml` 是统一发布工作流。它先验证并生成一次
`out` 生产 bundle，再在六个原生 Runner 上分别打包 Windows、macOS 和
Linux 的 `x64`、`arm64` 版本。生产 bundle 仅作为短期 Actions artifact
供打包任务复用，不会上传到 GitHub Release。

本地构建单个平台目标：

```bash
npm run release:package -- --platform <windows|macos|linux> --arch <x64|arm64>
```

默认发布产物为 Windows 的 NSIS 安装包与 portable ZIP、macOS 的 DMG 与
ZIP，以及 Linux 的 AppImage 与 DEB。Windows portable ZIP 解压后可直接
运行 `GoodBuddy.exe`，并包含启用便携数据目录的
`.goodbuddy-portable.json`。每个目标目录都包含带文件大小和 SHA-256 的
`release-manifest.json`。

推送 `main` 时只运行源码验证和 production bundle 构建，不运行六平台
打包矩阵，避免随后推送版本标签时对同一提交重复完整打包。手动触发会运行
验证和六平台打包，并保留 30 天 Actions artifacts，但不会创建 Release。

推送 `v${package.version}` 标签时，工作流运行验证和六平台打包。只有在
全部目标成功后，才会严格校验并聚合所有平台产物，生成按平台重命名的
manifests、总 `release-manifest.json` 和 `SHA256SUMS`。随后工作流创建或
更新 draft GitHub Release，上传全部资产成功后才发布。重跑会保留人工
编辑的 Release notes 和未知附件。

发布标签必须与 `package.json` 版本完全一致。实际推送标签和触发发布前仍
需人工确认，例如当前版本应使用：

```bash
tag="v$(node -p "require('./package.json').version")"
git tag "$tag"
git push origin "$tag"
git push github "$tag"
```

当前未配置 Windows/macOS 代码签名或 macOS notarization。对外分发前应按
目标平台配置签名凭据并重新验证安装、升级和系统安全提示。

## 发布前冒烟测试

建议在每个目标系统上至少验证：

1. 安装、启动、升级和卸载。
2. 中文输入法、窗口缩放和高分屏显示。
3. 系统密钥环和模型连接。
4. 本地知识库导入、检索和知识图谱。
5. Ask、Execute 的权限边界与旧版 Plan 数据兼容。
6. OpenCode 与 Continue 的权限边界、取消和超时。
7. 智能心跳的创建、暂停、恢复和历史记录。
8. 应用退出后无残留 Runtime 子进程。
