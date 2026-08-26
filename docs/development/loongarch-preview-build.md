# GoodBuddy 龙芯（LoongArch）预览版构建

本文档是 GoodBuddy 龙芯预览版的权威构建与功能状态说明。当前目标是
Debian `loong64` 桌面，不代表 GoodBuddy 已将龙芯纳入正式发布支持矩阵。

## 当前状态

当前流程可以在 AMD64 Linux 主机上交叉构建一个独立的
`goodbuddy-loongarch-preview` DEB，并校验包内 Electron、node-pty 和 Koffi
均为 LoongArch ELF。

预览版使用社区维护的 Electron 42.3.0 LoongArch 构建。GoodBuddy 正式版本
当前使用 Electron 43.2.0，因此该预览包只用于移植和真机验证，不能作为正式
发布基线。Electron 官方目前也不提供 Linux LoongArch 预编译包。

已完成的实际构建结果：

| 项目 | 结果 |
| --- | --- |
| GoodBuddy 源版本 | `0.11.0` |
| 预览版本 | `0.11.0-loong64-preview.1` |
| Debian 架构 | `loong64` |
| Electron | 社区版 `42.3.0` |
| DEB 包名 | `goodbuddy-loongarch-preview` |
| 构建产物 | `GoodBuddy-0.11.0-linux-loong64-preview.deb` |
| 已验证构建时间（UTC） | `20260825T102937Z` |
| 已验证产物大小 | `187053208` bytes |
| 已验证产物 SHA-256 | `461ade49f10a20ef7b28163077a2ecd6afd2c5b1b0befc673c6d174fd58497b3` |
| DEB 解包、架构和动态库解析 | 已通过 |
| QEMU Electron 初始化 | 共享库解析通过；Chromium 多线程初始化在 QEMU 下异常退出 |
| 龙芯真机启动 | 尚未验证 |

版本号和产物名会跟随当前 `package.json` 版本变化，上表只记录首次成功构建。

## 功能列表

“已打包”只表示所需代码或组件进入 DEB，不等同于已在龙芯桌面完成运行验证。

| 功能 | 预览包状态 | 当前验证 |
| --- | --- | --- |
| GoodBuddy Electron 桌面主体 | 已打包 | Electron 可执行文件为 LoongArch ELF；尚未完成真机 GUI 启动 |
| React 界面和主进程业务代码 | 已打包 | 生产 bundle 构建、测试、类型检查和 lint 已通过 |
| 直接模型调用路径 | 已打包 | JavaScript 代码与生产依赖已包含；待龙芯真机端到端验证 |
| Continue Runtime | 已打包 | CLI JavaScript 入口及 npm Runtime 已包含；待真机执行验证 |
| 本地终端能力 | 已打包 | 输入锁文件固定的 node-pty（当前为 1.2.0-beta.15）已针对 Electron 42.3.0 交叉编译并验证为 LoongArch ELF；待真机 PTY 验证 |
| Koffi glibc 原生绑定 | 已打包 | Koffi 3.1.4 LoongArch glibc binding 已校验为 LoongArch ELF |
| 内置 Skills | 已打包 | 静态资源已进入 DEB |
| GoodBuddy Agent | **不包含** | 当前 Agent 的正式构建和双 glibc/musl 产物契约不支持 LoongArch |
| Remote Runtime | **不包含** | 当前没有 LoongArch Remote Runtime 产物 |
| OpenCode Runtime | **不包含** | OpenCode 所需 Bun Runtime 当前不支持 LoongArch |
| 原生 Canvas 图像解码 | **不包含** | npm 当前没有 `@napi-rs/canvas-linux-loong64-gnu` 包 |
| Koffi musl binding | **不包含** | Koffi 3.1.4 只发布了 `linux_loong64` glibc binding |
| 正式自动更新和发布索引 | **不支持** | 预览包不加入正式 CI、安装包矩阵或更新索引 |

