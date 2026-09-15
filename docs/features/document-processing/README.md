# 文档处理

文档处理负责聊天附件和知识库导入中的文本提取、格式转换与本地 OCR。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [文档解析与本地 OCR PRD](./prd.md) | 产品范围、解析策略、OCR 模型管理和验收 |
| [聊天附件技术说明](./chat-attachments-technical-design.md) | 文件选择与粘贴的进程链路、IPC、PPTX 图片 OCR、Worker 生命周期和验证证据 |

当前尚无独立 User Stories、功能逻辑、UI 和进度文档；聊天输入区交互遵循根目录
[UI 设计系统](../../../UI-DESIGN.md)。

Office 文件的浏览器内人工编辑、AI 选区修改、保存和撤销不属于文档解析职责，由
[Office 协同编辑](../office-document-editing/README.md)负责。文档处理仍负责内容提取、OCR、
旧格式转换和供模型消费的统一结构。
