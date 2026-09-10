# 图片上下文验证记录

## 2026-09-10

- 已接线桌面会话成果引用 → Main 已存图片 → Images 编辑，并复用文字历史。
- 已增加消息底部的能力缺失提示及 SQLite metadata 持久化，无新增表或服务端会话状态。
- 图片上下文专项测试 20 项通过；IPC 成果引用和提示透传专项测试通过。
- Renderer 现有生图测试扩展为验证纯图片消息后的追问及提示；消息组件验证提示不产生
  alert 或 live region；数据库回归验证提示 metadata 保存。
- Windows 隔离桌面实例通过真实发送按钮调用用户指定的 `sub-gpt-image-2`：
  首次生成红圆和绿方块；不重新附图即可把圆改蓝；终止并重开整个测试 Electron 进程后，
  再次不附图即可保留蓝圆并把方块改黄。实际路由依次为 generations、edits、edits，
  三次均 HTTP 200，图片颜色和成果恢复已检查，正常续接不出现能力缺失提示。
- 在同一个测试实例的请求边界注入一次明确的编辑 HTTP 405，验证生产 Runtime 自动发出
  一次真实 generations 请求并成功生成第四张图片。消息底部提示未使用参考图片，没有
  错误状态、alert 或 live region；重新加载会话后提示仍然保留。这是缺失能力的模拟场景，
  不表示实测的 `sub-gpt-image-2` 上游缺少编辑能力。
- 本次实现验收共 4 次真实图片请求、0 次真实文本请求；另有 1 次本地模拟的编辑拒绝。
  此前接口研究阶段的 8 次请求不计入这 4 次。
- 当前源码通过 electron-vite 开发版 Main/Preload 构建及真实 Renderer 链路；本次没有
  修改生产构建配置，未运行发布打包或独立生产构建。
- `npm run typecheck`、`npm run lint` 通过；新文档 7 个本地链接检查通过。
- `npm test`：3896 passed、66 skipped、2 failed。失败项为 `App.test.tsx` 中
  `switches immediately to a managed SSH project and shows only supported OpenCode choices`
  和 `shows one configured choice per Agent Runtime in a flat keyboard menu`，对应工作区
  中并行 Runtime 菜单变更的选项数量断言，单独复测仍失败；不在本次图片修复中改写。
  图片专项、IPC、消息组件和数据库相关测试通过，图片 App 专项也已独立复测通过。
