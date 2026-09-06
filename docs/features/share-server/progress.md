# ShareServer 实施进度

## 当前状态

ShareServer 已进入可运行交互原型阶段。当前实现用于验证完整控制台信息架构、视觉方向与操作
流程，不提供生产身份、组织隔离、设备连接、授权、任务路由或数据持久化。

### 2026-09-06：桌面发布与测试边界

ShareServer 功能尚未完成，不属于本次 Desktop `0.12.5` / Agent `0.11.19`
的产品交付或发布验收范围。用户确认本次发布不需要单独测试 ShareServer，
其原型测试通过也不代表生产功能已完成。

桌面端根测试配置排除 `shareserver/**`，桌面发布 CI 不为其单独安装测试依赖。
ShareServer 独立项目自身的测试配置保留，供后续功能开发使用；本次不运行其独立测试。
此前候选 `89a81dd` 临时加入的 `npm ci --prefix shareserver` 步骤已撤除。

ShareServer 的实现与验证在后续功能开发中单独推进；真实 Desktop 集成验收仍属于
下文的剩余生产工作。

## 已验证实现

### 2026-09-05：全控制台交互原型

- `shareserver/` 是独立 Node.js/TypeScript 项目，不依赖 Electron Main 或
  `src/shared`。
- Hono 同源提供健康、就绪、原型快照和无持久化操作确认 API。
- 管理控制台覆盖概览、组织与成员、设备、能力目录、权限策略、审批、发布与更新、网关联邦、
  任务与中继、审计和系统设置。
- 成员自助覆盖自己的设备、授权和申请；角色切换后导航和 URL 范围同步变化。
- 控制台支持深浅主题、组织范围、全局搜索、列表搜索、状态筛选、详情、表单、确认、成功/
  失败反馈、响应式侧栏和键盘对话框。
- 构建后的 Web 由 Hono 同源托管；`Dockerfile` 使用多阶段构建和非 root 运行用户。
- readiness 明确返回 `interactive-prototype` 与 `productionReady=false`，避免把 fixture
  误认为生产服务。

验证证据：

```text
cd shareserver
npm test        # 2 files, 5 tests passed
npm run lint    # passed
npm run build   # typecheck + Vite Web + server TypeScript passed
```

浏览器实际验收：

- 生产构建在 `http://127.0.0.1:8787` 启动并成功加载 API 快照。
- 宽屏管理员概览、审批详情、批准确认和原型 API 提交流程通过。
- `390 × 844` 成员自助页面、筛选区和列表布局通过。
- 深色与浅色审批页的 WCAG 2 A/AA 自动检查均为 0 个确定违规；半透明侧栏被检查器列为
  需人工判断项，已通过实际截图复核文字可读性。
- 仓库级 `npm test` 通过 325 个测试文件、3501 个测试，另有 8 个文件和 55 个测试按既有
  条件跳过；仓库级 `npm run typecheck` 与 `npm run lint` 通过。

## 剩余生产工作

按技术设计从以下纵向切片开始，不能把原型 fixture 逐步演变为权威状态：

1. FR-1 一次性初始化、本地管理员身份、Web session 和 CSRF。
2. PostgreSQL migration、实例/组织/成员表、强制 organization repository 作用域和事务审计。
3. 真实组织与成员管理 API，再将对应原型页面切换到权威数据。
4. 设备挑战注册、凭据和出站 WebSocket 连接。
5. Publication、目录、拒绝优先策略、审批和任务路由。
6. Package、可选中继、联邦、保留、导出、备份恢复和真实 Desktop 端到端验证。

当前尚未满足 PRD 的产品验收，也未进行真实 Desktop/ShareServer 集成测试。

2026-09-05 PRD `FR-13` 新增组织数字人发布和 `@数字人` 调用。当前交互原型尚无“数字人”
目录、发布管理、提及选择器或 Agent 记忆边界展示，因此这些能力仍属于剩余生产与原型工作，
不能由现有通用能力目录或原型操作确认替代。
