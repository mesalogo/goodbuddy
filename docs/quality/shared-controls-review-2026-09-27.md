# 共享控件审查修复记录

日期：2026-09-27。范围为全局样式审查第一阶段，包含原审查六项、会话菜单危险按钮覆盖及
深色主按钮 hover 对比度。原有 MCP 子 Modal 修复保留，本阶段没有改动其组件或业务逻辑。

## 修复范围

| 问题与触发位置 | 共享修复 | 验证 |
| --- | --- | --- |
| 深色设置输入框、次按钮边框被兜底规则覆盖 | 删除通用输入覆盖及次按钮边框覆盖，使用主题 `--border-control` | 设置容器和 body Portal 读取最终边框；输入边框与实际背景至少 3:1 |
| `.field` 与浏览器地址框丢失焦点环；Radio 被拉高 | 文本字段规则排除 Checkbox/Radio，删除局部 outline 清除和未定义 `--focus-ring` 引用 | 原生 Tab 后轮廓为 2px 强调色；Switch 为 38×22px，Checkbox/Radio 为 15×15px |
| 图标按钮、分段控件禁用后仍像可操作 | 共享禁用透明度和光标；普通图标 hover 排除禁用项 | 禁用时光标为 not-allowed，透明度降低，hover 不恢复可用颜色 |
| Continue 删除图标丢失危险颜色 | 普通图标 hover 排除危险修饰类，移除深色普通图标覆盖 | 组合类及实际 Continue 删除按钮在两种主题下保留危险前景和悬停背景 |
| Continue Rule/Prompt 输入回退原生样式 | 五个独立文本字段使用 `.field-control`，复用原表单规则 | 实际组件字段使用共享边框、字体、内边距和至少 38px 高度，并保留键盘焦点 |
| 默认 PageTabs hover 覆盖 active | hover 只作用于未选中项 | 当前项悬停前后背景及文字颜色不变 |
| 会话菜单 button 覆盖 danger-button | 会话与工作区文件菜单的通用规则降低特异性，删除多余文件菜单危险补丁 | 实际 `DestructiveConfirmActions` 从入口进入确认后保留危险实心背景、反白文字；禁用危险图标不高亮 |
| 深色主按钮 hover 白字对比度约 4.31:1 | `--accent-solid-hover` 调整为 `#1a77c5` | 白字对比度 4.68:1；令牌及真实按钮默认/hover 均检查至少 4.5:1 |

回归另发现浅色 `--border-control` 在 `--surface-subtle` 上只有约 2.90:1。
共享边框令牌由 `#7f95aa` 调整为 `#748a9f`，对白底、subtle、muted 背景分别为
3.57:1、3.35:1、3.02:1。没有按页面另设边框颜色。

实现主要位于 [styles.css](../../src/renderer/src/styles.css)；Continue 接线位于
[RuntimeCustomizationSection.tsx](../../src/renderer/src/RuntimeCustomizationSection.tsx)。
共享规范由 [UI-DESIGN.md](../../UI-DESIGN.md) 维护。

## 回归证据

[shared-controls.electron.test.ts](../../tests/shared-controls.electron.test.ts) 使用当前源码组件、
共享样式和主题函数。Continue 数据使用受控 IPC fixture，菜单使用实际
`DestructiveConfirmActions`。测试在真实 Electron/Chromium 中读取 computed style，
覆盖浅深主题、设置容器和真实 body Portal，共记录 338 组状态测量，包含 PageTabs 的
default 与 segmented 变体。焦点通过原生 Tab
进入；hover 通过 CDP 强制伪状态检查，不作为原生鼠标命中证据。模型调用为 0。

本机环境为 Windows、Electron 43.2.0、Chromium 150，内容区 1280×800，DPR 1。
已打开审阅浅深 Continue 字段及深色 Portal 的原尺寸 PNG；共享输入边框、删除图标和
焦点轮廓符合计算值。截图与完整 computed JSON 可通过 `GB_SHARED_CONTROLS_ARTIFACTS`
指定目录输出，测试专用 profile 与 Vite 缓存在退出后删除。

已执行：

- `npx vitest run tests/shared-controls.electron.test.ts tests/overlay-layering.electron.test.ts src/renderer/src/WorkspacePrimitives.test.tsx src/renderer/src/SettingsPanel.test.tsx src/renderer/src/WorkspaceFilesPanel.test.tsx`：最终 5 文件、181 项通过。
- MCP 浮层回归的 4 个场景通过：浅深主题、短窗口、原生鼠标命中与焦点循环、生产 IPC 保存及重读；有浏览器的场景保持 Modal 期间隐藏、关闭后恢复同一未刷新的网页。模型请求尝试为 0。
- `npm run typecheck` 通过；`npm run lint` 通过。

首轮新回归在对话框输入的浅色边框对比度断言失败，修正共享令牌后通过。测试启动器曾有
环境变量对象类型错误，增加 `NodeJS.ProcessEnv` 标注后类型检查通过。未放宽视觉断言。

## 剩余边界

本阶段上述八类问题已修复。共享控件测试属于组件视觉层，不证明完整 App 的全部业务入口；
MCP 原有集成回归独立验证其真实保存与浏览器隔离路径。本阶段未执行全仓测试、macOS/Linux、
强制颜色、200% 缩放及全页面四档窗口矩阵。后续全部 15 项样式修复与 MCP 的
[最终验证汇总](responsive-controls-review-2026-09-27.md#全部样式修复最终验证)记录全仓结果及剩余失败。
