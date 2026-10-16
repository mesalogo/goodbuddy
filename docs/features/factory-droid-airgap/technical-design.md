# Factory Droid Airgap Runtime 技术设计

## 当前结论

Factory Droid 适合以本地 ACP Runtime 接入 GoodBuddy。GoodBuddy 启动用户已经安装的
`droid` 可执行文件，使用标准输入输出承载 ACP；Factory Droid 继续管理自己的模型、MCP、
Skills、插件和 Airgap 配置。

当前版本的二进制明确读取 `FACTORY_AIRGAP_ENABLED`。`AIR_GAP` 不属于当前版本公开的
环境变量映射，GoodBuddy 不应依赖该名称。

## 产品边界

### 计划支持

- 在本机项目中选择 Factory Droid Runtime。
- 使用 Factory Droid 的 ACP 流式事件完成文本、工具活动、问答、取消和终态展示。
- 通过 `--settings` 或 `FACTORY_RUNTIME_SETTINGS_PATH` 使用隔离的 Droid 设置。
- Airgap 模式只允许 Droid 的 BYOK/custom model，并阻止 Factory LLM proxy。
- 禁用自动更新和 GoodBuddy 不需要的配置持久化。
- 保留 GoodBuddy 现有请求归属、取消、错误脱敏、活动记录和会话恢复边界。

### 明确不包含

- 不把 Factory Droid 或 Enterprise Airgap binary 自动打入公开 GoodBuddy 安装包。
- 不在 Renderer 保存 Factory API Key、模型密钥或 MCP 凭据。
- 不把 Factory 云端会话同步、登录、账单、Factory 遥测或更新服务引入 GoodBuddy。
- 不把 Droid 的自有配置伪装成 GoodBuddy 模型连接。
- 不把 Airgap 环境变量当作网络隔离保证。最终隔离仍由用户网络、主机策略和 Sandbox 提供。

## 启动契约

Airgap Runtime 的目标启动参数为：

```text
droid exec --output-format acp --settings <settings-path> --cwd <workspace>
```

GoodBuddy 应为子进程注入以下环境变量：

```text
FACTORY_AIRGAP_ENABLED=1
FACTORY_DROID_AUTO_UPDATE_ENABLED=0
FACTORY_DISABLE_SETTINGS_PERSISTENCE=true
```

`FACTORY_RUNTIME_SETTINGS_PATH` 可以作为 `--settings` 的进程环境替代方案。配置路径、
模型 endpoint 和密钥引用必须由 Main 进程决定，不能直接采用 Renderer 传入的任意环境变量。

Airgap 设置至少需要一个 Droid custom model。例如配置可以包含：

```json
{
  "customModels": [
    {
      "model": "local-coder",
      "displayName": "Local Coder",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "provider": "generic-chat-completion-api"
    }
  ]
}
```

示例只说明协议形状，不作为 GoodBuddy 默认配置，也不包含凭据。

## ACP 适配

新增 `FactoryDroidRuntime`，职责与现有本地 OpenCode/Continue Runtime 对齐：

1. 校验可执行文件路径、设置路径、工作区和启动环境。
2. 为会话启动 ACP 子进程并绑定 stdin/stdout。
3. 将 ACP 初始化、Prompt、文本增量、工具调用、工具结果、问答、用量和终态转换为
   GoodBuddy 的 `RuntimeEvent`。
4. 将 GoodBuddy 的 AbortSignal 转换为 ACP 取消，并在超时或退出时回收完整进程树。
5. 将会话 ID 与 Conversation 绑定，避免不同 Conversation 复用错误的 Droid 会话。
6. 子进程启动失败、Airgap 缺少 custom model、模型不可达和 ACP 协议错误均返回稳定的
   Runtime 状态与脱敏错误。

现有 `AcpRemoteRuntime` 面向 SSH 远程虚拟通道，不能直接复用为本地进程实现；可以复用
   其中的 ACP 消息映射和语义事件处理规则。

## 配置与凭据

第一阶段应支持用户指定 Droid 可执行文件路径和 Airgap settings 路径。GoodBuddy 可以在
Main 中生成请求级或 Runtime 级配置快照，但不能把完整凭据写入 Renderer、普通项目文件、
日志或会话消息。

`FACTORY_DISABLE_SETTINGS_PERSISTENCE=true` 用于避免 Droid 子进程改写用户全局
`%USERPROFILE%\\.factory\\settings.json`。Droid 本身的 custom model、MCP、插件和 Sandbox
配置仍由它的 settings 层级解析。

## 选择器与能力

Runtime provider 需要新增 `factory-droid`，并在本机 Runtime 列表中显示为 Factory Droid。
Airgap 是该 Runtime 的固定启动配置或独立显示项，最终 UI 方案待实现阶段确定；无论采用哪种
显示方式，Airgap 启动都必须强制注入 `FACTORY_AIRGAP_ENABLED=1`。

Factory Droid 的原生权限确认不能让 GoodBuddy 请求无限等待。实现时必须验证 ACP 模式下
的 autonomy、permission 和问答行为，并把需要前台回答的问题映射到 GoodBuddy 统一问答卡片。
GoodBuddy 不新增独立的 Ask / Execute 产品模式。

## 实施顺序

1. 新增 Runtime provider、配置契约和可执行文件发现。
2. 实现本地 ACP 进程适配器及进程树回收。
3. 接入 Runtime 选择、状态、活动、取消、问答和会话恢复。
4. 接入 Airgap settings 快照及启动环境，保持凭据只在 Main/子进程边界内流动。
5. 用真实 Factory Droid ACP 进程验证 custom model、工具、取消、问答、恢复和无外联行为。
6. 再决定是否允许发行包通过用户提供的路径或受授权的 Enterprise artifact 集成 Droid。
