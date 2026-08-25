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
- `rpm`：适用于 Fedora、RHEL、Rocky Linux、openEuler 等 RPM 系桌面。
- AppImage：适用于免安装验证和便携运行。

打包产物位于 `dist`。

以上 `dist*` 与 `portable` 命令用于普通本地桌面打包。它们会携带
`agent-runtime-lock.json`、`remote-runtime-lock.json` 与公开的
`agent-release-keys.json`，但所有桌面构建路径（包括本地 `portable`）都不会嵌入
可安装的远端 Agent 或远端 Runtime payload。没有使用托管 SSH 时，无需下载任何额外
组件，缺少远端包也不能阻塞普通桌面打包或发布。

“设置 > 平台功能 > 远程项目（技术预览）”列出用户数据目录中已经下载或导入的
Linux x64/arm64 复合 Agent 包，并分别显示 `已下载并验证 / 未下载 / 校验失败`。
在线“下载/检查并更新”必须由用户显式触发，来源跟随“关于与更新”的 `github` 或
`mirror` 选择；打开远程项目不会自动下载。用户也可导入或导出 `.gbagent` 离线包。
Main 在写入缓存前校验签名目录、目录签名、大小、SHA-256、桌面最低版本、Agent 协议、
内部 Agent/Runtime 签名和完整 payload。缓存位于 Electron `userData` 下的
`remote-components/agent-packages`，不暴露给 Renderer。

“SSH 主机 > 远程运行环境”的“更新版本”只使用已验证的本地复合包。对应 Host 架构
尚未下载时会提示先到设置下载或导入，不会联网，也不会影响本地项目、普通桌面功能或
其他架构的 Agent 包。

## Runtime 资源

桌面包会携带经过版本与完整性校验的 OpenCode、Continue 和 DSH 插件安装 Runtime：

- OpenCode 平台二进制来自 `.runtime-resources/<arch>`。
- Continue Runtime 来自锁定版本的 `@continuedev/cli`。
- DSH 插件安装使用精确锁定并从 `app.asar` 解包的 npm CLI，通过当前 Electron 的 Node 模式运行；最终用户不需要另装 Node.js 或 npm。
- DSH 图片输入使用精确锁定的 `@napi-rs/canvas` 完整解码 JPEG/PNG。通用包与目标平台、目标架构的 Skia 原生包必须从 `app.asar` 解包；当打包 Runner 的架构与目标架构不同时，发布脚本会根据 lockfile 的精确版本、下载地址和 integrity 临时暂存目标原生包，完成后清理。发布校验会检查版本、目标架构和 MIT 许可证。
- 打包钩子位于 `build/runtime-hooks.cjs`。

跨架构打包前，确认目标架构的 OpenCode 资源已经准备完成。不要用其他架构的二进制替代目标资源。

## GoodBuddy Agent 工件

面向用户发布的是按远端 Host 架构区分的复合 `.gbagent`，每个包同时包含签名
Agent、固定 Node 和当前桌面源码维护并适配的签名 OpenCode Runtime。Runtime 不建立
独立的用户版本流。生产构建命令为：

```bash
node build/agent-package.cjs build \
  --arch <x64|arm64> \
  --minimum-desktop-version <desktop-version> \
  --node-archive <locked-node-runtime.tar.gz> \
  --runtime-archive <locked-opencode-package.tgz> \
  --output goodbuddy-agent-<agent-version>-linux-<arch>.gbagent
```

底层 `agent:build/import/verify` 与 `remote-runtime:build/import/verify` 命令继续用于
开发、签名和复合包组装验证；其 `.agent-resources` 与
`.remote-runtime-resources` 输出都是不提交的生成内容，也不会被任何桌面打包命令发现
或嵌入。

### Agent 原生 CI 策略

Agent 源码、共享协议、lock、bundle 工具和测试与桌面应用保持在同一仓库、同一 commit；
不维护长期分叉的 Agent 源码分支。`.github/workflows/agents.yml` 在相关 Pull Request、
`main` push 和手工触发时，分别使用 `ubuntu-24.04` 与 `ubuntu-24.04-arm` 原生构建
Linux x64/arm64 复合包。每个 job 从 `agent-runtime-lock.json` 解析官方 Node HTTPS
地址与 digest，并从 `remote-runtime-lock.json` 解析固定 OpenCode npm 包与 integrity；
下载后再次校验，随后使用仅存在于进程内的临时 Ed25519 测试 key 构建两次，完成内外层
测试签名验证、Agent 原生启动 smoke 和确定性 `.gbagent` 对比。

