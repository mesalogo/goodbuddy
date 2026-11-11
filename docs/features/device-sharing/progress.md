# 设备共享实施记录

## 2026-11-11：服务器托管的双来源数字分身

- PS-1/PS-4：设备共享新增数字分身页签、配置发布与编辑、可选站点知识、成员／组授权、暂停、撤回、问答和取消。来源为 GB，执行位置为服务器。
- PS-2/PS-3/PS-5：经 ShareServer 实际协议读取归属与版本，服务器阻止跨设备编辑、管理员改写 GB 配置以及撤回后调用。
- 相关 5 个测试文件 19 项测试通过；新增 store 测试覆盖取消后迟到回答与旧刷新不覆盖新目录。变更文件 ESLint 通过。
- `GOODBUDDY_SHARING_SERVER_ROOT=../goodbuddy-shareserver GOODBUDDY_SHARING_TEST_HOST=192.168.0.23 GOODBUDDY_SHARING_MODEL_ENV=<private-env> xvfb-run -a npx vitest run tests/device-sharing.electron.test.ts` 通过。实际 GB 页面 → Preload → Main → LAN ShareServer 完成配置发布、真实回答、重建客户端服务对象读取归属、撤回并拒绝调用；浅深主题 480px 无整页溢出。
- 本次联调真实文本模型请求共 3 次：既有模型导入流程 2 次、新分身问答 1 次。隔离实例与用户数据目录已由测试清理。测试使用 root 环境启动参数，未改变产品 sandbox/contextIsolation 配置。
- 全量类型检查仍有既有依赖问题：缺失 `playwright`、`@deepseek-ai/dsh-tool-executor-native`、`material-icon-theme`，以及 DeepSeek 工具结果类型差异；不能宣称 GB 全量验收通过。此次未打包或发布桌面安装包；无本地／远端 Runtime 执行变更，不涉及 Agent 部署路径。
