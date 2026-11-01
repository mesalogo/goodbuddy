# System One 决策模型功能进度

## 2026-11-01

- 已核实 TypeSafe 和 Ollama 的 System One 接口结构。
- 已使用 `http://10.7.0.152:11434/v1/systemone` 和模型 `d3` 完成一次真实 `noul` 请求，返回 HTTP 200。
- 已确定首期产品范围为协议支持和角色选择用途。
- 已增加 `system-one` 模型协议、请求和响应契约。
- 已增加 Main 侧 System One 请求服务，支持无认证、Bearer API Key、超时和取消信号。
- 已复用设置页现有“保存并测试模型”入口，System One 连接测试会向 `/v1/systemone` 发起最小真实决策请求。
- 已增加运行设置中的角色选择模型引用，以及设置页的 System One 协议和角色选择开关。
- 已把角色选择接入会话自动路由；手动角色优先，决策结果无效或不确定时回退现有关键词路由和默认角色。
- 已将角色选择从 Renderer 的 `smartRouting` 标志中解耦。只要配置了角色选择模型，Main 会在普通会话执行前统一调用 System One；当前使用的本地模型、OpenCode、Continue 或远程 Agent 只负责后续执行。
- 已用真实 Ollama `choice` 请求验证 `d3`：模型选择 `customer-service` 的概率为 `0.9994674116490616`，confidence 为 `0.9956858350963631`，HTTP 200。
- 已用生产角色选择函数连接同一 Ollama 服务完成实时测试，`customer-service` 角色选择测试通过。
- 已增加可选的实时测试 `system-one-role-selector.live.test.ts`，设置 `GOODBUDDY_SYSTEM_ONE_LIVE=1` 后执行。
- 完整仓库测试仍受已有长时间 desktop storage 和 OpenCode 隔离测试影响，相关运行证据见开发会话记录；本功能的类型、lint、设置、配置、服务和角色路由测试已通过。
