# 桌面更新技术设计

## 现有实现与边界

`version-checker.ts` 校验 GitHub 聚合清单和镜像索引。`build/build-release.cjs` 为各平台生成包、大小及 SHA-256，Windows 同时发布 NSIS 与便携 ZIP；`packages.yml` 当前仅发布 macOS DMG。便携标记通过 `portable-user-data.ts` 定位 data。以上为开发开始时核实的事实。

实现 [PRD](./prd.md) 和[行为规则](./logic-design.md)，遵循[性能原则](../../architecture/performance-principles.md)。

## 职责

Main 的更新服务拥有选定目标、操作和状态，沿用现有设置存储，不增加业务数据库。下载、哈希与解压交给工作线程；Main 负责 IPC 校验、进度转发与平台生命周期调度。仅在首次下载时加载下载执行端，首屏不启动更新工作线程。

Preload 只暴露快照、下载、取消和安装等明确动作；Renderer 不传 URL、文件系统路径或命令行。Renderer 使用领域 store、同步层与 selector，避免向 App.tsx 增加领域逻辑。

缓存位于应用拥有的更新目录，部分下载使用临时文件，成功后才改名。取消和失败等待流关闭后清理本次临时文件。退出停止下载；只清理更新服务拥有的文件，不扫描用户临时目录。缓存可丢弃，无需新增持久事务或恢复日志。

## 平台安装

