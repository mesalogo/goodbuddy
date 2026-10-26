# 桌面更新实施记录

## 2026-10-26：设计与实施启动

已建立 [FR-1 至 FR-9](./prd.md)、[US-1 至 US-11](./user-stories.md) 及行为、界面、技术设计。

开始实施时，版本检查只有文件信息与下载页面入口。Windows 发布 NSIS 和便携 ZIP；便携标记定位 data。macOS 工作流只构建 DMG，尚无正式更新 ZIP。现有退出流程最终调用 app.exit，需要明确安装交接位置。

| 阶段 | 状态 | 验证证据 |
| --- | --- | --- |
| 文档与机制核对 | 已编写、审校 | 中文文档扫描 0 阻断；复核项为状态约束与验收边界，保留 |
| 下载与校验（FR-1 至 FR-4） | 已接入并通过受控 Electron 场景 | 真实设置页、Preload、可信 IPC、Worker、HTTP 流、文件与 SHA-256；取消、重试、重挂载恢复 |
| 安装交接与数据保留（FR-5、FR-7、FR-8） | Windows NSIS 重启交接已接入 | 保存确认、任务/草稿检查、清理成功后启动安装器；小载荷实际覆盖升级通过，完整 GoodBuddy 与其他平台待验收 |
| 自动下载与发布支持（FR-6、FR-9） | 待实施 | 无 |
| 缓存生命周期（FR-10） | 已接入并验证 | 失败/取消清理、启动回收、候选复用、手动清理、真实文件占用与 NSIS 安装后回收 |
| 真实打包升级 | 待验证 | Windows/macOS/Linux 均未执行 |

已有工作区中的宣传文章修改不属于此功能。

## 下载路径验证

- 定向测试：`npm.cmd exec vitest run tests/desktop-update.electron.test.ts tests/electron-vite-config.test.ts src/main/desktop-update-download.test.ts src/main/desktop-update-service.test.ts src/main/version-checker.test.ts src/main/shutdown.test.ts src/main/ipc.test.ts src/preload/index.test.ts src/renderer/src/desktop-update-store.test.ts src/renderer/src/UpdateSettingsSection.test.tsx src/renderer/src/SettingsPanel.test.tsx`，10 个测试文件，392 通过、1 跳过。命令中的 preload/index.test.ts 当前未匹配测试文件，Preload 由 Electron 场景实际加载验证。
- `npm.cmd run typecheck` 通过；本次改动定向 ESLint 通过。
- `npm.cmd run build` 通过，包含新增 Worker 入口和生产资源生成；没有构建或执行正式安装器。
- 全量 `npm.cmd test`：后台日志最终记录 576 个文件通过、3 个文件失败、18 个文件跳过；6818 项通过、7 项失败、89 项跳过，耗时 1121.91 秒。失败为 App.test.tsx 的 5 项会话编辑/侧栏用例、message-expansion.electron.test.ts 的来源按钮用例、opencode-native-children.test.ts 的 concurrent 用例。本次定向验证未发现下载域失败；工作区有并行修改，未将这些失败归因为已确认的既有缺陷。
- 全量 lint 首轮报出聊天编辑相关问题；并行修改继续完成后，22:31 再次执行 `npm.cmd run lint` 已通过。
- 末轮下载、服务、store、真实 Electron 与 preload-sandbox 定向验证：5 个文件、39 项通过。
- Electron 测试使用受控版本信息、本地 HTTP 字节流和受控安装器边界，不请求公开安装包，也不执行安装程序。它证明下载生产组件链路可运行，不能代替旧版本到新版本的真实升级验收。
- 本次变更不修改 Agent 协议、远端安装或运行生命周期；退出流程仅增加本地下载 Worker 的清理，因此本阶段没有远端专属实现改动。

剩余工作：自动下载偏好、完整 GoodBuddy NSIS 升级与全局安装提权验收、便携辅助程序、macOS ZIP 与更新机制、AppImage 自动替换、系统包格式识别及各平台真实升级验证。整体自动更新功能仍为实施中。

## 2026-10-26：NSIS 与退出事件小实验

