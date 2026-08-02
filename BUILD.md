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

生成 Windows 便携目录：

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

## Linux CI

`.github/workflows/linux-packages.yml` 支持手动触发，也会在推送 `v*` 标签时构建 Linux 包。`x64` 与 `arm64` 应分别使用对应的原生 Linux Runner 完成构建和校验。

## 发布前冒烟测试

建议在每个目标系统上至少验证：

1. 安装、启动、升级和卸载。
2. 中文输入法、窗口缩放和高分屏显示。
3. 系统密钥环和模型连接。
4. 本地知识库导入、检索和知识图谱。
5. Ask、Plan、Execute 的权限边界。
6. OpenCode 与 Continue 的审批、取消和超时。
7. 智能心跳的创建、暂停、恢复和历史记录。
8. 应用退出后无残留 Runtime 子进程。
