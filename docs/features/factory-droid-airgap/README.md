# Factory Droid Airgap Runtime

本功能记录 Factory Droid 作为 GoodBuddy 本地 Agent Runtime 的接入方案，重点覆盖
Factory Droid Airgap 模式、ACP 子进程协议、模型配置边界和离线网络行为。

当前状态为调研与设计，尚未把 Factory Droid 注册到 GoodBuddy 的 Runtime 选择器，
也尚未修改应用代码或安装包。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [技术设计](./technical-design.md) | 产品边界、启动参数、配置、ACP 适配、生命周期和实施顺序 |
| [验证进度](./progress.md) | 本机 `droid.exe` 二进制检查、命令结果和剩余验证 |

## 术语

- **Factory Droid**：Factory 提供的 `droid` CLI 及其本地 Agent harness。
- **Factory Droid Airgap**：由 `FACTORY_AIRGAP_ENABLED=1` 启用的 Droid 运行模式。
- **ACP**：Factory Droid 通过 `droid exec --output-format acp` 暴露的 Agent Client Protocol
  进程接口。
- **BYOK 模型**：Droid `settings.json` 中的 `customModels`，模型请求发送到用户配置的
  endpoint，而不是 Factory LLM proxy。

GoodBuddy 的通用 Runtime 选择、能力分配、取消和执行空间规则仍由现有 Runtime 契约维护。
Factory Droid 自身的模型配置、MCP、插件和 Sandbox 规则属于子进程配置边界。
