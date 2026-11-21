# Pi Coding Agent Runtime

通用规范与接入契约见 [Agent Runtime](../../README.md)。本目录维护 Pi Coding Agent
（`@earendil-works/pi-coding-agent`）作为 GoodBuddy Runtime 的接入方案与验证证据。

2026-11-16 状态：已完成上游 SDK 在 Electron UtilityProcess 中的可行性验证，**产品 Runtime
尚未实现**。Pi 是 Continue 的替代候选；替换前 Continue 保持现状，可继续切换使用。

## 结论摘要

- 接入方式：在受控 UtilityProcess 中加载 Pi 官方 bundle 的 SDK 入口，由 GoodBuddy 显式提供
  模型、设置、会话、Skills 和官方 MCP 能力，不读取用户自己的 `~/.pi` 配置。
- 已验证：Pi `1.5.2` 官方 bundle 精简后 14.56 MiB，宿主启动约 0.2 秒；确定性场景 16 项、
  真实 `gpt-6-astra` / Responses 场景 7 项通过，详见[验证进度](./progress.md)。
- Pi 默认没有结构化问答、Todo 和子代理工具；按用户确认的原则，不通过自建或示例扩展补齐。
  原生 UI 交互协议与模型可调用的提问工具分别声明。跨主回复后台任务和后台命令不支持。
- 交付方式（主包携带或应用市场）尚未决定，见 [PRD 待决事项](./prd.md#待决事项)。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [产品需求](./prd.md) | 范围、FR 编号、能力声明、交付与 Continue 替换判定 |
| [技术设计](./technical-design.md) | 宿主进程、协议、模型桥、能力映射、打包和代码改动位置 |
| [验证进度](./progress.md) | 上游探针结果、请求统计、体积/启动数据和未验证范围 |

用户场景、状态设计和界面设计暂不单列：Pi 复用现有聊天界面，不生成没有原生数据来源的
顶部待办和子代理条目。OMP 对标只属于扩展可行性讨论，未改变这一接入范围。

## 术语

- **Pi**：earendil-works 发布的开源编码 Agent，MIT 许可，包含 SDK、CLI/TUI 和 RPC 模式。
- **官方 bundle**：包内 `dist/bundle/`，由上游脚本合并生成的 ESM 运行文件，本方案的唯一加载入口。
- **Pi 宿主**：GoodBuddy 启动的 Electron UtilityProcess，持有一个或多个 Pi `AgentSession`。
- **探针扩展**：历史测试通过 `extensionFactories` 注入的问答、Todo、子代理工具；不属于产品方案或 Pi 原生能力。
