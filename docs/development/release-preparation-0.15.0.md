# Desktop 与 Agent 0.15.0 发布准备

日期：2026-09-27。候选验证通过，不代表已发布。

## 范围与批准

- 用户要求 Desktop 与 GoodBuddy Agent 同步升级至 `0.15.0`，明确不构建 LoongArch。
- 源码基线：`0f8bf405db7ca21a85cc70009ad083eb837e1e03`。
- Desktop 差异基线为已发布的 `v0.13.16`，Agent 为 `agent-v0.13.4`。
- 准备两个独立标签 `v0.15.0` 与 `agent-v0.15.0`；尚未创建或推送。
- 用户已批准两份完整双语说明，正式正文仅维护在
  [Desktop 发布资源](../../resources/release-notes.json) 的 `0.15.0` 条目与
  [Agent 发布资源](../../resources/agent-release-notes/0.15.0.md)。
  已逐条核对写入文本与批准草案一致，本记录不再复制正文。
- `FEATURES.md` 与 `FEATURES.zh-CN.md` 已核对本轮能力、限制和候选版本。
- 用户要求两张未跟踪宣传截图保留原位、不提交，打标签前另行处理；
  不移动、删除、暂存或更改忽略规则。

## 本地验证

- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run release:notes:verify`：通过。
- 发布说明相关三个文件定向测试：16 项通过。
- 首轮 `npm test`：5,313 通过、79 跳过、4 失败，耗时 697.61 秒。
  三项失败来自当时尚未批准写入的 0.15.0 Desktop/Agent 发布说明；
  另一项为 `magic-notes-layout.electron.test.ts` 的布尔断言。
  该布局用例单独复验 1 项通过，未修改源码或放宽断言。
  单独通过不替代全量结果。
- 正式说明写入后的最终 `npm test`：**5,317 通过、79 跳过、0 失败**，
  453 个测试文件通过、11 个跳过，耗时 645.49 秒。随后再次执行完整
  `npm run typecheck` 与 `npm run lint`，均通过。
- 最终验证期间出现并行宣传文档编辑及新增 `storygraph.png`，均不属于本次
  发布准备改动，不暂存或覆盖。打标签前仍须处理工作区洁净条件。
- 修改文档的相对文件链接、版本一致性和 `git diff --check` 通过。
- 不运行本地生产构建、打包或安装包启动。准确候选提交须经用户批准，
  然后双远端推送、主分支 CI、生产构建、原生发布与公开核验分别进行。

## Agent 当前源码实机验证

共享 Linux x64 Host 的 LAN/VPN SSH 端口均可达，实际通过 LAN 与既有固定
Host Key、加密凭据连接。重新捆绑当前源码的 Agent CLI、daemon、model bridge
与 Desktop 适配器，仅上传独立 `/root/tmp/gb-lifecycle-*` 测试目录，复用已安装且
版本锁未变的 Node/OpenCode/Continue，不替换原安装，不构建正式包。

最终 OpenCode、Continue 各通过一次 Ask 和一次 Execute，无工具请求，
验证回答、后续历史、空闲 Runtime 回收及测试停止后所属进程为 0。
模型请求时读取所属进程的固定遥测字段，确认 `DO_NOT_TRACK=1`、
`OTEL_SDK_DISABLED=true` 及三个 exporter 均为 `none`，不输出整个环境。
这些结果补齐 `eb53c82` 的 Agent/model bridge 真实链路验证，
但不证明后台没有其他网络流量，也不替代三目标正式包验收。

首轮 Continue 探针沿用了 OpenCode 原生历史持久化假设，未像 Desktop 一样传入
`request.history`，第二轮历史断言失败；当前 Continue 冷启动源码明确要求传入
保存历史。修正测试输入及会话 ID 断言后通过，未修改产品实现。

有完整计数的实机运行共 **8 次**真实模型 HTTP 请求：首次 OpenCode 2 次、
首次 Continue 2 次、最终 Continue 2 次、最终 OpenCode 2 次。
此前一次直接启动 Electron 的探针未捕获子进程输出，不能确认是否实际发出请求，
该次上限 2 次，不纳入通过证据；因此不能把 8 次写成本轮精确总数，总量为 8–10 次。
后续均使用等待退出并记录脱敏输出的启动器；本轮探针 Electron 进程已退出。
本地诊断证据在临时 `opencode/release-015-host/`，不提交脚本、日志或凭据。

## 首次候选 CI 与测试修正

用户批准的首次候选 `5a6ba6c14f5c58f3da5e9afe281b18e0cbdb1ae8`
已推送至 `origin/main` 和 `github/main`，未创建两个发布标签。

- [Agent CI 36329271991](https://github.com/mesalogo/goodbuddy/actions/runs/36329271991)
  源码验证及 Linux x64、Linux arm64、Darwin arm64 原生构建全部通过。
- [Desktop CI 36329271967](https://github.com/mesalogo/goodbuddy/actions/runs/36329271967)
  为 5,342 通过、51 跳过、3 失败。两个 App 长历史场景超过默认 5 秒单用例时限；
  会话采集 Electron 场景等待 Escape 返回笔记列表超时。生产构建未运行。
- 测试修正仅让原生键盘辅助函数显示窗口、获取焦点并等待 `document.hasFocus()`，
  然后发送真实输入；两个长历史场景采用仓库既有的 15 秒单用例时限。
  不修改产品实现、不跳过 Linux、不关闭沙箱、不删除或放宽数据和键盘断言。
- Windows 聚焦复验三个失败场景通过，其中真实 Electron 覆盖完整 502 条历史、
  214px 窄栏键盘操作、浅深主题确认按钮、真实 IPC/SQLite 和重开保留。
  修正后首次全量复验被中断，不计为通过；随后完整重跑为 **5,317 通过、
  79 跳过、0 失败**，453 个文件通过、11 个跳过，耗时 646.48 秒。
  类型检查、lint 和发布说明校验均通过，新候选 Linux CI 仍需独立通过。
- 本次只改测试和验证文档，不改变 Agent、远程 Runtime 或模型桥；
  沿用上方当前源码 Host 验证，不新增真实模型请求。
- 新提交必须重新取得准确 SHA 批准，原发布说明正文保持不变。

## 数据、兼容与验收边界

Desktop schema 48 新增魔法笔记会话来源元数据。升级前应备份完整用户数据，
包括数据库及相邻 `notes/` 目录；旧客户端不能打开升级后的数据库。
本次发布准备不修改数据库迁移实现，也不直接改写用户数据库。

Agent 发布工作流以候选 `package.json` 设置最低 Desktop 版本，因此
Agent 0.15.0 包要求 Desktop 0.15.0；Node、OpenCode、Continue 锁不变。
Agent 与 Desktop 独立发布，Agent 不替代 Desktop Latest。

原生客户端的远程 coordinator、托管标准 Node 交付整合、Continue/OpenCode
Ask 内置 MCP 映射及完整跨平台安装包验收仍有缺口，见
[原生客户端进度](../features/assistant-workbar/progress.md#2026-09-27-local-native-client-validation)。
本次说明明确标为本地预览，不将这些未完成部分宣称为已提供能力。