该验证 workflow 不读取 production signing secret，不修改公开 key registry，也不上传
可安装 Agent 工件。`.github/workflows/agent-release.yml` 是唯一 production Agent
发布路径：只接受指向受保护 `main` 历史的 annotated
`agent-v${agent-runtime-lock.agentVersion}` 标签，在 `agent-signing` Environment 中
原生构建两种架构，生成并签名累计目录，然后同步到非 Latest 的 GitHub Agent Release
与北京 OSS。该 Environment 只保护一组 GoodBuddy 通用发布变量与 Secret：

- `GOODBUDDY_SIGNING_KEY_ID` /
  `GOODBUDDY_SIGNING_PRIVATE_KEY`

该 GoodBuddy 身份统一签署内部 Agent、固定 Runtime manifest、外层 `.gbagent`
描述符和累计目录，各层通过既有签名域区分用途，不再要求内部 Runtime 单独配置生产
身份。私钥只注入签名步骤；预检只读取 key ID 并确认公钥已在
`resources/agent-release-keys.json` 注册为 production 且未撤销。

累计目录使用 `agent-catalog.json` 与 `agent-catalog.sig`。每个条目绑定 Agent 版本、
最低桌面版本、Agent 协议、远端 OpenCode 版本/digest、架构、文件名、大小、SHA-256
以及固定 GitHub/OSS URL。同一版本和架构的字节不可改变；目录最多保留 200 个条目。
OSS 先写 `agent-releases/v<version>/` 不可变对象，GitHub Release 公开且验证后才更新
单一 `agent-releases/latest.json` 指针。该指针只引用同一不可变版本目录中的
`agent-catalog.json` 与 `agent-catalog.sig`，避免客户端观察到跨版本组合。Agent Release 必须使用
`--latest=false`，不得改变桌面 Release 的 Latest 标记。

### 远程 OpenCode Runtime 基础

`remote-runtime-lock.json` 独立锁定首个远程 Runtime：OpenCode 1.18.9 的 Linux x64
baseline 与 arm64 官方包 integrity、`bin/opencode` 入口和固定 `acp` 参数。它不同于
`agent-runtime-lock.json`，后者锁定 Agent 自带 Node 以及用于 Linux `SO_PEERCRED`
的 Koffi 版本。Agent bundle 将 Koffi loader 作为 external module，并只携带目标
Linux 架构的 glibc/musl 原生 binding；构建与导入都会校验其 ELF 架构和 MIT 许可证。

远程 Runtime 工件由以下命令独立管理：

```bash
# 在对应 Linux 原生 Runner 上从 lock 指定的 npm 归档构建并签名
npm run remote-runtime:build -- --arch <x64|arm64> \
  --runtime-archive <locked-opencode-package.tgz>

# 为复合 Agent 包组装导入并完整验证签名归档
npm run remote-runtime:import -- --arch x64 --archive <runtime-x64.tar>
npm run remote-runtime:import -- --arch arm64 --archive <runtime-arm64.tar>
```

默认生成目录为 `.remote-runtime-resources/linux-<arch>/opencode/<digest>`，
不提交到仓库。生产 workflow 从 `remote-runtime-lock.json` 解析固定包名、版本和
integrity，以 `--ignore-scripts` 从官方 npm registry 获取归档；bundle 工具在签名前
再次验证归档 SHA-512、包名、版本和 ELF 架构。

源码已经实现 Runtime bundle build/import/verify、Daemon 侧
manifest/Ed25519/payload/ELF/lock 校验、digest registry、ACP v3、直接进程 ownership、
Ask 的固定 `bwrap` 只读 profile 和 `runtime/model-bridge` v1。Agent 通过私有 Unix socket
按需 detached 启动，不依赖 systemd、D-Bus 或 Linger。Execute 直接以所选 SSH 账号权限
启动签名 Runtime；Ask 才使用只读 bubblewrap。

OpenCode 通过已签名 Agent helper 和每次 Prompt 的私有 Unix socket 使用 Main-only 模型
网关；Provider URL、API Key 和真实 Provider 认证头不进入远端。helper 的 loopback
HTTP 入口使用每个进程随机生成的路径 capability，Anthropic/OpenAI SDK 需要的固定非秘密
本地兼容标记由 helper 核对后丢弃。GoodBuddy 自己维护会话标题，所以生成的 OpenCode
配置必须禁用 title Agent；工具循环只使用 build Agent 的模型轮次。

