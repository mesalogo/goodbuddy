# 浮层审查修复记录

日期：2026-09-27。本阶段处理全局样式审查中的五项浮层问题。既有 MCP 子 Modal 修复和
[共享控件阶段](shared-controls-review-2026-09-27.md)保持原实现，菜单危险色覆盖未重复修改。

## 修复与验证

| 入口与问题 | 实现 | 实际验证 |
| --- | --- | --- |
| 附件解析结果打开大图，图片被父遮罩盖住 | 图片遮罩复用 `--z-dialog`；解析正文及图片回调保持稳定，关闭后原触发节点仍在 | 完整 App、浅深主题；读取窗口合成截图中大图中心红色像素，检查父层 inert，Escape 返回图片入口，再关闭解析层 |
| 同行帮助被原生浏览器盖住 | 共享 occlusion selector 增加 tooltip，内容矩形沿用相交检测及 ResizeObserver | 运行记录页真实 InlineHelp；1600px 窗口与工作栏最小宽度下不相交，1000px 窗口重开工作栏并调至最大宽度后相交；检查真实 WebContentsView 隐藏/恢复，实例 ID 与页面内标记不变 |
| HTML 全屏无法键盘进入 iframe | iframe 加入共享焦点候选，显式进入及返回守卫；内部 Escape 使用受限窗口通知 | 完整 App、生产 Main/Preload；带链接预览正反向进入/返回及内部 Escape，纯正文进入、PageDown 和内部 Escape；保留空 sandbox 与禁脚本 CSP |
| 窄侧栏项目 Modal 的 Escape 同时关闭两层 | ProjectSwitcher 接入 `activateModalFocus`，忽略已处理或被隔离弹层的按键 | 760px 窗口侧栏中新建项目，一次 Escape 仅关闭项目且焦点回到项目入口，第二次才关闭侧栏 |
| 知识引用遮罩仍是原生拖动区域 | 加入共享 no-drag；自动发现测试按 fixed/inset 扫描，覆盖 `-dialog` 类名 | 完整 App 点击知识引用；Windows 原生命中返回 HTCLIENT，临时清除 no-drag 的对照返回 HTCAPTION |

解析大图路径另暴露了焦点恢复问题：ReactMarkdown 的图片组件在 App Context 更新时被
重建。稳定 `SectionContent` 与图片页签回调后，返回焦点断言通过，没有改为聚焦无关按钮。

HTML 键盘桥只转发主窗口直接 srcdoc 子 frame 的 Escape keyDown。窗口级单测另检查
主 frame、普通网页、间接子 frame、Tab、keyUp 不转发，以及监听释放后不再发送。
它不为预览授予 scripts、same-origin、forms 或 navigation 权限。技术接线由
[HTML 渲染技术设计](../features/conversation-html-rendering/technical-design.md#ui-与无障碍)维护。

## 测试组织

真实路径位于 [overlay-paths-main.ts](../../tests/support/overlay-paths-main.ts)，由
[overlay-layering.electron.test.ts](../../tests/overlay-layering.electron.test.ts)启动。App、
preload、窗口事件 IPC、BrowserService 及 viewport 调用使用生产实现；解析结果及图片是
受控数据，其他无关启动服务使用 fixture。测试使用独立 profile/SQLite 和本地 HTTP 网页，
不启动模型，模型请求尝试为 0。

设置 `GB_OVERLAY_PATHS_ARTIFACTS` 可保留浅深大图、两种帮助布局的 PNG 与结果 JSON。
原生命中在 Windows 使用 WM_NCHITTEST；其他平台只执行其余行为和 computed no-drag 检查。
测试启动器退出后删除隔离 profile 和构建目录。

此前漏测的原因分别是：只检查 Modal DOM 存在、原生遮挡用例未枚举 tooltip、HTML 用例
未用真实 Tab 穿越 frame、项目和侧栏单独测试，以及遮罩自动发现依赖类名后缀。本次回归
对应加入组合路径与原生断言。

## 验证边界

本机验证为 Windows、Electron 43.2.0，DPR 1。未把解析 fixture 当作真实 OCR 验收；未执行
macOS/Linux 原生输入、全页面缩放矩阵；本阶段之后的全仓结果见
[最终验证汇总](responsive-controls-review-2026-09-27.md#全部样式修复最终验证)。

已执行的定向回归：

- Renderer 共享控件、浮层、浏览器租约、Markdown、ProjectSwitcher、DocumentResultPreview 及窗口事件：9 文件、176 项通过。
- Main IPC、窗口事件、Preload sandbox 及画布 IPC：4 文件、197 项通过，1 项原有跳过。旧 WebContents fixture 补充了事件订阅/移除方法，没有给生产代码添加 mock 专用兼容分支。
- App Modal 与侧栏筛选：分别 4 项和 15 项通过，其余由名称筛选排除。
- `tests/overlay-layering.electron.test.ts`：3 项通过，包含原有菜单/通知、MCP 完整 App 以及本阶段五条路径。MCP 保留四个浅深/短窗口/浏览器场景及生产保存重读断言。
- `tests/shared-controls.electron.test.ts`、`tests/inline-help.electron.test.ts`、`tests/magic-notes-capture.electron.test.ts`：通过，保留前一阶段 338 组 computed style 与危险按钮回归。
- 最终调整项目初始焦点与 iframe 事件归属断言后，`MarkdownRenderer.test.tsx`、`ProjectSwitcher.test.tsx`、`window-ipc.test.ts` 共 53 项通过；整个 overlay Electron 文件再次 3 项通过。
- `npm run typecheck`、`npm run lint`、`git diff --check`：通过。新增质量记录中文审校无阻断项；键盘事件枚举保留为技术测试条件。

最终测试已通过 `GB_OVERLAY_PATHS_ARTIFACTS` 导出 PNG 与结果 JSON，并人工查看浅深图片
Modal 和帮助相交截图。浏览器可见性以 Main 中实际 WebContentsView 状态为准，Renderer
截图不作为原生视图已隐藏的替代证据。

扩大验证曾发现窗口先销毁再执行 IPC dispose 的清理错误，已改为使用注册时捕获的
WebContents 引用，单测及 MCP Electron 复跑通过。测试脚本也修正了异步窗口尺寸/工作栏
展开的等待条件和旧 fixture 接口，未放宽像素、焦点、命中或浏览器可见性断言。
