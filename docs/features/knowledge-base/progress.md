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

2026-09-09 外部知识库适配基础验证：

- 使用本机未入库的测试配置累计执行 107 次只读请求，其中更新后的最终归档脚本执行 19 次；脚本
  调试产生的结果只写入批准的临时目录。三套目录、FastGPT 详情和 RAGFlow 详情均成功；
  Dify `0.15.8` 详情 GET 返回 405，Dify `1.17.0` 详情 GET 返回 200。验证过程未输出 API
  Key、知识库名称和业务正文。
- Dify 响应头确认两个版本为 `0.15.8` 和 `1.17.0`。1.17 默认与显式当前配置检索均返回
  3 条非空结果，已验证 `segment/document` 字段；详情新增 Metadata、多模态、摘要索引和
  Pipeline 能力字段。FastGPT 与 RAGFlow 响应未提供产品版本。实测还确认
  FastGPT 列表 `data` 为直接数组、结果 `a` 可缺失，RAGFlow 文档名字段为
  `document_keyword`。详细基线见[外部知识库技术设计 9.0 节](./external-knowledge-technical-design.md#90-真实实例验证基线)。
- 新增 `scripts/external-knowledge-probe.mjs`，可重复生成
  不含地址、凭据、远端 ID、名称、查询和正文的能力报告。最终报告归档在
  [`external-knowledge-probe-baseline.json`](./external-knowledge-probe-baseline.json)。
- FastGPT 的 embedding、fullTextRecall、mixedRecall 和 mixedRecall + Rerank 均返回非空
  结果。RAGFlow 当前 28 个库中 17 个配置 GraphRAG、15 个存在完成证据；已完成库在基础
  检索为零结果时，图谱检索返回 1 条结果。当前没有库提供 Knowledge Compilation 配置证据。
- 新增 `src/main/knowledge/external/external-knowledge-client.ts`，固定实现三种 Provider 的
  只读目录和检索端点、地址规范化、超时、响应大小限制、HTTP 错误分类和结果标准化。
- `npx vitest run src/main/knowledge/external/external-knowledge-client.test.ts`：1 个测试文件、
  5 项测试通过。
- `npx vitest run tests/external-knowledge-probe-report.test.ts src/main/knowledge/external/external-knowledge-client.test.ts`：
  2 个测试文件、7 项测试通过；覆盖归档报告脱敏、只读操作和特色能力证据。
- `npx eslint src/main/knowledge/external/external-knowledge-client.ts src/main/knowledge/external/external-knowledge-client.test.ts`：通过。
- `npm run typecheck`：被当前工作区已有的 `src/main/ipc.test.ts:7694` tuple 类型错误阻断；
  新增适配器、探测脚本和报告测试的定向测试与 ESLint 已通过。
- 当前 Node 测试环境设置了 `NODE_TLS_REJECT_UNAUTHORIZED=0`，Dify 和 FastGPT 请求实际
  使用了放宽的 TLS 校验。产品接入不能继承该进程级默认，保存或测试实例时仍需按技术设计
  明确处理传输风险。

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

- 外部 Dify、FastGPT 和 RAGFlow 已完成 Main 适配基础；实例凭据持久化、绑定迁移、IPC、
  Renderer 管理界面、`retrieveMany`、聊天预检索和 MCP 网关仍未接入，当前不能由用户使用。
- 扫描 PDF 的真实 OCR 验收依赖用户已安装并校验的 OCR 模型；本次 DOCX/PDF 回归覆盖
  原生文本 PDF，不宣称覆盖扫描件 OCR。
- PDF.js 在测试环境会提示未配置 `standardFontDataUrl`；文本、页码定位与检索结果不受
  影响。
