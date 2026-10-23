# Factory Droid Airgap Runtime

通用规范与接入契约见 [Agent Runtime](../../README.md)。本目录维护 Factory Droid 的接入设计与验证证据。

本功能记录 Factory Droid 作为 GoodBuddy Agent Runtime 的接入方案，覆盖 Airgap 启动、
原生会话协议、用户问答、会话顶部后台任务和模型配置。

推荐通过官方 SDK 的原生会话接口接入，后台任务管理使用本地 daemon 的公开控制接口。
Droid `0.245.1` 与 SDK `0.10.0` 已验证问答、流式、Skills、MCP、Todo、恢复，以及后台
子代理独立停止/输出/终态；确定性测试与真实模型证据分别记录在验证进度中。
GoodBuddy 的 MCP 启停为全局设置，项目级 toggle 不属于产品需求。MCP 动态禁用后的连接
状态未及时收敛，后台 Shell 独立停止仍待验证。
产品 Runtime、顶部任务 UI 和远程 Agent 尚未实现，ACP 保留为早期对照。

交付方式已确定为不捆绑主安装包，优先复用已有 Droid，支持按需安装与离线导入。
具体范围见[产品需求](./prd.md#安装与分发)，本轮只记录方案，没有安装或升级 Droid。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [产品需求](./prd.md) | 功能范围、FR 编号及交付判定 |
| [用户场景](./user-stories.md) | US 编号、端到端验收场景及需求关联 |
| [状态设计](./logic-design.md) | 权威来源、会话/任务/问答生命周期及停止语义 |
| [界面设计](./ui-design.md) | 顶部任务条、问答入口、输出查看及布局行为 |
| [技术设计](./technical-design.md) | 原生协议选择、现有代码扩展点、进程/存储所有权及远程实现 |
| [验证进度](./progress.md) | 二进制、ACP/native 实测、请求统计和未解决项 |

## 术语

- **Factory Droid**：Factory 提供的 `droid` CLI 及其本地 Agent harness。
- **Factory Droid Airgap**：由 `FACTORY_AIRGAP_ENABLED=1` 启用的 Droid 运行模式。
- **ACP**：Factory Droid 通过 `droid exec --output-format acp` 暴露的 Agent Client Protocol
  进程接口，用于前期对照测试。
- **原生协议**：`droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
  提供的 Factory JSON-RPC，会话通知与 SDK handler 使用此协议。
- **后台任务**：能够脱离主回复继续执行的子代理或后台命令，具有独立状态和控制需求。
- **BYOK 模型**：Droid `settings.json` 中的 `customModels`，模型请求直接发送到用户配置的
  endpoint。

GoodBuddy 的通用 Runtime 选择、能力分配、取消和执行空间规则仍由现有 Runtime 契约维护。
Factory Droid 自身的模型配置、MCP、插件和 Sandbox 规则属于子进程配置边界。