Windows 用户级安装优先采用现有 NSIS 直接交接。2026-10-26 的隔离小安装包实验证明 `/S /currentuser --updated --force-run` 能找回原目录、替换程序并启动新版；省略安装模式参数也能恢复已有用户级安装。依据和覆盖边界见[实施记录](./progress.md#2026-10-26nsis-与退出事件小实验)。正式实现仍需验证完整 GoodBuddy 载荷及全局安装提权，不能将小载荷结果扩大到所有 Windows 安装模式。

macOS 和 AppImage 继续评估成熟的自动更新实现。它们与现有检查器必须共用一个固定版本目标，不能独立追踪两个 latest。

便携辅助程序从被替换目录之外运行，等待应用退出，按包文件归属替换程序、保留 data 和用户附加文件，再启动新版本。仅处理本次替换失败，不实现通用回滚引擎，不承诺已迁移数据库的降级。

deb/rpm 经系统软件包安装流程交接。运行方式不能可靠识别时由用户选择格式。任何平台不得凭操作系统类型就承诺静默安装成功。

当前 before-quit 清理结束调用 app.exit，且清理期限为 8 秒。该路径会触发 quit，但跳过 will-quit。安装交接由清理结束处直接调用 `finishDesktopUpdateShutdown`；只有清理完成且无失败时，才以 `/S --updated --force-run` 启动 NSIS，随后退出旧进程。启动成功仅表示安装器进程已创建，不代表安装已经完成。

## 发布支持

沿用现有清单，按同一次构建输出更新库元数据；macOS 增加更新 ZIP，保留 DMG 首次安装。同步修改格式数量验证、聚合清单、镜像索引和站点产物选择。GitHub 与镜像文件字节一致，上传完整后才更新最新版本指针。首版不依赖差分下载。

桌面更新不修改远程 Agent 包或升级协议；若退出协调影响桌面到 Agent 生命周期，按仓库规则补真实 Linux Host 验证。

## 已接入的下载路径

`DesktopUpdateService` 保存检查结果及修订号，通过 `desktop-update-ipc.ts` 注册独立 IPC；`VersionChecker` 完成检查后将结果及来源交给服务。`desktop-update-worker.ts` 执行 `desktop-update-download.ts`，流式写入并校验大小和 SHA-256。Worker 每 250 ms 至多推送一次下载进度，校验完成后原子改名；取消等待 Worker 退出再删除残留文件。

缓存目录为 `userData/desktop-updates/package`。开始下载前只清理可识别的所属文件，保留当前选定候选，再由下载 Worker 校验并复用或替换；不递归删除整个目录。Main 不缓存完整文件字节。完成状态仅在进程内保留，重启后重新检查发布清单，已有候选的大小和 SHA-256 相符时无需再次联网下载。

Renderer 的 `desktop-update-store.ts` 和 `desktop-update-sync.ts` 以修订号忽略晚到快照，设置页重挂载读取 Main 当前状态。`DesktopUpdateDownload` 放在版本卡片标题右侧，展示进度和操作。

当前 Windows 根据便携标记选择 ZIP 或 NSIS，macOS 选择已有 DMG，Linux 显式选择格式。NSIS 安装版复用 `isInstalledWindowsBuild` 判断，只在已打包、具有现有卸载器且非便携的 Windows 应用中提供重启更新；其余形式保持系统打开或文件定位。

## Windows 重启更新

`DesktopUpdateService.restart` 再次在 Worker 中校验，进入 restarting 并冻结下载目标。Main 复用 `ipc.ts` 的运行请求状态和 Renderer 保存协议：先处理 Office 未保存文档，再暂停新任务，检查运行/排队任务与导入，禁用窗口交互，请求严格保存确认，最后等待在途 IPC 操作结束。

保存请求附带 update 原因；Renderer 检查所有会话输入草稿、运行任务、知识库操作和共享未保存编辑标记，并沿用 beforeunload 检查。设置、快速笔记及工作区编辑器使用 `useWorkspaceUnsavedChanges` 报告未保存内容。通过后等待活动记录、会话及附件保存完成，并再次检查。Preload 将失败文本随请求编号传回，Main 在更新请求中拒绝失败或超时确认；普通退出保持既有行为。

准备阶段失败恢复窗口交互和任务接收，保留校验完成的包供重试。准备成功后记录待安装路径并正常调用 app.quit，沿用原有 Runtime detach、资源清理与存储关闭顺序。清理失败或超时不启动安装器，显示原生错误提示并退出旧进程；原版本文件保留，可重新打开。安装器创建失败也显示错误，不将其当作安装完成。

## 缓存回收实现

`desktop-update-cache.ts` 实现[缓存生命周期](./logic-design.md#缓存生命周期fr-10us-12-至-us-14)，由现有更新 Worker 执行。启动清理在主窗口 did-finish-load 后触发，与下载、校验和手动清理互斥；不增加启动前的批量文件工作。完整包的版本从既有文件名解析，与 app.getVersion 比较，无需增加安装成功记录或清理日志。

清理扫描 package 目录和旧版曾写入的 desktop-updates 顶层，只对规范命名的普通文件逐个删除。Main 传入当前 executable 和 APPIMAGE 路径作为保留项。删除失败汇总为 cleanupWarning，UI 提供手动入口；一次延后重试由服务管理，开始新下载、打开包、重启或退出时取消该重试，防止删除新操作的文件。

下载/清理 Worker 的结束代表文件句柄已释放。取消会等待 Worker 结束再做本次文件清理；原始下载错误与后续删除错误同时保留。完整候选在移交外部程序前只在 Worker 中校验，确认损坏时删除，权限/读取错误则保留错误信息供后续处理。

## 实施与验证顺序

1. 完成文档和现有机制核对，建立测试中的安装方式与发布目标样例。
2. 接通设置页到真实下载、大小和 SHA-256 校验、取消、重试的路径。
3. 验证 NSIS 更新与退出交接，随后完成便携辅助程序及其他平台适配。
4. 接入自动下载、发布元数据和 macOS ZIP，完成跨源、跨架构验证。
5. 运行类型检查、lint、相关测试和真实打包升级；更新用户与构建文档。

真实升级在独立安装目录和用户目录执行，禁止覆盖开发者当前安装或原始数据。验证包括安装版用户级/全局/自定义目录、便携数据保留、macOS 签名启动、AppImage 与软件包，以及取消、损坏、来源冻结和退出失败。当前设备不能执行的平台明确记录为未验证；未经真实升级验证不标记功能完成。
