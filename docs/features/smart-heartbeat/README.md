# Smart Heartbeat

Smart Heartbeat 已提供按计划或手动执行的有界回顾，生成报告及后续建议。应用默认关闭；启用及计划条件见[应用启停与执行](../conversation-supervision/logic-design.md#应用启停与执行)。条件或事件唤醒仍需后续设计。

现有入口已升级为“监督者”，智能心跳作为其定期唤醒机制，驱动检查与整理；应用内部提供工作回顾和故事线图谱。定义见[监督者应用产品设计](../conversation-supervision/supervisor-prd.md)，实施方案见[监督者技术设计](../conversation-supervision/technical-design.md)。现有计划和范围保留，监督调用继续禁止工具执行。

自动报告及监督回顾分别按来源版本和已读位置处理增量；没有待处理输入时记录无变化，跳过模型及新报告。手动历史重看和删除报告的边界见[自动增量规则](../conversation-supervision/logic-design.md#自动增量与手动重看)。

## 文档导航

监督者“活动”页签同时显示手动回顾和心跳执行，将新心跳报告与下游监督按运行 ID 合并，保留各阶段真实状态。原设置中的报告与记录继续读取心跳报告自身状态；完整执行状态以[活动规则](../conversation-supervision/logic-design.md#活动记录)为准。

| 文档 | 权威职责 |
| --- | --- |
| [智能心跳 PRD](./prd.md) | 用户目标、范围、计划、运行和产品验收 |

当前尚无独立 User Stories、功能逻辑、UI、技术设计和进度文档。
