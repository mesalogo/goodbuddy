# GoodBuddy Logo

品牌源图为本目录中的 `g-logo-*.png`。在仓库根目录运行 `npm run icons`，同步生成桌面应用、安装包和官网所用的 16 个 PNG／ICO 文件。

| 源图 | 用途 |
| --- | --- |
| `g-logo-light.png` | 亮色界面、官网、README，以及 macOS／Linux 应用图标；生成时添加圆角透明边缘 |
| `g-logo-dark.png` | 暗色界面、官网和暗色图标资源；生成时添加圆角透明边缘 |
| `g-logo-light-transparent.png` | Windows 浅色任务栏和系统托盘，以及应用、快捷方式的静态图标 |
| `g-logo-dark-transparent.png` | Windows 深色任务栏和系统托盘，使用浅蓝紫色 G 保持对比度 |

输出位置：`build/icon*.png`、`build/icon*.ico`、`src/renderer/src/assets/goodbuddy-*.png`、`sites/assets/goodbuddy-*.png`。现有资源文件名保持稳定，界面随亮／暗主题切换对应图片。用户自行设置的品牌 Logo 仍由品牌设置管理。

Windows 运行中的窗口与托盘读取 Electron `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`，并监听 `updated` 事件即时切换。该值对应 Windows 系统界面主题，独立于应用内容主题；窗口关闭、应用退出时移除监听。EXE、安装器和未运行的固定快捷方式属于静态图标，不随运行时主题切换。

`build/generate-icons.mjs` 是唯一生成实现；`icons/tools/make_icons.py` 调用同一脚本。修改源图后应重新生成并一并提交输出资源。
