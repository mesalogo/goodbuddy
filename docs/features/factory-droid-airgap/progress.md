# Factory Droid Airgap 验证进度

## 2026-10-14：本机二进制与环境变量检查

### 被测对象

- 路径：`C:\Users\jiang\bin\droid.exe`
- 版本：`0.238.0`
- 文件大小：`281,700,576` bytes
- SHA-256：`D7BC651C24AD3A2B066D7F7FD9E9FCD124246E70B0F31664540AA33D4F1AAF9D`
- 平台：Windows x64
- 内嵌运行时：Bun `1.4.2`

### 已验证事实

1. `droid exec --help` 暴露 `--output-format acp`，并同时支持 `text`、`json`、
   `stream-json` 和 `stream-jsonrpc`。
2. `droid exec --help` 暴露 `--settings <path>`，二进制字符串还包含
   `FACTORY_RUNTIME_SETTINGS_PATH` 和 `FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH`。
3. 二进制的环境变量映射包含 `FACTORY_AIRGAP_ENABLED`，其值 `true` 或 `1` 会启用 Airgap。
4. 二进制包含明确错误文案：内置模型在 Airgap 部署中不可用，需要配置 BYOK custom model。
5. Airgap 执行分支会拒绝通过 Factory LLM proxy 路由的内置模型，并要求使用
   `settings.json` 中的 BYOK custom model。
6. `FACTORY_DROID_AUTO_UPDATE_ENABLED` 和 `FACTORY_DISABLE_SETTINGS_PERSISTENCE` 均存在于
   二进制环境变量映射，可用于 GoodBuddy 子进程启动隔离。
7. 设置 `FACTORY_AIRGAP_ENABLED=1` 后执行：

   ```text
   droid exec --model gpt-6-sol --list-tools --output-format json
   ```

   返回 `Invalid model: gpt-6-sol`，并报告 `Available built-in models: None`，同时列出本地
   custom models。这与 Airgap 禁用内置模型的逻辑一致。
8. 设置 `FACTORY_AIRGAP_ENABLED=0` 且同时设置 `AIR_GAP=1` 后，同一命令正常列出内置工具，
   说明当前版本不使用 `AIR_GAP` 作为 Airgap 开关。
9. `droid doctor --config --json` 在设置 `AIR_GAP=1` 或 `FACTORY_AIRGAP_ENABLED=1` 时都能
   完成配置检查；该命令本身没有把 Airgap 状态作为公开诊断字段输出，因此不能用它单独证明
   Airgap 已启用。

### 执行命令

```text
droid --version
droid exec --help
droid doctor --config --json
$env:FACTORY_AIRGAP_ENABLED='1'; droid exec --model gpt-6-sol --list-tools --output-format json
$env:FACTORY_AIRGAP_ENABLED='0'; $env:AIR_GAP='1'; droid exec --model gpt-6-sol --list-tools --output-format json
```

上述检查没有向 Factory 模型发送 Prompt，没有修改仓库文件，也没有修改用户 settings 文件。

### 尚未验证

- 真实 Airgap build 的 ACP 初始化和多轮 Prompt。
- 使用本地或内网 custom model 的真实文本请求。
- ACP 工具调用、问答、取消、进程树回收和会话恢复。
- Windows 防火墙或 Sandbox 对外联请求的实际阻断结果。
- GoodBuddy 适配器、Runtime 选择器、发行包和远程 Agent 支持。

当前证据只支持进入 GoodBuddy Runtime 实现阶段，不代表 Factory Droid 已经接入 GoodBuddy。
