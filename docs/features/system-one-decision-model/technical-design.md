# System One 决策模型技术设计

## 1. 边界

System One 请求由 Main 进程发出。Renderer 只提交经过共享契约校验的连接配置更新和测试请求，不持有 API Key。角色选择调用复用 Assistant 现有任务编排，不新增数据库 owner、模型队列或独立 Runtime。

## 2. 协议

协议名称为 `system-one`，请求路径为规范化基础地址下的 `/v1/systemone`。首期支持 `noul`、`choice` 和 `score`，使用非流式 JSON 请求。响应必须校验 `model`、`answers` 和 `usage`，答案按问题名称匹配。

Ollama 和 TypeSafe 使用同一请求结构。服务地址、认证方式和模型名由连接 profile 提供；Provider 的差异只保留在地址和认证配置中，不把 System One 映射为聊天协议。

## 3. 配置

运行设置新增一个可空的 `roleSelectionModelProfileId`。保存设置时要求该 ID 指向现有的 System One profile；普通聊天协议和图片协议不能成为角色选择模型。

设置更新在 Main 侧完成唯一性和协议校验。profile 删除或协议变更导致引用失效时，同时清空角色选择用途。

## 4. 角色路由

路由输入使用当前用户任务、必要的近期上下文和候选角色的路由描述。候选项使用稳定角色 ID，执行提示词不发送给决策模型。路由发生在 Main 组装 Runtime 执行请求之前，因此不依赖本次选择的 Runtime；本地模型、OpenCode、Continue 和远程 Agent 均接收同一角色提示。

调用顺序为：手动角色、会话固定角色、System One 角色选择、现有关键词智能路由、默认角色。System One 结果只产生候选角色，角色存在性、可用性和路由模式仍由 GoodBuddy 校验。

请求使用调用方的 AbortSignal。取消、超时和 Provider 错误返回可识别的失败原因，路由层将其转换为回退结果，不让错误吞掉原始 HTTP 状态和取消信息。

## 5. 进程与凭据

API Key 保留在 Main 或现有加密设置存储中。System One 请求属于网络模型请求，不进入 Renderer。远程 Agent 的执行请求由桌面 Main 先完成角色选择，再复用共享协议和已有模型桥接凭据边界传递角色提示。

## 6. 实现顺序

1. 扩展共享协议枚举和模型 profile 校验。
2. 增加 System One 请求、响应和结果解释的纯函数契约。
3. 增加 Main 侧通用请求服务和定向单元测试。
4. 增加角色选择用途配置和设置页开关。
5. 接入 Assistant 自动路由，补充成功、回退、取消和迟到结果测试。
6. 使用真实 Ollama System One 请求验证 `d3`，再运行仓库检查。
