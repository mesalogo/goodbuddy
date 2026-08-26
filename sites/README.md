# GoodBuddy 静态官网

`sites` 是无需构建步骤或额外依赖的中英文静态官网源码，可直接托管整个目录。

正式站点地址：<https://mesalogo.github.io/goodbuddy/>

首页将 GoodBuddy 定位为“首个全面覆盖国产化 CPU 架构的开源桌面 AI 助理产品”和
“免注册、支持信创软硬件的一站式 AI 助手”，优先展示三大桌面系统、正式
x64 / arm64 下载入口、独立编译的龙芯 loong64 预览版、统一 Agent Runtime，
以及知识库、魔法笔记、智能心跳、桌面上下文和远程消息通道等桌面助手能力。
下载区位于主要功能说明之前，并明确列出统信 UOS、银河麒麟、海光、兆芯、
鲲鹏、飞腾和龙芯。页面不重复设置底部下载推广区。
英文页面位于 `en.html`，不展示信创适配文案，三个平台的下载按钮始终前往
GitHub 最新正式 Release。
首屏产品界面默认正面展示，在精确指针设备上使用克制的 3D 倾斜、
柔和跟随光效和同步浮动标签；触屏设备保持静态布局，系统启用“减少动态
效果”时不运行该交互。

## 部署

`.github/workflows/pages.yml` 会在 `main` 分支中的官网文件发生变化后，
校验并部署整个 `sites` 目录。工作流也支持在 GitHub Actions 中手动运行。

首次部署前，需要在 GitHub 仓库的 **Settings > Pages** 中将 **Source**
设为 **GitHub Actions**。站点使用项目 Pages 地址，不需要 `CNAME` 文件
或自定义域名 DNS 配置。

## 语言选择

首次访问时，`language.js` 使用浏览器的第一首选语言选择页面：中文语言进入
中文首页，其他语言进入英文页。页头的语言按钮允许手动切换，并将选择保存在
浏览器本地；之后访问优先使用手动选择。两个页面都声明 canonical 与
`hreflang` alternate 地址。手动切换语言会保留当前 URL 片段，例如从下载区
切换后仍停留在 `#download`。

## 本地预览

在仓库根目录运行：

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory sites
```

然后访问 <http://localhost:4173/>。也可以直接用浏览器打开 `sites/index.html`。

## 校验

```powershell
node sites/scripts/validate.mjs
node --check sites/app.js
node --check sites/language.js
node --check sites/release-index.js
node --test sites/scripts/app.test.mjs sites/scripts/release-index.test.mjs
```

校验脚本会检查中英文页面、语言选择、页内链接、本地资源、关键产品文案、
主题与响应式规则，以及中文下载选择器是否从受信任的正式发布索引加载并
保留 GitHub Release 回退入口。它还计算浅色弱文本与控件边框的 WCAG
对比度、检查移动导航和下载控件结构、本地字体及许可证。发布索引测试覆盖
严格 SemVer、六个目标、格式和扩展名、文件大小、SHA-256、唯一文件名及
不可变 URL，并按发布生成器的实际命名绑定版本、平台、架构和格式。移动
导航行为测试同时覆盖现代 MediaQueryList 监听与旧版 Safari 的 `addListener`
回退。英文下载入口固定指向 GitHub Release。

## 下载入口

官网正文不写死版本号，页面启动后读取最新正式发布索引。
Windows、macOS 和 Linux 下载卡片分别提供处理器架构与安装包类型选择器，
选择后直接下载经过发布校验的不可变版本对象。发布索引请求失败、
过大、发生重定向、格式无效或任一字段返回非受信任的官方下载地址时，
整组按钮会以 fail-closed 方式继续指向 GitHub 最新正式 Release，不会混用
部分 OSS 数据：

```text
https://github.com/mesalogo/goodbuddy/releases/latest
```

校验规则与桌面更新检查保持一致：索引只能指向稳定 SemVer 版本，必须恰好
包含 Windows、macOS、Linux 的 x64 / arm64 六个匹配目标；每个目标必须提供
准确的两种格式和扩展名、正的安全整数大小、64 字符小写十六进制 SHA-256、
全局唯一文件名，以及位于
`https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/v${version}/`
下、对文件名进行 URL 编码的精确地址。校验清单和 GitHub 回退地址也必须
完全匹配，所有地址都不得包含凭据、端口、查询参数或片段。

安装包文件名必须与发布生成器完全一致：Windows 使用
`GoodBuddy-${version}-windows-${arch}-setup.exe` 与
`GoodBuddy-${version}-windows-${arch}-portable.zip`；macOS 使用
`GoodBuddy-${version}-mac-${arch}.dmg|zip`；Linux x64 的 AppImage、DEB 与
RPM 分别使用 electron-builder 的 `x86_64`、`amd64` 与 `x86_64` 架构名。
Linux arm64 的 AppImage/DEB 使用 `arm64`，RPM 使用 `aarch64`。
Linux 处理器选择器另外提供龙芯 `loong64` 实验预览；选中后安装包类型固定为
DEB，并改用下述独立预览索引，不会把 `loong64` 注入正式六目标索引。

### 龙芯实验预览通道

龙芯包不加入上述正式索引，而使用独立 OSS 前缀：

```text
releases/
└── loongarch-preview/
    ├── latest.json
    └── v<GoodBuddy 版本>/
        ├── GoodBuddy-<版本>-linux-loong64-preview.deb
        ├── preview-manifest.json
        └── SHA256SUMS