使用当前安装的 electron-builder 26.18.0，复用仓库的 NSIS 选项与 `build/installer.nsh`，生成两个带独立产品名、appId 和 GUID 的真实安装器。载荷是写出启动版本与参数的 C# 小程序；实验关闭桌面和开始菜单快捷方式，所有包和安装位置均位于 `temp/desktop-update-nsis-probe`。没有替换当前 GoodBuddy 安装。

脚本：`build/validate-desktop-update-nsis.cjs`。依次执行 `build-v1`、`build-v2`、`exercise`、`clean`。两个包分别为 927016 和 926873 字节。

| 实验 | 结果 |
| --- | --- |
| 1.0.0 使用 `/S /currentuser /D=<带空格的自定义路径>` 安装 | 成功写入指定目录；没有自动启动 |
| 1.0.1 使用 `/S /currentuser --updated --force-run`，不传 `/D` | 找回原目录，版本替换成功，删除旧版 obsolete.txt；安装目录外的隔离用户数据文件保留；新程序启动并记录 `1.0.1\|--updated` |
| 再次使用 1.0.1 的 `/S --updated`，不传安装模式与目录 | 找回原有用户级安装；没有 `--force-run` 时不自动启动 |
| 正常卸载并清理 | 完成；独立产品的两个 HKCU 注册键确认消失，实验目录删除 |

第一次清理发现卸载启动进程退出后注册键仍短暂存在，随后由复制后的卸载进程清理完成。脚本已改为等待测试注册键消失再删除实验目录，不把启动进程退出等同于卸载全部完成。

`tests/desktop-update-lifecycle.electron.test.ts` 直接运行真实 Electron，2 项通过。异步清理后调用 `app.exit(0)` 的事件为 `before-quit → cleanup-complete → quit`；改为 `app.quit()` 时为 `before-quit → cleanup-complete → before-quit → will-quit → quit`。确认当前 app.exit 路径确实跳过 will-quit。

结论：Windows 用户级安装可以优先采用现有 NSIS 的更新参数和目录识别能力；安装交接必须显式位于清理成功之后，不能依赖 will-quit。以上尚未覆盖真实 GoodBuddy 载荷、活动任务、全局安装提权、ARM64、签名、便携版或 macOS/Linux，因此不将整体自动安装标记为完成。

本轮验证：`npm.cmd run typecheck` 通过；新增实验脚本与生命周期测试的定向 ESLint 通过；生命周期测试最终以 ESM 入口执行，2 项通过。清理后 `temp/desktop-update-nsis-probe` 已不存在。

## 2026-10-27：Windows 重启更新交接修复

对应 FR-4、FR-5、FR-7 与 US-1、US-7、US-9。Windows NSIS 安装版的 ready 按钮现在进入 restarting，通过生产 Preload/IPC 调用更新服务。服务再次校验安装包，Main 沿用现有请求状态与 Renderer 保存协议进行严格预检，成功后正常退出。在原关闭清理尾部直接调用 `finishDesktopUpdateShutdown`，不依赖 will-quit。

修复了更新所需的保存确认语义：Preload 将失败文本传回，更新预检收到失败、未就绪或超时时不退出，恢复交互并保留已下载包。输入框草稿、设置、快速笔记及共享标记覆盖的工作区编辑接入检查；正常退出仍使用原有保存路径。关闭清理失败/超时不会启动安装器；创建安装器进程失败显示原生错误。此时已关闭的旧进程不会伪装为可继续工作，但原版本安装保留。

验证记录：

