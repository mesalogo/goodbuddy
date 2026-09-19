# 本轮文档处理改动文件

本清单只列文档处理实施涉及的文件。工作区内并行的魔法笔记、画布及其测试改动不计入本轮；
共享文件中的并行改动保持原样，未提交或推送。

## Main

```text
src/main/assistant/assistant-database.ts
src/main/context-manager.ts
src/main/context-manager.test.ts
src/main/conversation-attachment-storage.ts
src/main/conversation-attachment-storage.test.ts
src/main/document-parsing-service.ts
src/main/document-parsing-service.test.ts
src/main/document-parsing-settings-store.ts
src/main/document-parsing-settings-store.test.ts
src/main/document-result-storage.ts
src/main/http-document-ocr.ts
src/main/http-document-ocr.test.ts
src/main/http-document-ocr.integration.test.ts
src/main/render-ocr-pdf.ts
src/main/index.ts
src/main/ipc.ts
src/main/ipc.test.ts
src/main/knowledge/document-parser.ts
src/main/knowledge/knowledge-database.ts
src/main/knowledge/knowledge-database.test.ts
src/main/knowledge/knowledge-service.ts
src/main/knowledge/external/external-knowledge-service.test.ts
```

## Shared 与 Preload

```text
src/shared/attachment-limits.ts
src/shared/assistant-contracts.ts
src/shared/contracts.ts
src/shared/document-parsing-contracts.ts
src/shared/document-result-contracts.ts
src/shared/ipc-channels.ts
src/shared/local-inference-contracts.ts
src/preload/index.ts
src/preload/preload-sandbox.test.ts
```

## Renderer

```text
src/renderer/src/App.tsx
src/renderer/src/App.test.tsx
src/renderer/src/AttachmentActions.tsx
src/renderer/src/AttachmentActions.test.tsx
src/renderer/src/AttachmentCapabilityNotice.tsx
src/renderer/src/AttachmentResultButton.tsx
src/renderer/src/ChatTimeline.tsx
src/renderer/src/ConversationInputQueue.tsx
src/renderer/src/DocumentConversationContext.ts
src/renderer/src/DocumentParsingSettingsSection.tsx
src/renderer/src/DocumentParsingSettingsSection.test.tsx
src/renderer/src/DocumentResultPreview.tsx
src/renderer/src/DocumentResultPreview.test.tsx
src/renderer/src/HttpOcrSettings.tsx
src/renderer/src/KnowledgeWorkspace.tsx
src/renderer/src/LocalInferencePage.tsx
src/renderer/src/PendingDocumentImports.tsx
src/renderer/src/QueuedAttachmentsDialog.tsx
src/renderer/src/SettingsPanel.tsx
src/renderer/src/styles.css
src/renderer/src/i18n/locales/en-US/app.ts
src/renderer/src/i18n/locales/zh-CN/app.ts
```

## 脚本与文档

```text
tests/attachment-layout.electron.test.ts
tests/support/attachment-layout-regression.tsx
scripts/document-parsing-production-probe.ts
scripts/document-table-fixture.mjs
FEATURES.md
FEATURES.zh-CN.md
UI-DESIGN.md
docs/features/application-tool-navigation/ui-design.md
docs/features/document-processing/README.md
docs/features/document-processing/prd.md
docs/features/document-processing/user-stories.md
docs/features/document-processing/logic-design.md
docs/features/document-processing/ui-design.md
docs/features/document-processing/http-paddleocr-vl-technical-design.md
docs/features/document-processing/chat-attachments-technical-design.md
docs/features/document-processing/implementation.md
docs/features/document-processing/progress.md
docs/features/document-processing/changed-paths.md
```

`scripts/paddleocr-vl-probe.mjs` 和导航 README 原有未提交内容保留，本轮未修改。
临时 Electron 驱动、隔离构建、合成文件和原始报告未加入产品源码，证据目录索引见进度文档。
