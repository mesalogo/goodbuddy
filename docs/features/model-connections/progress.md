# 模型连接请求定制进度

## 2026-09-11：发布前固定模型说明修复

- 项目已保存固定 Runtime 模型时，恢复显示实际固定模型的帮助文字，保留简化后的菜单；
  规则见 [会话与项目 Runtime 选择](./ui-design.md#会话与项目-runtime-选择)。
- `npm exec vitest run src/renderer/src/ProjectRuntimeSelector.test.tsx`：2 项通过，
  覆盖中英文下 OpenCode、Continue、DeepSeek Harness 的固定选项及恢复跟随操作。
- `npm test`：343 个文件、3,911 项通过，66 项按平台或手工/真实服务条件跳过；
  `npm run typecheck`、`npm run lint`、`npm run release:notes:verify` 通过。
- 本次新增修复仅影响 Renderer 帮助文字，未修改共享模型解析、Desktop-to-Agent 请求、
  Agent 或 Runtime 启动实现；不需要单独远程修复。真实模型调用 0 次，未运行真实 Host
  或桌面端到端模型会话。本地未构建或打包，发布候选生产构建由主分支 CI 验证。

## 2026-09-10：配置准确性修复

- 通道直连回退修复已按[技术设计第 8 节](./technical-design.md#8-通道直连模型选择修复)
  实现；测试把修复结果交给现有 Main resolver，不仅断言返回对象。
- Harness 设置使用专用来源标签、关联帮助及 Main 直接从生产 resolver 派生的只读
  `deepseekHarnessPlatformModel` 投影；准确区分完整管理员预置、兼容回退和无连接，
  不再从通用环境凭据状态推断。投影不含地址、密钥或请求定制，也不写入设置文件。
- 无兼容连接时管理员来源仍可选择；未保存候选与实际已保存来源分别展示。UI 验证涵盖
  中英文、兼容默认、首个兼容回退、管理员覆盖、部分环境回退、无连接、草稿预览和保存动作。
- 聚焦命令 `npx vitest run src/main/agent/runtime-selection-contracts.test.ts src/renderer/src/SettingsPanel.test.tsx`
  对应的两个文件在本次五文件联合运行中全部通过，共 96 项。真实模型调用 0 次；
  本次未运行全量测试、typecheck、lint 或真实 Harness 请求。
  通道修复集成测试随后归入 Main 测试目录，避免 Shared/Web 类型项目导入主进程实现。
- 后续聚焦验证 `npx vitest run src/main/runtime-settings-store.test.ts src/renderer/src/SettingsPanel.test.tsx`
  全部通过：2 文件、181 项。Store 覆盖完整、部分与旧环境变量、默认/首个兼容回退、
  无连接、精确字段白名单、非持久化以及不改变所选来源。真实模型/Host 调用均为 0；
  未运行全量测试、构建、typecheck 或 lint。

## 2026-09-03

### 已完成

- 模型连接设置、v20 → v21 迁移、公开与 resolved profile 已接入有界自定义 Header/Body。
- 设置页已提供两个 JSON 编辑器、就地校验、保存阻止、普通设置存储提示和 Runtime 支持范围。
- 直连连接测试、文本、工具、摘要和图像请求已统一采用 Runtime 优先的浅合并。
- Continue 1.5.47 已通过原生 `requestOptions.headers` 与 `extraBodyProperties` 接入两项配置。
- bundled OpenCode 已通过 Provider `options.headers` 接入 Header，并确认没有发送未支持的
  自定义 Body。
- DeepSeek Harness 已通过控制协议 v3 把 Header 交给 Pi-AI Provider，没有接入未支持的
  自定义 Body。
- Main 与 Agent 远程模型网关已接入 Prompt-scoped Header/Body；`runtime/acp` capability
  已提升为 v5。
- 功能入口、支持矩阵、合并优先级、普通设置存储边界和协议版本已写入功能文档及双语
  `FEATURES`。

### 已验证

- `npm run typecheck`
- `npm run lint`
- 20 个聚焦测试文件：527 项通过，4 项按环境跳过。
- 全量 `npm test`：326 个测试文件通过，8 个文件按环境跳过；3506 项通过，55 项跳过。
- bundled OpenCode 与 Continue 分别对 loopback Provider 验证 Chat Completions 和
  Responses。4 项原生探针全部通过：两者都发送自定义 Header；Continue 发送自定义 Body；
  OpenCode 不发送不支持的 Body。
- Main/Agent 远程网关测试验证了合并优先级、认证优先、profile digest 绑定和单次分发。
- 三路清理审查完成；已复用共享协议路径、Header 规范化、ACP capability 常量和 JSON
  类型，并为 Renderer JSON 草稿增加解析前长度上限。

### 待验证

- 生产 `npm run build`。
- 最小真实模型 Header/Body 探针。
- DeepSeek Harness 真实 Provider Header 探针。
- 当前源码 Agent bundle 在共享 Linux x64 Host 上的受管远程模型请求。
