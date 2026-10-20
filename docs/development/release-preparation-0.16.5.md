# Desktop 0.16.5 / Agent 0.15.7 发布准备

基线：Desktop `v0.16.4`、Agent `agent-v0.15.6`。产品源码基于 `889e6879`，
该提交已通过 Desktop 主分支验证及生产构建。

- 用户已批准双语说明，分别写入 `resources/release-notes.json` 和
  `resources/agent-release-notes/0.15.7.md`。
- 飞书与企业微信按预览版发布；不构建或发布 LoongArch。
- schema 63 → 65；应用设置迁移保留自定义工具路径，将旧 managed 选择改为 auto。
- 两份 FEATURES 已更新当前配套版本、能力、预览边界及剩余验收。
- Agent 包含远程图片分页读取和模型桥接 413 提示改动。
- 既有共享 Linux Host 记录覆盖源码工作区处理器的 SSH stdio 验证，不等同于安装版
  Agent 完整二进制传输验证；该边界不得标记为已完成。
- 候选元数据校验、精确候选 CI、最终提交批准、原生打包和公开核验尚待完成。
- 不移动、删除或重建任何已有标签。
