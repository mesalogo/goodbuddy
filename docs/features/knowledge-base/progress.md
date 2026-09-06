# 知识库实施进度

## 已验证实现

截至 2026-09-05：

- 知识库选择按 Conversation 持久化，新对话默认空范围。
- 创建流程默认只展示名称和描述，高级存储与图谱设置折叠。
- 知识库汇总区分可检索、处理中和需处理文档。
- 文档行展示全文、向量和图谱状态，并支持打开原始来源和重新处理失败文档。
- 移除来源需要确认并说明级联影响。
- 检索高级参数默认折叠，“高级设置”提供问答效果入口。
- 向量未配置状态可直接前往模型设置。
- 有效 DOCX 与多页 PDF 已通过磁盘文件导入、解析、分块和检索生产链路。

## 验证证据

2026-09-05 最终验证：

- `npm test`：325 个测试文件、3511 项测试通过；8 个文件、55 项手动或集成测试按既有
  配置跳过。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：Electron Main、Preload、Renderer 生产构建及控制面安装包检查通过。
- `npx vitest run src/main/knowledge/knowledge-service.test.ts -t "imports real DOCX and PDF files from disk into searchable chunks"`：
  有效 Open XML DOCX 与两页原生文本 PDF 均通过生产 `KnowledgeService.importPaths`
  导入、解析、分块和全文检索。

2026-09-06 对话知识库选择补充验证：

- `App.test.tsx` 覆盖点击名称、文档数量和行本身时切换选中状态，以及空目标失焦时
  弹层不提前卸载。Windows 隔离桌面实际点击名称后选中、点击数量后取消，弹层保持打开。
- 本轮全量校验结果见[工作栏验证记录](../assistant-workbar/progress.md)；本项验证未调用模型。

## 剩余工作

- 外部 Dify、FastGPT 和 RAGFlow 知识库接入仍为规划中能力。
- 扫描 PDF 的真实 OCR 验收依赖用户已安装并校验的 OCR 模型；本次 DOCX/PDF 回归覆盖
  原生文本 PDF，不宣称覆盖扫描件 OCR。
- PDF.js 在测试环境会提示未配置 `standardFontDataUrl`；文本、页码定位与检索结果不受
  影响。