```

版本目录不可变。先上传并公开验证三个版本对象，最后才覆盖
`releases/loongarch-preview/latest.json`；不得把预览包放入 `releases/v*`、
`releases/latest.json`、标准 GitHub Release 资产或桌面自动更新索引。
版本对象建议使用 OSS Standard 存储、继承 Bucket 的公开读取策略，并设置长期
immutable 缓存；`latest.json` 应使用 `application/json` 和短缓存或
`no-cache`。`SHA256SUMS` 必须只记录 DEB 文件名，不得记录构建容器绝对路径。

官网只读取以下严格结构，且仅接受北京 OSS
`releases/loongarch-preview/v<goodBuddyVersion>/` 下的精确 HTTPS 地址：

```json
{
  "formatVersion": 1,
  "product": "GoodBuddy LoongArch Preview",
  "goodBuddyVersion": "0.11.5",
  "previewVersion": "0.11.5-loong64-preview.1",
  "architecture": "loong64",
  "format": "deb",
  "artifact": {
    "name": "GoodBuddy-0.11.5-linux-loong64-preview.deb",
    "size": 186853872,
    "sha256": "672321e314fbdb91c6d7b2b549a838e556bd7e597746a3e6d346b936f2ff8369",
    "url": "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/loongarch-preview/v0.11.5/GoodBuddy-0.11.5-linux-loong64-preview.deb"
  },
  "manifestUrl": "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/loongarch-preview/v0.11.5/preview-manifest.json",
  "checksumUrl": "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/loongarch-preview/v0.11.5/SHA256SUMS"
}
```

上传仍应使用 GitHub OIDC 获取的短期 STS 凭据和固定 `ossutil 2.3.0`，Bucket
为 `goodbuddy`，Endpoint 为 `https://oss-cn-beijing.aliyuncs.com`，Region
为 `cn-beijing`。上传版本对象前先读取目标对象元数据：不存在时才上传，已存在
且大小和 SHA-256 相同时跳过，任一字节不同时必须停止；`--update` 只用于传输
优化，不能代替不可变性检查。也可为版本前缀启用 OSS 保留策略/WORM。指针仅在
所有公开 GET、大小、SHA-256、manifest 和 DEB 元数据检查通过后使用
`--force` 更新。手工上传时也应遵循同一顺序，不使用长期 AccessKey。

若独立索引不存在、超时、过大、字段多缺、版本不稳定、摘要格式错误或任一
URL 不匹配受信任前缀，中文官网选择龙芯处理器时会保持下载按钮禁用；Linux
x64 / arm64 及另外两个正式平台入口不受影响。英文页面继续只展示正式
GitHub Release。

## 字体与可访问性

站点随包提供约 48 KB 的 Inter Variable Latin 子集，不发起远程字体请求。
拉丁字符优先使用该字体；中文依次使用系统提供的苹方、微软雅黑 UI、
Noto Sans CJK SC 或思源黑体，并保留 `system-ui` 与无衬线回退。Inter 的
SIL OFL 1.1 许可证位于 `assets/fonts/inter-OFL.txt`。

浅色主题的弱文本达到 WCAG AA 正文对比度，控件边框达到至少 3:1；
站点也支持系统强制颜色与减少动态效果模式。动态替换下载链接时会保留
“在新窗口打开”的屏幕阅读器说明。移动导航打开后会暂时将页头外内容设为
`inert` 并聚焦第一个导航项；关闭时安全恢复原有 `inert` 状态和菜单按钮
焦点，切换回桌面宽度也会解除隔离。媒体查询监听兼容现代浏览器和使用
`MediaQueryList.addListener` 的旧版 Safari。

## 文件

- `index.html`：页面结构与简体中文内容
- `en.html`：不包含信创适配文案的英文页面
- `styles.css`：语义令牌、浅深主题、焦点与响应式布局
- `app.js`：主题、移动导航、当前章节和中文下载索引
- `language.js`：浏览器语言自动选择与手动语言偏好
- `release-index.js`：中文下载索引的严格、整页 fail-closed 校验
- `assets/goodbuddy-light.png`、`assets/goodbuddy-dark.png`：由 `npm run icons` 与桌面应用同步生成的官方品牌图标
- `assets/linux-plain.svg`：Devicon v2.17.0 提供的黑白 Linux 图标，许可见 `assets/devicon-LICENSE`
- `assets/fonts/inter-latin-variable.woff2`、`assets/fonts/inter-OFL.txt`：本地 Inter Variable Latin 子集及许可证
- `scripts/validate.mjs`：无依赖静态与对比度检查
- `scripts/app.test.mjs`：移动导航、焦点、内容隔离和媒体查询兼容性回归测试
- `scripts/release-index.test.mjs`：发布索引行为回归测试
