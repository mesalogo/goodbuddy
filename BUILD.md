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

OpenCode/Continue 用例默认读取 `dist/harness-package-probe/win-unpacked`；也可用
`GOODBUDDY_E2E_PACKAGED_ROOT` 指定其他已解包应用目录。该测试可能发起真实外部模型
调用。测试不会输出 API Key，文件操作在临时工作区中执行。文件包含经 Main 回环
broker 调用已分配自定义 MCP 的真实 OpenCode 和 Continue 用例。

## 生产构建

生成 Electron Main、Preload 和 Renderer 生产文件：

```bash
npm run build
```

中间构建输出位于 `out`。该目录为生成内容，应修改源文件后重新构建，不要直接编辑。

## 图标生成

应用图标源文件位于 `icons`。修改源图或图标处理逻辑后运行：

```bash
npm run icons
```

脚本会精确裁出亮色和深色圆角卡片，清理圆角外侧背景并使用适合主题的
边缘颜色生成透明抗锯齿，避免缩放后出现白边。它会统一更新 `build` 中的
PNG / ICO、Renderer 图标，以及官网使用的亮色和深色品牌图标。任务栏和
托盘图标保持透明背景。

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

发布包会携带经过版本与完整性校验的 OpenCode、Continue 和 DSH 插件安装 Runtime：

- OpenCode 平台二进制来自 `.runtime-resources/<arch>`。
- Continue Runtime 来自锁定版本的 `@continuedev/cli`。
- DSH 插件安装使用精确锁定并从 `app.asar` 解包的 npm CLI，通过当前 Electron 的 Node 模式运行；最终用户不需要另装 Node.js 或 npm。
- DSH 图片输入使用精确锁定的 `@napi-rs/canvas` 完整解码 JPEG/PNG。通用包与目标平台、目标架构的 Skia 原生包必须从 `app.asar` 解包；当打包 Runner 的架构与目标架构不同时，发布脚本会根据 lockfile 的精确版本、下载地址和 integrity 临时暂存目标原生包，完成后清理。发布校验会检查版本、目标架构和 MIT 许可证。
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
manifests、总 `release-manifest.json` 和 `SHA256SUMS`。随后工作流通过
GitHub OIDC 获取短期 STS 凭据，将发布资产和 `site-release.json` 上传到
北京 OSS 的不可变版本目录，并公开校验 12 个安装包。验证通过后才创建或
更新 draft GitHub Release、上传 20 个 Release 资产并正式发布，最后原子
切换官网 `latest.json`。任一步失败都不会提前切换官网最新版本。

同一标签重跑时，工作流会根据 `resources/release-notes.json` 重新生成并
覆盖 GitHub Release 正文，以 `--clobber` 更新已知发布资产，同时保留未知
附件。若源码与发布元数据未变化，应修正外部配置后重跑同一不可变标签；
只有必须修改代码或元数据时才递增版本并创建新标签。

中英文发布说明统一维护在 `resources/release-notes.json`。新版本按“本次
亮点 / Highlights”“功能更新 / Features”“问题修复 / Bug Fixes”“使用前
请留意 / Before You Start”四段组织，应用首次启动弹窗与 GitHub Release
正文共用该来源。旧版两段式记录会兼容读取，无需改写。提交发布候选前运行
`npm run release:notes:verify` 校验版本、双语条目数量并生成 Markdown。

发布标签必须与 `package.json` 版本完全一致。实际推送标签和触发发布前仍
需人工确认，例如当前版本应使用：

```bash
tag="v$(node -p "require('./package.json').version")"
git tag -a "$tag" -m "GoodBuddy $(node -p "require('./package.json').version")"
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
7. DeepSeek Harness Ask 拒绝写入和第三方插件工具，可调用 Main 管理的 Web Search/Fetch；Execute 可调用已启用插件工具。文本模型在网络调用前拒绝图片，声明图片能力的模型可以实际接收 JPEG/PNG。
8. OpenCode Agent/Command、原生上下文 Compact，以及 Continue Rules/Prompt 预设、结构化提问和 GoodBuddy 手动摘要压缩。
9. Runtime 原生清单把 Tools 与 Commands/LSP/Formatters 分开，显示来源及 Ask/Execute 可用性，不混入 GoodBuddy 分配的 Skills/MCP；外部 OpenCode 只报告连接状态，Continue 明确标记原生 Tools 静态发现不支持；内置 MCP 的启停与 Runtime 分配会持久化并限制后续请求，DeepSeek Harness 保持不可分配；MCP 测试只读取有界 Prompt/Resource 元数据，不读取 Resource 内容。
10. DSH 市场可安装、停用、重新启用和移除插件；启动失败插件不会阻止 Host，并显示为自动停用。
11. 智能心跳的创建、暂停、恢复和历史记录。
12. 应用退出后无残留 Runtime 子进程。

DeepSeek Harness 的 Electron Utility Host 可单独执行无模型、无凭据冒烟测试：

```bash
npm run smoke:deepseek-harness
```

该命令先生成 production bundle，再从 CommonJS Electron 主入口启动实际
`utilityProcess`，等待固定 Host 完成本地主机执行器初始化与内部 ready 握手。它不会发起
模型请求，也不会读取或传递 API Key。

Windows x64 完整打包后的 Utility Host 与内置 npm 冒烟测试：

```bash
npm run build
node node_modules/electron-builder/cli.js --win dir --x64 --publish never --config.directories.output=dist/harness-package-probe
npm run smoke:deepseek-harness:packaged
```

该测试启动打包后的 Host，并使用打包资源中的准确 npm 版本安装一个本地临时包，
确认 npm 依赖闭包、Electron Node 模式、`node` shim 和生命周期脚本都可用。它不访问
npm registry，也不运行模型请求。

真实 DSH 市场测试会访问公共 npm、运行第三方安装与插件代码，因此只在已明确授权时启用：

```bash
GOODBUDDY_DSH_MARKETPLACE_E2E=1 npm test -- src/main/agent/dsh-extension-marketplace.e2e.test.ts
```

该测试使用临时用户目录，经捆绑 npm 路径安装已审查的最小测试插件，并验证 Host
加载和真实工具调用；测试结束后删除临时目录。

要让真实模型同时验证插件的 Ask 拒绝与 Execute 调用，可显式提供兼容的
OpenAI Chat Completions 配置：

```bash
GOODBUDDY_DSH_MODEL_E2E=1 \
GOODBUDDY_DSH_API_KEY=... \
GOODBUDDY_DSH_BASE_URL=https://api.deepseek.com \
GOODBUDDY_DSH_MODEL=deepseek-chat \
npm test -- src/main/agent/deepseek-harness-acp-e2e.test.ts -t "rejects a real npm plugin"
```

如需覆盖发布包内置 npm 路径，再设置 `GOODBUDDY_DSH_NPM_CLI` 与
`GOODBUDDY_DSH_NODE_EXECUTABLE` 指向已解包应用中的 npm CLI 和应用主程序。
