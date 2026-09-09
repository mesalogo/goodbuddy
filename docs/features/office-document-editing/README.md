# Office 协同编辑

Office 协同编辑通过 ShareServer 集成 ONLYOFFICE Docs，使 GoodBuddy Desktop 可以在助手
工作栏中打开多个文档页签，并在同一编辑器中完成人工编辑、AI 选区修改、保存、撤销和冲突处理。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [Office 协同编辑 PRD](./prd.md) | 用户问题、产品范围、功能要求和验收标准 |
| [用户故事](./user-stories.md) | 打开、多页签、保存、AI 编辑、冲突和恢复场景 |
| [功能逻辑设计](./logic-design.md) | 文档会话、保存、冲突、断线和关闭规则 |
| [界面设计](./ui-design.md) | 工作栏多实例文档页签、编辑状态和响应式行为 |
| [技术设计](./technical-design.md) | Desktop、ShareServer、ONLYOFFICE 的边界、协议、安全与实施顺序 |

## 术语

- **文档页签**：助手工作栏中的多实例应用页签，标题来自文档文件名。
- **编辑会话**：一个文档页签对应的服务端短期会话和 Desktop 本地状态。
- **源文件**：用户明确打开的本机或托管 SSH 工作区文件。
- **工作副本**：编辑期间由 ShareServer 管理并提供给 ONLYOFFICE 的临时版本。
- **保存检查点**：ONLYOFFICE 已提交给 ShareServer、但不一定已经回写源文件的稳定版本。

文档解析、OCR 和旧格式转换继续由[文档处理](../document-processing/README.md)负责。ShareServer
的组织、服务部署和运维由独立仓库的 ShareServer 文档负责；跨端身份、传输和审计共同规则见
[共享网络总体设计](../../architecture/share-network-architecture.md)。

当前功能仍处于设计阶段，尚无可验证实现，因此不建立进度文档。开始实施后再新增
`progress.md`，只记录实际完成范围和验证证据。