Ask 模式的 ACP 权限中介只可为原生 `read` 选择 `allow_once`；其他工具种类和
`allow_always` 请求必须拒绝，Workspace 的真正只读边界仍由 `bwrap` 执行。Unix 模型桥
broker 必须按 socket 当前已缓冲字节增量读取长度帧，不能等待 `read(remaining)` 一次返回
完整大响应。Agent 传输或权限实现变化后，除了普通测试，还要在原生 Linux 上运行包含
至少 256 KiB 响应的模型桥回归。

`agent-runtime-lock.json` 维护独立于桌面应用的 Agent 版本，
`remote-runtime-lock.json` 维护 OpenCode Runtime 版本。Agent 内容变化时必须更新
`agentVersion`；Runtime 更新时使用 Runtime 自身版本。签名 manifest 或 bundle digest
唯一标识对应版本的精确工件。变更后必须重新构建、签名并导入 Linux x64/arm64 两套工件；
旧版本或旧 digest 会按设计校验失败。不要手工把本机 `.runtime-resources` 当作远程 bundle。

桌面应用更新后不会在项目激活时自动下载 Agent。用户先在设置中显式下载“最新兼容”
版本或导入离线包；随后打开托管 SSH 项目时，Main 才使用该 Host 架构的本地验证包执行
完整激活。所需版本健康且项目事务提交成功后才刷新项目绑定；失败不会覆盖旧安装或把
未提交的新 identity 暴露给 Workspace/Runtime。

用户也可在 SSH Host 的远程运行环境卡片显式选择“更新版本”。该路径按 Agent、
OpenCode Runtime 顺序使用对应架构的本地复合包，支持阶段进度和取消；成功后使引用该 Host
的项目重新验证。验收应覆盖激活与此手动入口，并确认失败或取消不会删除
Host 配置、凭据、项目设置、Workspace 文件或仍可用的旧安装。

## 跨平台 CI 与 GitHub Release

`.github/workflows/packages.yml` 是统一发布工作流。它先验证并生成一次
`out` 生产 bundle，再在六个原生 Runner 上分别打包 Windows、macOS 和
Linux 的 `x64`、`arm64` 版本。生产 bundle 仅作为短期 Actions artifact
供打包任务复用，不会上传到 GitHub Release。该工作流不构建、下载、签名或嵌入
远端 Agent/OpenCode 复合包，也不依赖 `agent-signing` Environment；远端包缺失或
Agent 发布失败不会阻塞任何桌面目标。

本地构建单个平台目标：

```bash
npm run release:package -- --platform <windows|macos|linux> --arch <x64|arm64>
```

`release:package` 仅构建桌面产品。基础配置统一携带
`agent-release-keys.json`、`agent-runtime-lock.json` 与 `remote-runtime-lock.json`
供 Main 校验独立下载的复合包，但 release 配置不增加 `.agent-resources` 或
`.remote-runtime-resources`。发布校验继续检查桌面自身的 OpenCode、Continue 与
DeepSeek Harness Runtime、`app.asar`、目标架构和安装包签名。

在 macOS 上明确生成未签名、未公证的开发验证包：

```bash
npm run release:package -- --platform macos --arch <x64|arm64> --unsigned
```

默认发布产物为 Windows 的 NSIS 安装包与 portable ZIP、macOS 的 DMG 与
ZIP，以及 Linux 的 AppImage、DEB 与 RPM。Linux 原生 Runner 必须安装
`rpm`/`rpmbuild` 工具后再调用 electron-builder。Windows portable ZIP 解压后可直接
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
北京 OSS 的不可变版本目录，并公开校验 14 个安装包。验证通过后才创建或
更新 draft GitHub Release、上传 22 个 Release 资产并正式发布，最后原子
切换官网 `latest.json`。任一步失败都不会提前切换官网最新版本。

同一标签重跑时，工作流会根据 `resources/release-notes.json` 重新生成并
覆盖 GitHub Release 正文，以 `--clobber` 更新已知发布资产，同时保留未知
附件。若源码与发布元数据未变化，应修正外部配置后重跑同一不可变标签；
只有必须修改代码或元数据时才递增版本并创建新标签。

Agent 发布使用另一套标签和 workflow：

```bash
agent_tag="agent-v$(node -p "require('./agent-runtime-lock.json').agentVersion")"
git tag -a "$agent_tag" -m "GoodBuddy Agent $(node -p "require('./agent-runtime-lock.json').agentVersion")"
```

实际创建或推送前同样必须获得用户确认。`.github/workflows/agent-release.yml`
原生构建两个 `.gbagent`、签名累计目录、上传
`agent-releases/v<agent-version>/`，创建 `--latest=false` GitHub Release，再切换
OSS 签名目录指针。生产发布需要 `agent-signing` 与 `aliyun-oss-release` 两个受保护
Environment；普通分支/PR 的 `agents.yml` 不使用其中任何 Secret。

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

