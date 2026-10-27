# 编辑消息并重新回复

用户编辑已发送的用户消息，系统从该位置创建独立会话分支并重新回复。原会话完整保留。

- [产品需求](prd.md)：范围、功能要求和验收标准。
- [用户故事](user-stories.md)：正常使用、失败恢复和边界场景。
- [行为规则](logic-design.md)：分叉边界、上下文和状态转换。
- [界面设计](ui-design.md)：编辑、提交、反馈和键盘操作。
- [技术设计](technical-design.md)：存储、引用、发送和验证。
- [实施进度](progress.md)：已验证事实及剩余工作。

“编辑点”指用户选择的原消息；“历史前缀”指编辑点之前的消息，不包含编辑点。“分支”仍是普通会话，拥有独立 ID，可继续交流和删除。

依赖：[性能原则](../../architecture/performance-principles.md)、[存储维护约束](../../development/agent-feature-maintenance.md)、[监督回顾](../conversation-supervision/README.md)。
