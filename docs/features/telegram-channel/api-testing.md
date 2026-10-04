# Telegram API 联调

## 用途与边界

[run-live-probe.mjs](./run-live-probe.mjs) 启动 Electron，运行 [live-probe-main.ts](./live-probe-main.ts)，检查生产驱动及可选的 ChannelService 固定回复。[telegram-probe.mjs](./telegram-probe.mjs) 是独立 Node API 诊断脚本，没有接入 GoodBuddy 项目、会话、白名单、Runtime 或发件箱。

两类探针都不调用模型，成功不能代替真实 Bot 与模型完整链路验收。生产驱动使用 Electron `net.fetch` 和系统代理，没有引入 grammY 或 Telegraf；独立脚本使用 Node `fetch`。当前结果和 2026-10-04 历史记录统一见[进度记录](./progress.md)。本次生产实时探针未运行，原因是 `TELEGRAM_BOT_TOKEN` 不存在。

## 生产驱动探针

从仓库根目录运行，需要已安装项目依赖（Electron、esbuild）。启动器在临时目录构建生产源码，使用隔离的 Electron 用户目录，退出后清理。可用 `--temp-parent PATH` 指定已存在的临时父目录。

```powershell
node "docs/features/telegram-channel/run-live-probe.mjs" --dry-run
```

`--dry-run` 只构建并检查语法，不启动 Electron，不发网络请求，不需要 Token。它不能证明代理路径可用。实时连接检查使用下面命令；隐藏输入仅放入进程环境，不写文件。

```powershell
$telegramProbeSecret = Read-Host 'Telegram Bot Token' -AsSecureString
$env:TELEGRAM_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $telegramProbeSecret).Password
try {
    node "docs/features/telegram-channel/run-live-probe.mjs"
} finally {
    Remove-Item Env:TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
    $telegramProbeSecret = $null
}
```

默认仅通过生产驱动执行 `getMe` / `getWebhookInfo`，不轮询、不发送。`TELEGRAM_BOT_TOKEN` 是探针输入，产品只读环境配置使用 `GOODBUDDY_TELEGRAM_BOT_TOKEN`，两者不能混用。

要验证固定回复，先停用该专用测试 Bot 的其他消费者，在普通私聊发送精确文本 `/goodbuddy_test`，再将上述运行命令替换为：

```powershell
node "docs/features/telegram-channel/run-live-probe.mjs" --send-test
```

发送模式从首批最多 100 条积压中选择最近 24 小时内最新的合格私聊标记，临时授权该发送者，经生产驱动和 ChannelService 返回固定文字。网络适配层只把选中的事件交给驱动，其他事件不会触发帮助或任务；使用临时内存状态和固定 executor，不经过产品设置页、生产模型或持久化发件箱。

发送模式会启动生产轮询、设置 `allowed_updates=['message']` 并可能推进 offset，因而可能确认或消费更早的积压。仅对专用空闲 Bot 使用；这与独立 Node 探针不推进 offset 的行为不同。无匹配标记时失败退出，不等待用户补发。

| 输出 | 含义 |
| --- | --- |
| `PASS: production driver getMe/getWebhookInfo.` | 生产驱动身份及 webhook 检查成功 |
| `PASS: production driver and ChannelService delivered the test reply.` | 固定回复 API 成功，仍需手机核对展示；未调用模型 |
| `FAIL: no eligible marker...` | 首批积压无合格标记，收发未验证 |
| 其他 `FAIL` 或非零退出 | 设置、构建、网络、停止或清理失败，不算通过 |

启动器只转发固定结果码，抑制可能包含 Token URL 的 Electron 输出，并强制 TLS 校验。成功退出要求对应检查完成且子进程正常退出。

## 独立 Node 探针

默认只调用 `getMe` 和 `getWebhookInfo`，不读取消息或发送回复。添加 `--listen` 后，在无 webhook 的情况下进行约 45 秒长轮询，仅对运行开始后收到的私聊 `/goodbuddy_test` 回复一条固定测试文字，然后退出。不处理其他消息、不调用模型、不下载附件。

脚本不推进更新 offset、不修改订阅类型、不删除 webhook。已读取的更新仍可能被后续消费者再次读取；请使用专用 Bot，避免与其他轮询进程同时运行。积压达到单批 100 条时停止测试，不主动确认或清空消息。固定回复发生网络结果不明时不自动重试。

### 运行方法

历史实测环境为 Windows、PowerShell 5.1、Node.js 24.21.0。以下命令从仓库根目录执行，Token 通过隐藏输入传入当前进程环境，不保存在文件中。不要把实际 Token 写进命令、文档或 Git。

```powershell
$telegramProbeSecret = Read-Host 'Telegram Bot Token' -AsSecureString
$env:TELEGRAM_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $telegramProbeSecret).Password
try {
    node --use-env-proxy "docs/features/telegram-channel/telegram-probe.mjs"
} finally {
    Remove-Item Env:TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
    $telegramProbeSecret = $null
}
```

`--use-env-proxy` 需要支持该选项的 Node 版本，脚本不会自动读取 Windows 系统代理。若机器依赖系统代理，先按下面方式将当前代理临时提供给 Node；这不会修改操作系统代理配置。结束后恢复原有环境值。

```powershell
$telegramProbePreviousProxy = $env:HTTPS_PROXY
$telegramProbeProxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]'https://api.telegram.org')
if ($telegramProbeProxy.Host -ne 'api.telegram.org') {
    $env:HTTPS_PROXY = $telegramProbeProxy.AbsoluteUri
}
# 在此执行上面的凭据输入和测试命令。
$env:HTTPS_PROXY = $telegramProbePreviousProxy
```

测试真实收发时，将运行命令改为：

```powershell
node --use-env-proxy "docs/features/telegram-channel/telegram-probe.mjs" --listen
```

看到提示后，在 Telegram 打开测试 Bot 的普通私聊，发送 `/goodbuddy_test`。脚本成功发送固定回复后输出 `privateMessageRoundTrip` 的 `ok: true`。用户还需在手机端确认实际收到回复。

如果已发送测试指令，使用 `--pending` 替代 `--listen`。脚本单次查询排队消息，选择最近一小时内最新的私聊 `/goodbuddy_test` 并回复，无需在监听窗口内发送。该选项同样不推进 offset，重复运行可能再次回复同一条指令，仅在需要复测时使用。

脚本强制开启 TLS 证书校验，不沿用外部环境中的关闭校验设置。输出仅包含检查结果、Bot 用户名、是否配置 webhook、积压数量和有界错误码；不打印 Token、完整请求地址、原始异常、消息正文或聊天 ID。

### 结果解释

| 输出或退出码 | 含义 |
| --- | --- |
| 退出码 0，默认检查 | Bot 身份及 webhook 状态查询成功；未验证收发 |
| 退出码 0，`privateMessageRoundTrip` 成功 | 收到测试指令，发送回复 API 返回成功 |
| 退出码 2，`no_matching_message` | 时间窗口内未收到符合条件的测试指令，收发待验证 |
| 退出码 1 | 网络、凭据、平台错误或测试条件不满足 |
| `UND_ERR_CONNECT_TIMEOUT` | 网络连接超时，优先检查当前进程的代理路径 |
| API error 401 | 凭据无效或已撤销 |
| API error 409 | 检查 webhook 或其他长轮询实例是否占用 |
| API error 429 | 平台限流；脚本报告等待时间，不自动继续请求 |

日期化实测结果见[进度记录](./progress.md)。独立 Node 请求走通不能证明 Electron 生产网络路径走通；固定回复成功也不能证明模型或工具任务成功。
