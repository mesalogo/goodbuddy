# System One 决策模型功能进度

## 2026-11-03

- 定位并修复实际设置读取缺陷：`getPolicySettings()` 原先漏返 `roleSelectionModelProfileId`，导致 Main 始终跳过已绑定的决策模型。补齐字段，不改变角色路由总开关语义。
- 新增真实设置文件保存、重新加载、策略读取回归（总开关开启／关闭各一例）：修复前均因缺少绑定字段失败，修复后通过，且策略读取不解密凭据。设置存储与 IPC 合计 334 passed、1 skipped；类型检查与 lint 通过。本轮未进行外部模型调用或安装包更新。

- 修正总开关语义：角色路由关闭时，保留 d3 绑定但不执行自动路由；Renderer 隐藏自动标记。设置用途旁提示“启用角色路由后生效”。
- 总开关与回退定向测试 7 passed；完整类型检查通过。没有修改远端执行实现，角色路由仍在桌面 Main 的公共前置入口执行；本轮未做真实远端或安装版验收。
- IPC、设置页和 Composer 回归：362 passed，1 skipped；lint 通过。包含整个 App 测试文件的组合运行超过 60 秒未完成，App 本轮仅定向用例已验证。设置提示增加后保留开关原有无障碍名称。

- 专家入口文案缩短为“自动 · d3”；本条回复的选择过程与结果位于 GoodBuddy 下方角色行。
- 补齐纯关键词路由未命中的事件反馈，保留 System One 回退未命中时的原始失败状态。
- 定向 IPC、Composer、ChatTimeline、事件处理测试：294 passed，1 skipped；App 选择过程定向用例：1 passed。完整类型检查、lint 与 diff 检查通过。
- 全量 `npm test` 在本轮 60 秒执行窗口内未结束，被工具终止；不能记为全量通过。
- 本轮没有调用外部模型，没有验证安装版 Electron 的真实会话。当前运行进程来自安装目录，源码修改不会更新该安装目录；不可把源码测试通过视为安装版已生效。

## 2026-11-01

- 已核实 TypeSafe 和 Ollama 的 System One 接口结构。
- 已使用 `http://10.7.0.152:11434/v1/systemone` 和模型 `d3` 完成一次真实 `noul` 请求，返回 HTTP 200。
- 已确定首期产品范围为协议支持和角色选择用途。
- 已增加 `system-one` 模型协议、请求和响应契约。
- 已增加 Main 侧 System One 请求服务，支持无认证、Bearer API Key、超时和取消信号。
- 已复用设置页现有“保存并测试模型”入口，System One 连接测试会向 `/v1/systemone` 发起最小真实决策请求。
- 已增加运行设置中的角色选择模型引用，以及设置页的 System One 协议和角色选择开关。
- 已把角色选择接入会话自动路由；手动角色优先，决策结果无效或不确定时回退现有关键词路由和默认角色。
- 已将角色选择从 Renderer 的 `smartRouting` 标志中解耦。Main 在普通会话执行前统一路由；自动路由须先开启总开关（2026-11-03 修正），配置了选择模型后优先使用 System One。各 Runtime 负责后续执行。
- 已用真实 Ollama `choice` 请求验证 `d3`：模型选择 `customer-service` 的概率为 `0.9994674116490616`，confidence 为 `0.9956858350963631`，HTTP 200。
- 已用生产角色选择函数连接同一 Ollama 服务完成实时测试，`customer-service` 角色选择测试通过。
- 已增加可选的实时测试 `system-one-role-selector.live.test.ts`，设置 `GOODBUDDY_SYSTEM_ONE_LIVE=1` 后执行。
- 完整仓库测试仍受已有长时间 desktop storage 和 OpenCode 隔离测试影响，相关运行证据见开发会话记录；本功能的类型、lint、设置、配置、服务和角色路由测试已通过。
