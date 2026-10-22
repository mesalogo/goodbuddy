# Factory Droid Airgap Runtime

本功能记录 Factory Droid 作为 GoodBuddy Agent Runtime 的接入方案，覆盖 Airgap 启动、
原生会话协议、用户问答、会话顶部后台任务和模型配置。

推荐使用原生 `stream-jsonrpc`，复用官方 SDK 的公开接口。Droid `0.245.1` 与 SDK `0.10.0`
已经通过真实模型问答、文本增量及后台子任务创建验证；普通后台任务独立停止和终态同步仍未
通过。此前 ACP 测试保留为协议对照。产品 Runtime、顶部任务 UI 和远程 Agent 尚未实现。

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
