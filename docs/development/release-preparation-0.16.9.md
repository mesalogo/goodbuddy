# Desktop 0.16.9 / Agent 0.15.8 发布准备

基线 Desktop `v0.16.8` / Agent `agent-v0.15.7`；
产品范围为 `122836c3`、`6e12c4cd`、`329abd2a`。

- 用户已批准 Desktop 和 Agent 双语说明及配套版本；不构建/发布 LoongArch。
- OpenCode 1.19.3，DeepSeek Harness 0.2.1-rc.2，Continue 1.5.47。
- 远程 Continue helper、共享 adapter 和 OpenCode 插件有生产改动，
  不能以 Desktop 升级代替 Agent 更新。
- 不新增 schema，保持 65；飞书和企业微信保持预览版。
- 两份 FEATURES 已核对更新，Factory Droid 仅文档/探针，不列为已接入产品。
- 真实 Windows 进程与共享 Linux Host 当前源码取消证据见
  [取消修复验证](../agent-runtime/validation/cancellation-fixes-2026-10-23.md)。
  不将该证据扩大为完整 UI/安装包或全仓全绿结论。
- 按用户此前要求由精确候选 CI 执行全量测试、类型检查、lint 和生产构建，
  不执行本地生产打包。已知全量测试中断和失败记录须由本轮 CI 重新检验。
- 发布前仍需精确提交批准及 CI；发布后核验 Desktop 六平台、Agent 三平台、
  签名公证、公开资产/索引及独立 Latest 状态。
