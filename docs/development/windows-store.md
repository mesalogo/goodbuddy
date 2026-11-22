# Windows MSI、MSIX 构建与商店提交

## 构建入口

在 Windows 上使用锁定依赖构建。每次指定一种格式和一种架构；MSI、MSIX 的输出目录独立，避免覆盖 NSIS 和 ZIP。

```powershell
npm.cmd run dist:win:msi -- --arch x64
npm.cmd run dist:win:msi -- --arch arm64
npm.cmd run dist:win:msix -- --arch x64
npm.cmd run dist:win:msix -- --arch arm64
```

默认包含类型检查和生产 bundle 构建。只有复用同一候选的已验证 `out` 时才添加 `--skip-build`；`--dry-run` 显示实际参数，不生成安装包。

输出目录为 `dist/release/windows-<arch>-msi` 和 `dist/release/windows-<arch>-msix`，含安装包及 SHA-256 清单。MSI 使用 electron-builder 的原生 `msi` 目标，安装到全局目录，需要管理员权限，升级由管理员重新部署 MSI 完成。当前工具链的 ARM64 MSI 使用 x64 安装器容器承载 ARM64 应用，这是 electron-builder 的已知实现，须在 Windows ARM64 上验证安装。

MSIX 使用 electron-builder 的 `appx` 目标调用微软 MakeAppx，直接输出 `.msix`。它包含 GoodBuddy 品牌图标及 `runFullTrust` 能力，最低系统为 Windows 10 2004。商店版本号采用 `major.minor.patch.0`；每次提交更新需提高应用版本，不使用 CI 运行编号占用商店保留的第四段。

## 商店产品标识

从 Partner Center 中 GoodBuddy 产品的“产品标识”页面复制以下值。在本地设置环境变量，CI 设置同名 Repository Variables：

| 变量 | 来源 |
| --- | --- |
| `MS_STORE_IDENTITY_NAME` | Package/Identity/Name |
| `MS_STORE_PUBLISHER` | Package/Identity/Publisher，完整的 `CN=...` 字符串 |
| `MS_STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName |

公司名称不能代替 Publisher。不得使用示例标识生成待提交包。缺少任何一项时，MSIX 命令在打包前报错。

提交商店的 MSIX 可以由商店签名；本地侧载测试需要与 Publisher 匹配的测试证书及测试机信任配置。官网 MSI 的受信任 Authenticode 签名仍需单独的证书或云签名服务，本次没有接入 Windows 生产签名凭据。

## GitHub Actions 构建

独立的 `Windows MSI packages` 工作流位于 `.github/workflows/msi.yml`。在 GitHub Actions 中选择该工作流，点击 **Run workflow**，分支选择 `main`，架构选择 `x64`、`arm64` 或 `both`（默认）。它在对应的原生 Windows runner 上安装依赖、执行 lint 和打包回归测试、完成类型检查及生产构建，再生成 MSI。无需配置商店标识或商店 API 凭据。

完成后从运行页面的 Artifacts 下载 `goodbuddy-msi-x64` 或 `goodbuddy-msi-arm64`，其中包含 `.msi` 和 SHA-256 清单，保留 30 天。该工作流只构建上传 CI 产物；正式发布仍按发布手册执行。

`Cross-platform packages` 沿用现有版本标签或 main 手动构建入口。新增 Windows 附加任务在原生 x64、ARM64 runner 构建 MSI；配置商店标识后，同时构建 MSIX。三项商店标识全部为空时跳过 MSIX；只填了一部分则报错。

附加产物在该次运行的 Artifacts 下载，保留 30 天：

- `goodbuddy-msi-x64`、`goodbuddy-msi-arm64`
- `goodbuddy-msix-x64`、`goodbuddy-msix-arm64`

这些包使用独立分发渠道，目前不加入官网更新清单、GitHub Release 或 OSS 自动下载索引。旧版本客户端的固定格式清单校验保持有效。构建通过、安装验证、商店审核通过分别记录，不能相互替代。

## 自动提交商店

仓库中的 `Submit Microsoft Store update` 工作流调用微软官方 `msstore` CLI。人工选择已完成构建的 Run ID 后，可自动完成两个架构的包哈希检查、上传归档生成、认证、上传以及可选的提交审核。

此工作流用于已上架应用的更新。先在 Partner Center 完成首次上架，包括商店资料与年龄分级；再关联 Microsoft Entra ID 应用，赋予该应用适当的 Partner Center 提交权限。

在 GitHub 的 `microsoft-store` Environment 配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `MS_STORE_APP_ID` | GoodBuddy 的 Store 产品 ID |
| Secret | `MS_STORE_TENANT_ID` | Entra 租户 ID |
| Secret | `MS_STORE_SELLER_ID` | Partner Center Seller ID |
| Secret | `MS_STORE_CLIENT_ID` | 获授权的 Entra 应用 Client ID |
| Secret | `MS_STORE_CLIENT_SECRET` | 该应用的 Client Secret 值 |

密钥直接填写到 GitHub Secrets，不写入仓库，也不通过聊天传递。这里的 API 身份用于提交应用，与代码签名证书不同。

运行流程：

1. 完成 `Cross-platform packages` 构建，确认两个 MSIX artifact 均存在。
2. 在 main 上运行 `Submit Microsoft Store update`，填写该次构建的数字 Run ID。
3. `commit_submission=false` 会上传并生成草稿；设为 `true` 则继续提交审核。
4. 在 Partner Center 查看审核和上线状态。上传命令成功不表示审核已通过。

微软 CLI 的 `publish` 会基于已发布版本重建提交草稿，丢弃原草稿中尚未发布的元数据编辑。运行前需确认这些编辑已发布或已另行保存。工作流不会改变价格，也不自动改写商店介绍和截图。

当前采用手动触发后的自动执行，不随每个 Git 标签直接提交商店。配置及第一次实际提交验证完成后，可再按发布策略接入自动触发。

## 安装渠道与更新

MSI 和 MSIX 在包元数据中写入各自渠道。应用内检查更新返回渠道说明，不请求官网安装器，也不提供 EXE 重启升级。商店版“打开下载页”入口指向 Microsoft Store 的下载与更新页面；MSI 版提示管理员使用新版 MSI。启动检查不会把这类正常状态显示为网络错误或“已是最新版本”。

首次分发前需在对应架构的隔离设备验证安装、启动、升级、卸载，以及 Runtime 子进程、凭据、文件访问和联网功能。MSIX 中的应用目录受 Windows 管理；商店的 `runFullTrust` 审核、产品标识及账号权限必须通过实际提交确认。

## 参考

- [Microsoft Store Developer CLI 命令](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/commands)
- [Microsoft Store 提交 API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [electron-builder AppX 配置](https://www.electron.build/appx.html)