在真机验证完成前，不应把“已打包”功能描述为正式可用。尤其是窗口显示、GPU、
音频、系统托盘、桌面集成、PTY 交互和模型调用都必须在真实 LoongArch 桌面上
重新验证。

## 与正式 GoodBuddy 隔离

预览版有意使用单独身份，避免覆盖正式安装：

- Debian 包名：`goodbuddy-loongarch-preview`
- 产品名：`GoodBuddy LoongArch Preview`
- 可执行文件：`goodbuddy-loongarch-preview`
- 安装目录：`/opt/GoodBuddy-LoongArch-Preview`
- Electron 应用身份与正式 GoodBuddy 不同，因此使用单独的用户数据目录

该流程不会修改 `.github/workflows/packages.yml`，也不会把 `loong64` 加入
正式 release manifest 或下载索引。

## 构建前提

### 本地源码主机

- 已完成 `npm ci`
- Node.js 和 npm 版本满足仓库要求
- 可以成功执行 `npm run build:bundle`

### AMD64 交叉构建主机

- Linux AMD64
- Docker
- 建议至少 30 GiB 内存和 50 GiB 可用磁盘
- 可访问 Ubuntu、npm、Electron headers 和社区 Electron Release

### Electron LoongArch shell

从
[`darkyzhou/electron-loong64`](https://github.com/darkyzhou/electron-loong64)
的 Releases 下载：

```text
electron-v42.3.0-linux-loong64.zip
```

构建脚本固定校验以下 SHA-256，摘要不匹配时必须停止：

```text
92b0ca0c9c18ed90166918a4ac1970266c4fa967aee9277031b3b250b905526e
```

这是社区产物，不是 Electron 官方发布的 Linux LoongArch 二进制。

## 第一步：生成架构无关输入

在 GoodBuddy 仓库根目录执行：

```sh
npm ci
npm run build:bundle
node build/loongarch-cross/prepare-input.cjs
```

默认输出：

```text
dist/loongarch-cross/goodbuddy-loongarch-cross-input.tgz
```

输入归档包含生产 `out`、锁文件、Skills、Continue Runtime、npm Runtime、
图标和发布元数据。它不包含 Agent、Remote Runtime 或 OpenCode 二进制。

可通过 `--output` 指定其他输出位置：

```sh
node build/loongarch-cross/prepare-input.cjs \
  --output /path/to/goodbuddy-loongarch-cross-input.tgz
```

## 第二步：构建交叉工具链镜像

将 `build/loongarch-cross`、输入归档和 Electron zip 放到 AMD64 Docker
主机，然后执行：

```sh
docker build \
  --tag goodbuddy-loongarch-cross:ubuntu-26.04 \
  build/loongarch-cross
```

工具链镜像包括：

- `loongarch64-linux-gnu-gcc` 和 G++
- LoongArch glibc 开发 sysroot
- QEMU user mode
- CMake 和 Ninja
- Rust `loongarch64-unknown-linux-gnu` target
- Node.js、npm 和上游 node-gyp

可先运行基础探针：

```sh
mkdir -p build/loongarch-cross/results
docker run --rm \
  --volume "$PWD/build/loongarch-cross/results:/results" \
  goodbuddy-loongarch-cross:ubuntu-26.04
```

探针必须通过 C、C++、CMake、Rust、NAPI-RS、QEMU、DEB、Koffi 和
node-pty 检查。Canvas 和 Koffi musl 显示为 unavailable 是当前已知限制，
不是 Debian 桌面主体 DEB 的构建失败。

## 第三步：生成预览 DEB

假设交叉构建主机上的文件布局如下：

```text
input/goodbuddy-loongarch-cross-input.tgz
electron/electron-v42.3.0-linux-loong64.zip
preview-output/
```

运行：

```sh
docker run --rm \
  --entrypoint /usr/local/bin/goodbuddy-loongarch-preview-deb \
  --volume "$PWD/input:/input:ro" \
  --volume "$PWD/electron:/electron:ro" \
  --volume "$PWD/preview-output:/preview-output" \
  goodbuddy-loongarch-cross:ubuntu-26.04 \
  /input/goodbuddy-loongarch-cross-input.tgz \
  /electron/electron-v42.3.0-linux-loong64.zip \
  /preview-output
```

每次构建创建一个 UTC 时间戳目录，包含：

```text
GoodBuddy-<version>-linux-loong64-preview.deb
preview-manifest.json
SHA256SUMS
```

脚本会执行以下强制检查：

1. 校验 Electron zip 的固定 SHA-256。
2. 删除 npm 错误解析出的宿主架构可选原生包。
3. 按 lockfile integrity 校验并安装 Koffi LoongArch glibc binding。
4. 读取输入 lockfile 固定的 node-pty 版本，并使用上游 node-gyp 11.4.2
   和 Electron 42.3.0 headers 交叉编译。
5. 拒绝 `node_modules` 中任何不是 LoongArch ELF 的 `.node` 文件。
6. 拒绝意外进入包内的 Agent、Remote Runtime 或 OpenCode 目录。
7. 生成 `Architecture: loong64` 的 DEB，解包后再次校验关键 ELF。

Ubuntu 发行版自带的 node-gyp 会在 Linux addon 链接阶段无条件添加
`-lnode`，不适合此 Electron 交叉编译；不要用它替换脚本固定的上游
node-gyp。

## 验证边界

### 已由交叉构建验证

- C、C++、CMake 和 Rust 生成 LoongArch ELF
- C、C++ 和 Rust 程序通过 QEMU user mode 执行
- 最小 NAPI-RS addon 交叉编译
- node-pty 针对 Electron headers 交叉编译
- Koffi LoongArch glibc binding 架构
- Electron、node-pty、Koffi 和 DEB `loong64` 元数据
- DEB 完整解包
- Debian Forky rootfs 中 Electron 全部共享库解析；该检查发现并补充了
  `libpulse0` DEB 依赖

### 仍需真实龙芯桌面验证

1. 安装 DEB 并从桌面入口启动。
2. 验证窗口、渲染、GPU 回退、输入法、系统托盘和通知。
3. 配置模型并执行一次真实的直接模型对话。
4. 验证 Continue Runtime 启动、取消和退出清理。
5. 打开本地终端，验证 node-pty 输入、输出、窗口缩放和进程回收。
6. 验证 Koffi 使用路径。
7. 验证音频、文件选择器、剪贴板和外部链接。
8. 确认 Agent、Remote Runtime、OpenCode 和 Canvas 相关入口不会被误认为
   预览版已支持。

QEMU 可以补充动态链接器和缺库检查，但不能替代上述 GUI、PTY、GPU、音频和
桌面集成真机测试。当前 Electron 在 QEMU user mode 下可以完成全部共享库
解析；继续进入 Chromium 多线程初始化后，QEMU 出现 target `SIGSEGV`，因此
不能用该结果判断真机 Electron 是否可以启动。

## 已知依赖问题

- npm 的 `--cpu=loong64 --os=linux` 仍可能安装宿主 x64 的 Koffi 可选包。
  打包脚本会删除所有该作用域的已解析原生包，并按 lockfile integrity 手工
  安装 LoongArch 包。
- `@napi-rs/canvas` 没有发布 LoongArch 原生包。基础 NAPI-RS 探针通过只说明
  Rust addon 工具链可用，不代表 Skia/Canvas 已完成移植。
- Koffi 没有 LoongArch musl binding，因此当前不能满足 GoodBuddy Agent 的
  双 glibc/musl 产物契约。
- 预览 Electron 比正式 GoodBuddy 低一个主版本。正式支持必须先获得与当前
  Electron 基线一致、可重复构建并完成安全维护的 LoongArch shell。