macOS 发布 job 会先原子判断 Apple 凭据状态：以下五项 Actions Secrets 全部
存在时，使用 Developer ID Application 证书签名，并通过 App Store Connect
API Key 提交 Apple notarization；五项全部缺失时，明确生成未签名、未公证的
DMG 和 ZIP，并在 Actions 日志与摘要中警告 Gatekeeper 限制；只配置一部分时
任务失败，不能静默降级为未签名包。

- `MACOS_CERTIFICATE_BASE64`：包含证书及私钥的 `.p12` 文件经 Base64 编码后的内容。
- `MACOS_CERTIFICATE_PASSWORD`：导出 `.p12` 时设置的密码。
- `APPLE_API_KEY_BASE64`：App Store Connect API Key 的 `.p8` 文件经 Base64 编码后的内容。
- `APPLE_API_KEY_ID`：App Store Connect API Key 的 Key ID。
- `APPLE_API_ISSUER`：App Store Connect API Key 的 Issuer ID。

在 macOS 上生成适合 Secrets 的单行 Base64 内容：

```bash
base64 -i DeveloperIDApplication.p12 | tr -d '\n'
base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n'
```

证书必须是 Apple Developer 后台创建的 `Developer ID Application`，并在导出
`.p12` 的 Mac 钥匙串中同时包含对应私钥。API Key 建议使用团队级 App Store
Connect Key；`.p8` 只能下载一次。签名材料只放入 GitHub Secrets，不提交到仓库。

凭据完整时，macOS 打包完成后会挂载 DMG，并分别执行 `codesign`、Gatekeeper
`spctl` 和 `stapler` 校验；签名无效或 notarization ticket 不存在时，发布矩阵
会在上传产物前失败。完全没有凭据时，六平台矩阵和标签发布仍可完成，但 macOS
产物没有 Developer ID 签名或 Apple 公证，Gatekeeper 可能阻止首次打开。发布
工作流必须在 Actions 日志与摘要中明确这一限制；获得完整凭据后应恢复签名
发布并重新验证。

Windows 代码签名仍未配置。对外分发前还应配置 Windows 签名凭据，并重新验证
安装、升级和系统安全提示。

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

## Renderer bundle 性能门禁

`electron-vite` 会在 `out/renderer/.vite` 生成 Vite manifest 和仅含构建模块
归属的 module manifest。`npm run build:bundle` 在 bundle 完成后自动运行
`build/check-renderer-bundle.cjs`，去重统计首屏同步闭包及 Knowledge、知识图谱、
Activity、Magic Notes、Settings 动态入口同步加载的 JS 与 CSS 合计 raw / gzip
大小并执行预算校验。

门禁同时验证以下结构约束：

- Knowledge、Activity 与 G6 不得进入首屏同步闭包。
- `KnowledgeGraphChart` 与 G6 不得进入 Knowledge shell 的同步闭包。
- G6 必须由知识图谱动态入口同步拥有。

路径遍历使用 manifest 中的相对文件名并通过 Node `path.resolve` 读取，因此兼容
Windows 与 POSIX 构建输出。构建专用 module manifest 只记录项目相对路径、
`node_modules/` 相对路径或稳定的虚拟模块名，不记录 Runner 的盘符、主目录或
绝对路径；检查成功后会删除该诊断文件，检查失败时保留以便排查。标准 Vite
manifest 会保留在输出中。预算以干净生产构建为基线并保留有限余量；若业务确需
提高预算，必须先检查 manifest 闭包和产物差异，不能只为通过 CI 调大数值。

Bundle 大小是发现意外依赖和持续膨胀的粗粒度工程护栏，不是用户体验指标，也不能替代
Electron 中的实际交互验证。Settings 的硬上限以 2026-08-23 验证构建
`648.78 kB raw / 97.79 kB gzip` 为基线，增加约 15% 评审余量后取整为
`750 kB raw / 115 kB gzip`。该上限用于拦截显著增长，不要求实现长期贴线运行。

调整 Renderer 拆包时遵守以下优先级：

1. 同级页签的交互一致性、首个绘制帧内反馈和输入保留优先于包体数字。
2. 不得仅为通过预算，把一个原本轻量的同级页签单独改成首次点击才加载。
3. 确需动态加载重型功能时，必须提供非空、无布局跳变的局部状态，并增加首次交互测试。
4. 修改预算必须记录干净生产构建基线、增量闭包差异和 Electron 实测结果。
