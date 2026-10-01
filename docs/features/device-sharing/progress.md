# 设备共享实施进度

日期：2026-10-01。当前实现范围见 [README](./README.md)。

`a3b41bf` 已接入应用入口、Main 服务、可信 IPC、preload 与页面，
支持配置 ShareServer、注册设备、读取目录、发布/撤销元数据及本机 ID 持久化。
设备 ID 不是认证凭据，权限字段不代表已实现远程操作；正文传输、能力调用、
发现和配对仍不属于本期实现。

当前组合源码类型检查和 lint 通过。仓库包含服务、IPC、页面测试和需指定
`GOODBUDDY_SHARING_SERVER_ROOT` 的真实 ShareServer/Electron 联调用例。
本轮发布准备中的定向测试被用户中断，并要求直接推送交 CI 验证；
不据此声明测试或真实服务联调通过。发布结果以最终候选 CI 为准，
条件跳过的真实服务用例不能计入已验证能力。

## 2026-10-01：桌面实现轮次的独立验证

以下记录来自设备共享实现会话，独立于上文发布准备轮次；已实际运行，不作为发布 CI 或安装包
验收的替代。对应 [FR-M1 至 FR-M5](./prd.md#当前首期本地元数据)。

| 检查 | 结果与覆盖范围 |
| --- | --- |
| 定向 7 文件 | 114 项通过：Main HTTP 契约、稳定 ID、设置重读、可信 IPC、超时与错误、页面发布／撤销、输入保留、旧设置迁移与应用排序 |
| 完整 `App.test.tsx` | 320 项通过，含新增设备共享入口与既有设置 Modal 回归 |
| `goodbuddy-config-contracts.test.ts` | 8 项通过；修正旧四项写入样例，保留重复、未知及缺失项拒绝断言 |
| 真实 Electron／ShareServer | 1 项通过，使用相邻后端源码、独立端口和临时数据目录，真实窗口运行生产页面、preload、可信 IPC 和 Main 服务 |
| 类型与静态检查 | `npm run typecheck`、`npm run lint`、`git diff --check` 通过 |

Electron 联调从应用中心打开页面，注册本机，发布知识元数据，服务返回确认
`sourceMode=server`、`search=true/read=false/download=true`，随后撤销并刷新至
`status=revoked`。注册、发布、撤销确认和刷新使用原生鼠标输入；重读磁盘保持设备 ID。
浅深主题的 480px 视口均无横向溢出。首次窄窗口检查因系统缩放与预期 CSS 宽度不一致失败，
沿用现有 Electron 测试的固定设备缩放设置后通过。该测试是组件组合，未启动完整生产 App，
也未验证安装包、截图视觉效果或 macOS／Linux 窗口。

全仓 `npm test` 用时 760.82 秒：468 文件通过、13 文件跳过、2 文件失败；5,549 项通过、88 项
跳过、2 项失败。设备共享真实 Electron 联调在这次全仓运行中也通过。两项失败分别为：

- 配置工具样例仍提交四项顺序。运行期间修正后独立复跑 8 项通过；随后与服务测试合跑
  11 项也通过，服务测试包含对尚不存在设置文件的并发首次读取。
- `inline-help.electron.test.ts` 的 `Hover Escape closed modal: dark 360x320` 断言失败。
  未修改该文件或帮助组件，独立复跑 1 项通过，原因未确定；不把复跑结果写成全仓一次全绿。

完整日志位于本次工作机临时目录 `opencode/goodbuddy-sharing-full-tests.log`。没有再次执行整套
全仓测试。本功能测试没有模型调用。中文设备共享文档经 `deai-writing` 扫描无阻断项，复核项
中的权限边界、真实字段及测试列表按事实保留。

### 复现命令

在 GoodBuddy 仓库执行：

```powershell
npx vitest run src/main/device-sharing-service.test.ts src/main/device-sharing-ipc.test.ts src/main/application-settings-store.test.ts src/renderer/src/DeviceSharingPage.test.tsx src/renderer/src/ApplicationCenter.test.tsx src/renderer/src/ApplicationMenu.test.tsx src/preload/preload-sandbox.test.ts
npx vitest run src/renderer/src/App.test.tsx
npx vitest run src/shared/goodbuddy-config-contracts.test.ts
$env:GOODBUDDY_SHARING_SERVER_ROOT = (Resolve-Path ../goodbuddy-shareserver).Path
npx vitest run tests/device-sharing.electron.test.ts
npx vitest run tests/inline-help.electron.test.ts
npm run typecheck
npm run lint
npm test
```

跨仓 Electron 测试需要后端已安装依赖；未设置 `GOODBUDDY_SHARING_SERVER_ROOT` 时明确跳过。
测试会关闭自己启动的服务并清理临时数据，不写后端源码。

### 手工体验

在 ShareServer 仓库运行 `npm run dev:api`，在 GoodBuddy 仓库运行 `npm run dev`。从“应用”
打开“设备共享”，默认地址为 `http://127.0.0.1:8787`。先保存名称或地址修改，再注册本机、
发布条目、检查目录、撤销并刷新。知识类型提供三个独立权限框；重启后可比较同一设备 ID。
服务关闭时刷新应显示错误并保留旧列表，不应显示为空目录或推断设备离线。
