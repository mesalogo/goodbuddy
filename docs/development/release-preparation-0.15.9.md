# Desktop 0.15.9 / Agent 0.15.3 发布准备

日期：2026-10-03。Desktop 基线 `v0.15.8`，源码
`50481deaa1f7d17184500bb6f5abb3e1a0c8bbd5`，37 个提交、163 个文件。
检查时工作区干净，范围仅为已提交实现与必要发布准备。
标准六平台 Desktop、三平台 Agent，不含 LoongArch。

## 范围与边界

- 监督共享时间线、故事归属与人工调整、经验抽取、故事回顾与心跳建议；
  平铺与时间螺旋、紧凑图谱控件及 WebGL 生命周期修复。
- schema 53～56：合并既有进度，增加故事、经验及建议类型，保留历史结果。
  旧数据库副本验证和模型质量抽查见[监督进度](../features/conversation-supervision/progress.md)，
  不将 schema 53 的单库耗时当作本轮完整迁移保证。
- 会话外部存储、侧栏和消息窗口化、Markdown 缓存、只读 Worker、活动差量写入、
  远程事件 checkpoint 批次持久化；保留丢失焦点、滚动、去重与提交顺序检查。
- Execute 配置工具不再重复弹原生确认，Ask 只读边界不变。
- Electron 44.5.1；Node、OpenCode、Continue 锁不变。
- Agent 虽无守护进程文件变更，但打包的 Story Graph 工具 schema 增加 story/experience，
  旧 Agent 不支持这些输入，因此升级 0.15.3，最低 Desktop 0.15.9。

性能范围及暂缓项见[性能计划](../roadmap/product-performance-experience-improvement-plan.md)。
不把组件或特定机器的指标作为普遍提速保证；向量仍可全表扫描，Worker 失效会同步回退，
窗口化的未挂载行不支持页内查找，快速滚动可能短暂显示占位。
故事、经验、建议与输出重试有模型费用，自动结果须人工核对。

## 本轮真实 Host 验证

当前源码临时打包到隔离测试目录，不构建生产安装包。使用现有固定 Host 身份及
凭据存储，通过生产 Agent Attach、模型桥及远程 ACP 路径执行 OpenCode 与 Continue
各一次 Ask、一次 Execute。OpenCode 探针显式选择既有 Continue 模型配置，
不修改产品设置，也不是产品静默降级。

共 **4 次真实提供方请求，4 次 HTTP 200**，无模拟推理、无自动请求重试。
验证 Runtime 释放后重建、历史恢复和本轮进程清零。
每次消费真实远程语义流，通过生产 `RemoteEventBatcher` 与
`AssistantDatabase.appendRemoteTaskEventsOnce` 在 checkpoint 前落库；
对完整已提交事件再次写入均返回已存在。四次请求分别记录：

| Runtime / 模式 | 批次 | 事件 | checkpoint |
| --- | ---: | ---: | ---: |
| OpenCode Ask | 3 | 4 | 2 |
| OpenCode Execute | 21 | 40 | 20 |
| Continue Ask | 3 | 4 | 2 |
| Continue Execute | 23 | 44 | 22 |

验证没有启动完整 Renderer，也不声称覆盖会话消息投影的所有恢复分支。
Story Graph 新对象与来源语义由本轮源码测试及开发记录覆盖，以上四次请求不调用图谱工具。
开发文档中的模型调用不计入本轮 4 次。临时探针的两次编译钩子定位失败均发生在请求之前。

## 发布门槛

按用户要求，不执行本地测试套件、lint、类型检查或生产打包；
精确候选推送双远端后由 CI 做全量验证和生产构建，再打不可变双版本标签。
中英文 FEATURES 需同步共享进度、已实现故事经验、成本和窗口化限制。
公开核验 Desktop Latest、标准产物、Agent 签名目录、两个源及网站，保留任何并行未提交工作。