- 12 个相关测试文件：416 通过、1 跳过。覆盖更新服务、生产 IPC 保存确认、Preload、未保存内容、设置页、会话持久化和真实 Electron 路径。
- `npm.cmd exec -- vitest run src/renderer/src/App.test.tsx -t "blocks update restart|flushes pending local conversation changes before quit"`：2 通过，其余按过滤跳过。实际 App 的未发送草稿会阻止更新，处理草稿后保存通过，普通退出保存回归通过。
- 生命周期 Electron 测试扩展为 5 项，直接加载生产 `finishDesktopUpdateShutdown`，验证正常退出、清理失败和创建安装器进程失败。
- NSIS 小实验改为直接调用生产 `launchDesktopUpdateInstaller`，参数为 `/S --updated --force-run`。两版本包为 926885/926942 字节；实际覆盖升级、原目录恢复、新版启动及数据保留通过。
- 小实验首次连续重装返回退出码 2：新版启动时上一安装器仍在收尾。脚本增加对该测试安装器进程退出的等待后复跑通过。产品只等待安装器进程创建后退出旧应用，不等待安装完成。
- `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run build` 通过。本轮未重新完成全量测试，不沿用历史全量结果作为本轮通过证据。
- 测试安装与注册键已经清理，`temp/desktop-update-nsis-probe` 已不存在。没有替换用户当前安装，没有调用外部模型。

本次保留原 Runtime detach/dispose 与存储关闭顺序，只在退出前增加检查，在全部清理后增加本地 Windows 安装器交接；未修改远端 Agent、协议或远端任务恢复实现。远端 Host 没有在本轮执行新验证。完整 GoodBuddy 旧包到新包、全局安装/UAC、ARM64、便携与其他操作系统仍不能根据这些小实验标记为验收完成。

## 2026-10-27：更新缓存生命周期清理

新增 FR-10 和 US-12 至 US-14，清理规则由[行为规则](./logic-design.md)维护。实现了已安装版本回收、半包与损坏完整包删除、旧缓存位置处理、有效候选复用，以及“清理更新缓存”入口。所有批量目录扫描和文件校验仍在更新 Worker 中运行。

已取消递归清空整个包目录的行为。规范包文件以外的个人文件、子目录、链接和当前运行路径保留。安装器/文件管理器接收包后，本次进程冻结该包；新版启动依据实际版本回收，无需保存安装成功日志。被占用的文件保留错误，启动/手动清理仅延后重试一次；其他历史文件清理失败不会阻止新文件下载。

验证证据：

- 14 个相关测试文件：436 通过、1 跳过。覆盖缓存、下载、更新服务、IPC、退出交接、Preload、设置页、保存检查和 Electron 场景。
- 最终针对清理实现的复跑：`npm.cmd exec -- vitest run src/main/desktop-update-cache.test.ts src/main/desktop-update-download.test.ts src/main/desktop-update-service.test.ts tests/desktop-update.electron.test.ts`，4 个文件、29 项通过。
- 真实 Windows FileShare.None 文件锁验证：占用时删除失败且文件保留，原始 HTTP 错误与删除错误均保留；释放占用后删除成功。
- 真实流式连接中断验证：收到部分字节后 ECONNRESET，关闭写入后半包和未成功目标均不存在。
- Electron 场景使用生产 UI、Preload、IPC 与 Worker，验证启动回收旧包/半包，手动清理后个人文件保留、ready 失效，并能重新下载与请求更新。
- NSIS 小包脚本 `build-v1`、`build-v2`、`exercise`、`clean` 通过。本轮两个包大小为 926867/926832 字节；生产安装启动函数从缓存目录启动，随后按实际安装后的版本调用生产清理函数，安装器退出后缓存 EXE 与遗留半包均被删除，隔离用户数据保留。测试安装、注册键和目录已清理。
- `npm.cmd run typecheck`、`npm.cmd run lint` 通过；首次并行构建达到 60 秒命令期限，确认构建进程已结束后单独重跑 `npm.cmd run build` 成功。本轮没有重新运行完整测试集。

本轮不修改远端 Agent 或 Runtime 生命周期，也不扫描系统临时目录。完整 GoodBuddy 安装包升级、非 Windows 文件占用和各平台自动安装仍按前述验收缺口跟踪，不能用小载荷与规则测试代替。

## 提交前独立验证

将暂存区导出到隔离目录，排除工作区其他功能的未提交修改后，`npm.cmd run typecheck` 通过。缓存、下载、服务、安装交接、Renderer 检查、Preload 与两个 Electron 测试文件共 72 项通过；App 的更新草稿检查/普通退出保存 2 项、IPC 的严格保存确认与旧退出确认 5 项通过。该验证用于确认本次提交可独立运行，不替代前述完整安装包验收。
